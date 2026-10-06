import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const REPO = '/home/j/lab'
const NOW = Date.parse('2026-10-06T12:00:00Z')

const searchOutput = (status: string, runId: string) =>
  JSON.stringify({
    query: '',
    results: [
      {
        runId,
        workflowId: 'w1',
        workflowName: 'truenas-baseline',
        status,
        startedAt: new Date(NOW - 60_000).toISOString(),
        failedStep: status === 'failed' ? 'discover' : undefined,
      },
    ],
  })

/** `/swamp` typed at the prompt. */
const SLASH_SWAMP: CommandRunInput = {
  command: 'swamp',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}

/** The world beneath the mod: a session in a swamp repo and a fake swamp CLI. */
function world(on: On, cwd = `${REPO}/models`) {
  mock.clock(on, { now: NOW })
  const seen = {
    argv: [] as (readonly string[])[],
    env: [] as (Record<string, string> | undefined)[],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    opened: [] as string[],
    reply: { exitCode: 0, stdout: searchOutput('succeeded', 'r1'), stderr: '' },
  }
  on('session.cwd', () => ({ value: cwd }))
  on('fs.stat', (_$, e) =>
    e.path === `${REPO}/.swamp.yaml`
      ? { value: { kind: 'file' as const, size: 120, mtimeMs: 0, isLink: false } }
      : { deny: `ENOENT: ${e.path}` },
  )
  on('process.run', (_$, e) => {
    seen.argv.push(e.argv)
    seen.env.push(e.init?.env)
    return { value: { ...seen.reply, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })

  return seen
}

test('/swamp reads runs quietly from the repo root and opens the pane', async ($, on) => {
  const seen = world(on)
  const { text } = await $.command.run(SLASH_SWAMP)

  expect(seen.argv[0]).toEqual(['swamp', 'workflow', 'run', 'search', '--json', '--limit', '50'])
  expect(seen.env[0]).toEqual({ SWAMP_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', SWAMP_NO_UPDATE_CHECK: '1' })
  expect(seen.opened).toEqual(['swamp'])
  expect(text).toBe('swamp ✓ 1 ok')
  expect(seen.statuses.at(-1)).toBe('swamp ✓ 1 ok')
})

test('a new failure toasts once; the recovery toasts too', async ($, on) => {
  const seen = world(on)
  await $.command.run(SLASH_SWAMP)
  expect(seen.toasts).toEqual([])

  seen.reply.stdout = searchOutput('failed', 'r2')
  await $.command.run(SLASH_SWAMP)
  await $.command.run(SLASH_SWAMP)
  expect(seen.toasts).toEqual(['swamp: truenas-baseline failed at discover. /swamp for details'])
  expect(seen.statuses.at(-1)).toBe('swamp ✗ 1 failed: truenas-baseline (1m ago)')

  seen.reply.stdout = searchOutput('succeeded', 'r3')
  await $.command.run(SLASH_SWAMP)
  expect(seen.toasts.at(-1)).toBe('swamp: truenas-baseline recovered')
})

test("swamp's error reaches the status line and the last good runs stay", async ($, on) => {
  const seen = world(on)
  await $.command.run(SLASH_SWAMP)

  seen.reply = { exitCode: 1, stdout: '', stderr: '{"error":"Not signed in","hint":"run swamp auth login"}' }
  await $.command.run(SLASH_SWAMP)
  expect(seen.statuses.at(-1)).toBe('swamp ✓ 1 ok · stale: last refresh failed')
})

test('outside a swamp repo it stays silent and never runs swamp', async ($, on) => {
  const seen = world(on, '/home/j/elsewhere')
  const { text } = await $.command.run(SLASH_SWAMP)

  expect(seen.argv).toEqual([])
  expect(seen.opened).toEqual([])
  expect(seen.statuses.at(-1)).toBe(undefined)
  expect(text).toBe('swamp-watch: no .swamp.yaml at or above this directory.')
})

test('swampPath is honoured', { options: { swampPath: '/opt/swamp/bin/swamp' } }, async ($, on) => {
  const seen = world(on)
  await $.command.run(SLASH_SWAMP)

  expect(seen.argv[0]?.[0]).toBe('/opt/swamp/bin/swamp')
})

test('the pane draws a failure with its reason and a Diagnose button', async ($, on) => {
  const seen = world(on)
  seen.reply.stdout = searchOutput('failed', 'r2')
  await $.command.run(SLASH_SWAMP)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'swamp-watch',
      surface,
      component: 'Pane',
      requestId: 'swamp',
      props: {
        title: 'swamp · lab',
        isFocused: true,
        bodyColumns: 100,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await ui.find({ text: /step discover: no reason recorded/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'diagnose:truenas-baseline' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
  }
})
