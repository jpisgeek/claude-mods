import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, Snapshot } from '../types'
import {
  COLOR,
  ICON,
  ago,
  basename,
  changes,
  diagnosePrompt,
  errorText,
  findRepo,
  kindOf,
  latestPerWorkflow,
  parseRuns,
  statusLine,
  took,
} from './runs'

const PANE = 'swamp'
const EMPTY: Snapshot = { repoDir: null, runs: [], checkedAt: null, error: null, isRefreshing: false }
const snapshot = atom({ plugin: 'swamp-watch', key: 'snapshot' } as const, EMPTY)

// The mod's own polls are background reads: keep them from phoning home.
// The user's own swamp commands are untouched.
const QUIET_ENV = { SWAMP_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', SWAMP_NO_UPDATE_CHECK: '1' }
const SWAMP_COMMAND = /(^|[\s;&|(])swamp\s/

// Module state starts over on reload; the snapshot lives in $.state and stays.
let swamp = 'swamp'
// Each workflow's latest run at the last good read; null until the first.
let previous: Run[] | null = null
let inFlight: Promise<void> | null = null

async function poll($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const repoDir = await findRepo(cwd, path =>
    $.fs.stat(path).then(
      s => s.kind === 'file',
      () => false,
    ),
  )
  if (repoDir === null) {
    await update($, snapshot, () => EMPTY)
    $.ui.status(undefined)
    return
  }
  const before = await update($, snapshot, s => ({ ...s, repoDir, isRefreshing: true }))

  let runs: Run[] | null = null
  let error: string | null = null
  try {
    const ran = await $.process.run([swamp, 'workflow', 'run', 'search', '--json', '--limit', '50'], {
      cwd: repoDir,
      env: QUIET_ENV,
      timeoutMs: 30_000,
    })
    if (ran.exitCode !== 0) {
      error = errorText(ran.stderr, ran.exitCode)
    } else {
      try {
        runs = parseRuns(ran.stdout)
      } catch {
        error = 'unreadable output from swamp workflow run search'
      }
    }
  } catch {
    error = `could not run ${swamp}: set swampPath in /config`
  }

  const now = await $.clock.now()
  const after = await update($, snapshot, () => ({
    repoDir,
    runs: runs ?? before.runs,
    checkedAt: now,
    error,
    isRefreshing: false,
  }))
  if (runs !== null) {
    const latest = latestPerWorkflow(runs)
    for (const change of changes(previous, latest)) {
      const { workflowName, failedStep } = change.run
      $.ui.toast(
        change.kind === 'failed'
          ? `swamp: ${workflowName} failed${failedStep ? ` at ${failedStep}` : ''}. /swamp for details`
          : `swamp: ${workflowName} recovered`,
        { timeoutMs: 8000 },
      )
    }
    previous = latest
  }
  $.ui.status(statusLine(after, now))
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
    if (snap.repoDir === null) {
      return { text: 'swamp-watch: no .swamp.yaml at or above this directory.' }
    }
    await $.ui.open({ id: PANE, title: `swamp · ${basename(snap.repoDir)}` })

    return { text: statusLine(snap, await $.clock.now()) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const now = await $.clock.now()

    if (snap.repoDir === null) {
      return <Text dimColor>Not in a swamp repo.</Text>
    }

    const latest = latestPerWorkflow(snap.runs)
    const failed = latest.filter(run => kindOf(run) === 'failed')
    const nameWidth = Math.min(28, Math.max(8, ...snap.runs.map(run => run.workflowName.length)))
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
    const checked = snap.checkedAt === null ? 'reading...' : `checked ${ago(new Date(snap.checkedAt).toISOString(), now)}`
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 8 - latest.length - failed.length * 3)

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor wrap="truncate-middle">
            {snap.repoDir} · {snap.isRefreshing ? 'refreshing...' : checked}{' '}
          </Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />
        </Box>
        {snap.error !== null && <Text color="error">refresh failed: {snap.error}</Text>}
        {snap.runs.length === 0 && snap.error === null && <Text dimColor>No workflow runs yet.</Text>}

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
                  <Text dimColor>swamp report get @swamp/workflow-summary --workflow {run.workflowName} --json </Text>
                  <Button
                    key={`diagnose:${run.workflowName}`}
                    label="Diagnose"
                    onPress={() => $.prompt.submit({ text: diagnosePrompt(run) })}
                  />
                </Box>
              </Box>
            )}
          </Box>
        ))}

        {snap.runs.length > latest.length && <Text bold>Recent runs</Text>}
        {snap.runs.length > latest.length &&
          snap.runs
            .slice(0, room)
            .map(run => row(run, `${ago(run.startedAt, now)}${run.triggerSource ? ` ${run.triggerSource}` : ''}`))}
      </Box>
    )
  })
}
