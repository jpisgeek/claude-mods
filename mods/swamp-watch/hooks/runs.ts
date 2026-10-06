import type { Run, Snapshot } from '../types'

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
 * A failed swamp run in JSON mode writes `{ error, hint? }` to stderr; anything
 * else falls back to its first line of text.
 */
export function errorText(stderr: string, exitCode: number): string {
  try {
    const doc = JSON.parse(stderr) as { error?: unknown; hint?: unknown }
    if (typeof doc.error === 'string') {
      return firstLine(typeof doc.hint === 'string' ? `${doc.error} (${doc.hint})` : doc.error)
    }
  } catch {
    // not JSON: fall through to plain text
  }
  const line = firstLine(stderr.replace(/\u001b\[[0-9;]*m/g, ''))

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

/**
 * The status line: latest run per workflow, failures named first.
 * Undefined outside a swamp repo, so the line disappears.
 */
export function statusLine(snap: Snapshot, now: number): string | undefined {
  if (snap.repoDir === null) return undefined
  if (snap.runs.length === 0) {
    return snap.error === null ? 'swamp · no workflow runs yet' : `swamp · ${snap.error}`
  }
  const latest = latestPerWorkflow(snap.runs)
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
  if (snap.error !== null) parts.push('stale: last refresh failed')

  return `swamp ${parts.join(' · ')}`
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

/** The prompt the Diagnose button sends: read-only investigation first. */
export function diagnosePrompt(run: Run): string {
  const step = run.failedStep ? `, step \`${run.failedStep}\`` : ''

  return [
    `The swamp workflow \`${run.workflowName}\` failed (run ${run.runId}${step}).`,
    `Inspect \`swamp report get @swamp/workflow-summary --workflow ${run.workflowName} --json\``,
    `and \`swamp workflow history logs ${run.runId}\`, then explain the cause and the fix.`,
    'Read only: do not change definitions or re-run anything until I say so.',
  ].join(' ')
}
