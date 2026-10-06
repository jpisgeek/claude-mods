import type { Run, Source, SourceSnapshot } from '../types'

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Parses `swamp workflow run search --json`: one `{ query, results }` document,
 * newest first. Nested runs are dropped; their parent's status carries them.
 */
export function parseRuns(stdout: string): Run[] {
  const doc = JSON.parse(stdout) as { results?: unknown }
  if (!Array.isArray(doc.results)) {
    throw new Error('swamp printed no results array')
  }

  return doc.results.flatMap((item): Run[] => {
    const r = (item ?? {}) as Record<string, unknown>
    if (typeof r.runId !== 'string' || typeof r.workflowName !== 'string' || typeof r.status !== 'string') {
      return []
    }
    if (r.parentRun) {
      return []
    }
    const progress = r.stepProgress as { completed?: unknown; total?: unknown } | undefined
    const completed = num(progress?.completed)
    const total = num(progress?.total)

    return [
      {
        runId: r.runId,
        workflowName: r.workflowName,
        status: r.status,
        startedAt: str(r.startedAt),
        duration: num(r.duration),
        failedStep: str(r.failedStep),
        failureReason: str(r.failureReason),
        stepProgress: completed !== undefined && total !== undefined ? { completed, total } : undefined,
        triggerSource: str(r.triggerSource),
        awaitingResume: r.awaitingResume === true,
      },
    ]
  })
}

/**
 * A failed swamp run in JSON mode writes `{ error, hint? }` to stderr, after a
 * `Remote <url>` banner when it ran through a server; anything else falls back
 * to its first line of text.
 */
export function errorText(stderr: string, exitCode: number): string {
  const plain = stderr.replace(/\u001b\[[0-9;]*m/g, '')
  const start = plain.search(/^\s*\{/m)
  if (start >= 0) {
    try {
      const doc = JSON.parse(plain.slice(start)) as { error?: unknown; hint?: unknown }
      if (typeof doc.error === 'string') {
        return firstLine(typeof doc.hint === 'string' ? `${doc.error} (${doc.hint})` : doc.error)
      }
    } catch {
      // not JSON: fall through to plain text
    }
  }
  const line = firstLine(plain)

  return line || `swamp exited ${exitCode}`
}

function firstLine(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''

  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}

/** Each workflow's newest run, newest workflow first (runs arrive newest first). */
export function latestPerWorkflow(runs: readonly Run[]): Run[] {
  const seen = new Set<string>()

  return runs.filter(run => !seen.has(run.workflowName) && seen.add(run.workflowName))
}

export type Kind = 'ok' | 'failed' | 'active' | 'waiting' | 'other'

export function kindOf(run: Run): Kind {
  if (run.awaitingResume || run.status === 'suspended') return 'waiting'
  if (run.status === 'succeeded') return 'ok'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'running' || run.status === 'pending') return 'active'

  return 'other'
}

export const ICON: Record<Kind, string> = { ok: '✓', failed: '✗', active: '●', waiting: '◐', other: '–' }
export const COLOR: Record<Kind, string> = {
  ok: 'success',
  failed: 'error',
  active: 'warning',
  waiting: 'permission',
  other: 'inactive',
}

export function ago(iso: string | undefined, now: number): string {
  const at = iso === undefined ? NaN : Date.parse(iso)
  if (Number.isNaN(at)) return 'not started'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`

  return `${Math.floor(s / 86400)}d ago`
}

export function took(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)

  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** One source's part of the status line: latest run per workflow, failures named first. */
function summary(source: SourceSnapshot, now: number): string {
  if (source.runs.length === 0) {
    return source.error === null ? 'no workflow runs yet' : source.error
  }
  const latest = latestPerWorkflow(source.runs)
  const count = (kind: Kind) => latest.filter(run => kindOf(run) === kind)
  const failed = count('failed')
  const parts: string[] = []
  if (failed.length > 0) {
    const named = failed.slice(0, 2).map(run => run.workflowName).join(', ')
    const more = failed.length > 2 ? ` +${failed.length - 2}` : ''
    parts.push(`✗ ${failed.length} failed: ${named}${more} (${ago(failed[0]?.startedAt, now)})`)
  }
  const waiting = count('waiting').length
  if (waiting > 0) parts.push(`◐ ${waiting} waiting`)
  const active = count('active').length
  if (active > 0) parts.push(`● ${active} running`)
  const ok = count('ok').length
  if (ok > 0) parts.push(`✓ ${ok} ok`)
  if (source.error !== null) parts.push('stale: last refresh failed')

  return parts.join(' · ')
}

/**
 * The status line. A lone local repo reads `swamp ✓ 4 ok`; with a server each
 * source is named. Undefined with no source, so the line disappears.
 */
export function statusLine(sources: readonly SourceSnapshot[], now: number): string | undefined {
  const [only] = sources
  if (only === undefined) return undefined
  if (sources.length === 1 && only.kind === 'repo') {
    return only.runs.length === 0 ? `swamp · ${summary(only, now)}` : `swamp ${summary(only, now)}`
  }

  return `swamp ${sources.map(source => `${label(source)} ${summary(source, now)}`).join(' │ ')}`
}

export type Change = { kind: 'failed' | 'recovered'; run: Run }

/**
 * What changed between two reads of each workflow's latest run. Nothing on the
 * first read (`before` null): the status line already shows standing state.
 */
export function changes(before: readonly Run[] | null, after: readonly Run[]): Change[] {
  if (before === null) return []
  const prior = new Map(before.map(run => [run.workflowName, run]))

  return after.flatMap((run): Change[] => {
    const prev = prior.get(run.workflowName)
    if (run.status === 'failed' && !(prev?.runId === run.runId && prev.status === 'failed')) {
      return [{ kind: 'failed', run }]
    }
    if (run.status === 'succeeded' && prev?.status === 'failed') {
      return [{ kind: 'recovered', run }]
    }

    return []
  })
}

/** The swamp repo at or above `cwd`: the nearest directory holding `.swamp.yaml`. */
export async function findRepo(cwd: string, isFile: (path: string) => Promise<boolean>): Promise<string | null> {
  let dir = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd
  for (;;) {
    if (await isFile(`${dir === '/' ? '' : dir}/.swamp.yaml`)) return dir
    if (dir === '/' || !dir.includes('/')) return null
    const cut = dir.lastIndexOf('/')
    dir = cut <= 0 ? '/' : dir.slice(0, cut)
  }
}

export const basename = (dir: string) => dir.slice(dir.lastIndexOf('/') + 1) || dir

/** A source's short name: the repo's directory name, or `serve`. */
export const label = (source: Source) => (source.kind === 'repo' ? basename(source.target) : 'serve')

/**
 * Why a configured server URL is refused, or null when it is usable: swamp
 * takes ws://, wss://, http:// or https://, and a token never rides in the URL.
 */
export function serverProblem(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'server is not a URL'
  }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol)) {
    return 'server must be a ws://, wss://, http:// or https:// URL'
  }
  if (parsed.username || parsed.password) {
    return 'server URL must not carry credentials; use serverTokenFile or swamp auth server-login'
  }

  return null
}

/** The flags that point a swamp command at a source: none for the local repo. */
export function remoteArgs(source: Source, tokenFile: string): string[] {
  if (source.kind === 'repo') return []

  return ['--server', source.target, ...(tokenFile ? ['--token-file', tokenFile] : [])]
}

/** The command that shows a workflow's latest summary report from its source. */
export function reportCommand(run: Run, source: Source): string {
  const server = source.kind === 'server' ? ` --server ${source.target}` : ''

  return `swamp report get @swamp/workflow-summary --workflow ${run.workflowName}${server} --json`
}

/** The prompt the Diagnose button sends: read-only investigation first. */
export function diagnosePrompt(run: Run, source: Source): string {
  const step = run.failedStep ? `, step \`${run.failedStep}\`` : ''
  const server = source.kind === 'server' ? ` --server ${source.target}` : ''
  const where = source.kind === 'server' ? ` on the swamp serve at ${source.target}` : ''

  return [
    `The swamp workflow \`${run.workflowName}\`${where} failed (run ${run.runId}${step}).`,
    `Inspect \`${reportCommand(run, source)}\``,
    `and \`swamp workflow history logs ${run.runId}${server}\`, then explain the cause and the fix.`,
    'Read only: do not change definitions or re-run anything until I say so.',
  ].join(' ')
}
