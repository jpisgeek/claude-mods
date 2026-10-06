import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, Snapshot, Source, SourceSnapshot } from '../types'
import {
  COLOR,
  ICON,
  ago,
  changes,
  diagnosePrompt,
  errorText,
  findRepo,
  kindOf,
  label,
  latestPerWorkflow,
  parseRuns,
  remoteArgs,
  reportCommand,
  serverProblem,
  statusLine,
  took,
} from './runs'

const PANE = 'swamp'
const EMPTY: Snapshot = { sources: [] }
const snapshot = atom({ plugin: 'swamp-watch', key: 'sources' } as const, EMPTY)

// The mod's own polls are background reads: keep them from phoning home.
// The user's own swamp commands are untouched.
const QUIET_ENV = { SWAMP_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', SWAMP_NO_UPDATE_CHECK: '1' }
const SWAMP_COMMAND = /(^|[\s;&|(])swamp\s/

// Module state starts over on reload; the snapshot lives in $.state and stays.
let swamp = 'swamp'
let server = ''
let tokenFile = ''
// Each source's latest run per workflow at its last good read, by source key.
const previous = new Map<string, Run[]>()
let inFlight: Promise<void> | null = null

const keyOf = (source: Source) => `${source.kind}:${source.target}`

/** The local repo at or above the session's directory, then the configured server. */
async function sourcesFor($: EngineInterface, cwd: string): Promise<Source[]> {
  const repoDir = await findRepo(cwd, path =>
    $.fs.stat(path).then(
      s => s.kind === 'file',
      () => false,
    ),
  )
  const sources: Source[] = []
  if (repoDir !== null) sources.push({ kind: 'repo', target: repoDir })
  if (server) sources.push({ kind: 'server', target: server })

  return sources
}

/** One source's runs, or why they could not be read. */
async function readRuns($: EngineInterface, source: Source, cwd: string) {
  if (source.kind === 'server') {
    const problem = serverProblem(source.target)
    if (problem !== null) return { runs: null, error: problem }
  }
  try {
    const ran = await $.process.run(
      [swamp, 'workflow', 'run', 'search', '--json', '--limit', '50', ...remoteArgs(source, tokenFile)],
      { cwd: source.kind === 'repo' ? source.target : cwd, env: QUIET_ENV, timeoutMs: 30_000 },
    )
    if (ran.exitCode !== 0) return { runs: null, error: errorText(ran.stderr, ran.exitCode) }
    try {
      return { runs: parseRuns(ran.stdout), error: null }
    } catch {
      return { runs: null, error: 'unreadable output from swamp workflow run search' }
    }
  } catch {
    return { runs: null, error: `could not run ${swamp}: set swampPath in /config` }
  }
}

async function poll($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const sources = await sourcesFor($, cwd)
  if (sources.length === 0) {
    await update($, snapshot, () => EMPTY)
    $.ui.status(undefined)
    return
  }
  const before = await update($, snapshot, s => ({
    sources: sources.map(source => {
      const prior = s.sources.find(p => keyOf(p) === keyOf(source))

      return { runs: [], checkedAt: null, error: null, ...prior, ...source, isRefreshing: true }
    }),
  }))

  const reads = await Promise.all(sources.map(source => readRuns($, source, cwd)))
  const now = await $.clock.now()
  const after = await update($, snapshot, () => ({
    sources: before.sources.map((source, i): SourceSnapshot => {
      const { runs, error } = reads[i] ?? { runs: null, error: null }

      return { ...source, runs: runs ?? source.runs, checkedAt: now, error, isRefreshing: false }
    }),
  }))

  sources.forEach((source, i) => {
    const runs = reads[i]?.runs
    if (!runs) return
    const latest = latestPerWorkflow(runs)
    const prefix = source.kind === 'server' ? 'swamp serve' : 'swamp'
    for (const change of changes(previous.get(keyOf(source)) ?? null, latest)) {
      const { workflowName, failedStep } = change.run
      $.ui.toast(
        change.kind === 'failed'
          ? `${prefix}: ${workflowName} failed${failedStep ? ` at ${failedStep}` : ''}. /swamp for details`
          : `${prefix}: ${workflowName} recovered`,
        { timeoutMs: 8000 },
      )
    }
    previous.set(keyOf(source), latest)
  })
  $.ui.status(statusLine(after.sources, now))
}

// One read at a time; callers arriving mid-read share it.
function refresh($: EngineInterface): Promise<void> {
  inFlight ??= poll($).finally(() => {
    inFlight = null
  })
  return inFlight
}

// Off the calling dispatch, so a tool result or session start never waits on swamp.
function refreshSoon($: EngineInterface): void {
  $.clock.after(1, () => {
    refresh($).catch(() => {})
  })
}

export const register: Register = (on, options) => {
  swamp = String(options.swampPath ?? '') || 'swamp'
  server = String(options.server ?? '').trim()
  tokenFile = String(options.serverTokenFile ?? '').trim()
  const pollMs = Math.max(30, Number(options.pollSeconds) || 120) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'swamp', description: 'Recent swamp workflow runs and failures' })
    refreshSoon($)
    $.clock.every(pollMs, () => {
      refresh($).catch(() => {})
    })

    return next(e)
  })

  // A swamp command Claude ran may have started or finished a run: read again.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (SWAMP_COMMAND.test(e.command)) refreshSoon($)

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'swamp' }, async $ => {
    await refresh($)
    const snap = await read($, snapshot)
    if (snap.sources.length === 0) {
      return { text: 'swamp-watch: no .swamp.yaml at or above this directory, and no server set in /config.' }
    }
    await $.ui.open({ id: PANE, title: `swamp · ${snap.sources.map(label).join(' + ')}` })

    return { text: statusLine(snap.sources, await $.clock.now()) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const now = await $.clock.now()

    if (snap.sources.length === 0) {
      return <Text dimColor>Not in a swamp repo, and no server set in /config.</Text>
    }

    const allRuns = snap.sources.flatMap(source => source.runs)
    const nameWidth = Math.min(28, Math.max(8, ...allRuns.map(run => run.workflowName.length)))
    const row = (run: Run, when: string) => {
      const kind = kindOf(run)
      const steps = run.stepProgress ? `${run.stepProgress.completed}/${run.stepProgress.total} steps` : ''
      const extra = kind === 'active' ? steps : took(run.duration)

      return (
        <Text wrap="truncate">
          <Text color={COLOR[kind]}>{ICON[kind]} </Text>
          {run.workflowName.padEnd(nameWidth)} <Text color={COLOR[kind]}>{run.status.padEnd(10)}</Text>
          <Text dimColor>
            {when.padEnd(12)}
            {extra}
          </Text>
        </Text>
      )
    }
    const fixed = snap.sources.reduce((n, source) => {
      const latest = latestPerWorkflow(source.runs)

      return n + 4 + latest.length + latest.filter(run => kindOf(run) === 'failed').length * 3
    }, 4)
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 24) - fixed) / snap.sources.length))

    const section = (source: SourceSnapshot) => {
      const latest = latestPerWorkflow(source.runs)
      const checked =
        source.checkedAt === null ? 'reading...' : `checked ${ago(new Date(source.checkedAt).toISOString(), now)}`

      return (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-middle">
            {source.kind === 'server' ? `serve ${source.target}` : source.target} ·{' '}
            {source.isRefreshing ? 'refreshing...' : checked}
          </Text>
          {source.error !== null && <Text color="error">refresh failed: {source.error}</Text>}
          {source.runs.length === 0 && source.error === null && <Text dimColor>No workflow runs yet.</Text>}

          {latest.length > 0 && <Text bold>Workflows</Text>}
          {latest.map(run => (
            <Box flexDirection="column">
              {row(run, ago(run.startedAt, now))}
              {kindOf(run) === 'failed' && (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text color="error">
                    {run.failedStep ? `step ${run.failedStep}: ` : ''}
                    {(run.failureReason ?? 'no reason recorded').slice(0, 300)}
                  </Text>
                  <Box>
                    <Text dimColor>{reportCommand(run, source)} </Text>
                    <Button
                      key={`diagnose:${source.kind}:${run.workflowName}`}
                      label="Diagnose"
                      onPress={() => $.prompt.submit({ text: diagnosePrompt(run, source) })}
                    />
                  </Box>
                </Box>
              )}
            </Box>
          ))}

          {source.runs.length > latest.length && <Text bold>Recent runs</Text>}
          {source.runs.length > latest.length &&
            source.runs
              .slice(0, room)
              .map(run => row(run, `${ago(run.startedAt, now)}${run.triggerSource ? ` ${run.triggerSource}` : ''}`))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{snap.sources.map(label).join(' + ')} </Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />
        </Box>
        {snap.sources.map(section)}
      </Box>
    )
  })
}
