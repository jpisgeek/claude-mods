import { describe, expect, test } from 'claude-code/testing'

import type { Run, SourceSnapshot } from '../types'
import {
  ago,
  changes,
  diagnosePrompt,
  errorText,
  findRepo,
  latestPerWorkflow,
  parseRuns,
  redact,
  serverProblem,
  statusLine,
  took,
} from './runs'

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
const snap = (runs: Run[], over: Partial<SourceSnapshot> = {}): SourceSnapshot => ({
  kind: 'repo',
  target: '/lab',
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

  test('reads the JSON error after the Remote banner a server run prints', () => {
    const stderr = '\u001b[1m\u001b[33m     Remote\u001b[39m\u001b[22m   http://127.0.0.1:9090\n{\n  "error": "Authentication failed"\n}\n'
    expect(errorText(stderr, 1)).toBe('Authentication failed')
  })

  test('masks a server token swamp echoes back', () => {
    const secret = 'ab12'.repeat(16)
    expect(errorText(`{"error":"Invalid header value: \\"Bearer swamp-watch.${secret}\\""}`, 1)).toBe(
      'Invalid header value: "Bearer <redacted>"',
    )
    expect(errorText(`token swamp-watch.${secret} rejected`, 1)).toBe('token swamp-watch.<redacted> rejected')
  })

  test('leaves ordinary text alone', () => {
    expect(redact('run 39b3d1b1-11de-4d9e-b7ae-93d22ff1c8b3 failed at step v1.2')).toBe(
      'run 39b3d1b1-11de-4d9e-b7ae-93d22ff1c8b3 failed at step v1.2',
    )
  })
})

describe('summaries', () => {
  test('latest run per workflow, newest first', () => {
    const runs = [run({ runId: '3', workflowName: 'a' }), run({ runId: '2', workflowName: 'b' }), run({ runId: '1', workflowName: 'a' })]
    expect(latestPerWorkflow(runs).map(r => r.runId)).toEqual(['3', '2'])
  })

  test('status line names failures first', () => {
    const line = statusLine(
      [snap([
        run({ runId: '4', workflowName: 'truenas-baseline', status: 'failed', startedAt: at(120) }),
        run({ runId: '3', workflowName: 'netdata-sweep' }),
        run({ runId: '2', workflowName: 'nightly', status: 'running' }),
        run({ runId: '1', workflowName: 'approve-me', status: 'suspended' }),
      ])],
      NOW,
    )
    expect(line).toBe('swamp ✗ 1 failed: truenas-baseline (2h ago) · ◐ 1 waiting · ● 1 running · ✓ 1 ok')
  })

  test('status line is empty outside a repo and says when it is stale', () => {
    expect(statusLine([], NOW)).toBe(undefined)
    expect(statusLine([snap([], { error: 'Not signed in' })], NOW)).toBe('swamp · Not signed in')
    expect(statusLine([snap([run({})], { error: 'x' })], NOW)).toBe('swamp ✓ 1 ok · stale: last refresh failed')
  })

  test('status line names each source once a server is watched', () => {
    const server = snap([run({ status: 'failed', startedAt: at(120) })], { kind: 'server', target: 'http://127.0.0.1:9090' })
    expect(statusLine([snap([run({})]), server], NOW)).toBe('swamp lab ✓ 1 ok │ serve ✗ 1 failed: truenas-baseline (2h ago)')
    expect(statusLine([snap([], { kind: 'server', target: 'ws://h:9090', error: 'Authentication failed' })], NOW)).toBe(
      'swamp serve Authentication failed',
    )
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

describe('servers', () => {
  test('serverProblem accepts swamp serve URLs and refuses the rest', () => {
    expect(serverProblem('http://127.0.0.1:9090')).toBe(null)
    expect(serverProblem('wss://swamp.example.net')).toBe(null)
    expect(serverProblem('ftp://h')).toBe('server must be a ws://, wss://, http:// or https:// URL')
    expect(serverProblem('not a url')).toBe('server is not a URL')
    expect(serverProblem('https://a:b@h')).toContain('must not carry credentials')
  })

  test('the Diagnose prompt points its commands at the server', () => {
    const prompt = diagnosePrompt(run({ runId: 'r9', status: 'failed' }), { kind: 'server', target: 'http://127.0.0.1:9090' })
    expect(prompt).toContain('--workflow truenas-baseline --server http://127.0.0.1:9090 --json')
    expect(prompt).toContain('swamp workflow history logs r9 --server http://127.0.0.1:9090')
  })
})
