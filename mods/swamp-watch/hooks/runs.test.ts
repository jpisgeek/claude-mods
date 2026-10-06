import { describe, expect, test } from 'claude-code/testing'

import type { Run, Snapshot } from '../types'
import { ago, changes, errorText, findRepo, latestPerWorkflow, parseRuns, statusLine, took } from './runs'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()
const run = (over: Partial<Run>): Run => ({
  runId: 'r1',
  workflowName: 'truenas-baseline',
  status: 'succeeded',
  startedAt: at(5),
  awaitingResume: false,
  ...over,
})
const snap = (runs: Run[], over: Partial<Snapshot> = {}): Snapshot => ({
  repoDir: '/lab',
  runs,
  checkedAt: NOW,
  error: null,
  isRefreshing: false,
  ...over,
})

describe('parseRuns', () => {
  test('keeps top-level runs and the fields the pane reads', () => {
    const stdout = JSON.stringify({
      query: '',
      results: [
        {
          runId: 'a',
          workflowId: 'w',
          workflowName: 'nightly',
          status: 'failed',
          startedAt: at(1),
          failedStep: 'discover',
          failureReason: 'tcp connect error',
          stepProgress: { completed: 2, total: 5 },
        },
        { runId: 'b', workflowId: 'x', workflowName: 'child', status: 'running', parentRun: { runId: 'a' } },
        { workflowName: 'no-id', status: 'succeeded' },
      ],
    })
    const runs = parseRuns(stdout)
    expect(runs.length).toBe(1)
    expect(runs[0]?.failedStep).toBe('discover')
    expect(runs[0]?.stepProgress).toEqual({ completed: 2, total: 5 })
  })

  test('refuses output with no results array', () => {
    expect(() => parseRuns('{"query":""}')).toThrow('no results array')
  })
})

describe('errorText', () => {
  test("reads swamp's JSON error and its hint", () => {
    expect(errorText('{"error":"Not signed in","hint":"run swamp auth login"}', 1)).toBe(
      'Not signed in (run swamp auth login)',
    )
  })

  test('falls back to the first plain line, colors stripped', () => {
    expect(errorText('\n\u001b[31mError:\u001b[0m boom\nmore', 1)).toBe('Error: boom')
    expect(errorText('', 3)).toBe('swamp exited 3')
  })
})

describe('summaries', () => {
  test('latest run per workflow, newest first', () => {
    const runs = [run({ runId: '3', workflowName: 'a' }), run({ runId: '2', workflowName: 'b' }), run({ runId: '1', workflowName: 'a' })]
    expect(latestPerWorkflow(runs).map(r => r.runId)).toEqual(['3', '2'])
  })

  test('status line names failures first', () => {
    const line = statusLine(
      snap([
        run({ runId: '4', workflowName: 'truenas-baseline', status: 'failed', startedAt: at(120) }),
        run({ runId: '3', workflowName: 'netdata-sweep' }),
        run({ runId: '2', workflowName: 'nightly', status: 'running' }),
        run({ runId: '1', workflowName: 'approve-me', status: 'suspended' }),
      ]),
      NOW,
    )
    expect(line).toBe('swamp ✗ 1 failed: truenas-baseline (2h ago) · ◐ 1 waiting · ● 1 running · ✓ 1 ok')
  })

  test('status line is empty outside a repo and says when it is stale', () => {
    expect(statusLine(snap([], { repoDir: null }), NOW)).toBe(undefined)
    expect(statusLine(snap([], { error: 'Not signed in' }), NOW)).toBe('swamp · Not signed in')
    expect(statusLine(snap([run({})], { error: 'x' }), NOW)).toBe('swamp ✓ 1 ok · stale: last refresh failed')
  })

  test('times', () => {
    expect(ago(at(0), NOW)).toBe('just now')
    expect(ago(at(90), NOW)).toBe('1h ago')
    expect(ago(undefined, NOW)).toBe('not started')
    expect(took(4100)).toBe('4.1s')
    expect(took(125_000)).toBe('2m 05s')
  })
})

describe('changes', () => {
  test('nothing on the first read', () => {
    expect(changes(null, [run({ status: 'failed' })])).toEqual([])
  })

  test('a new failure once, then a recovery', () => {
    const ok = [run({ runId: '1' })]
    const failed = [run({ runId: '2', status: 'failed' })]
    expect(changes(ok, failed).map(c => c.kind)).toEqual(['failed'])
    expect(changes(failed, failed)).toEqual([])
    expect(changes(failed, [run({ runId: '3' })]).map(c => c.kind)).toEqual(['recovered'])
  })

  test('a running run that ends failed counts', () => {
    const running = [run({ runId: '2', status: 'running' })]
    expect(changes(running, [run({ runId: '2', status: 'failed' })]).map(c => c.kind)).toEqual(['failed'])
  })
})

describe('findRepo', () => {
  const marker = (dir: string) => async (path: string) => path === `${dir}/.swamp.yaml`

  test('walks up to the nearest .swamp.yaml', async () => {
    expect(await findRepo('/home/j/lab/models/truenas', marker('/home/j/lab'))).toBe('/home/j/lab')
    expect(await findRepo('/home/j/lab/', marker('/home/j/lab'))).toBe('/home/j/lab')
  })

  test('null when there is none', async () => {
    expect(await findRepo('/home/j/other', marker('/home/j/lab'))).toBe(null)
  })
})
