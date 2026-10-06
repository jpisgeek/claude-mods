# claude-mods

Claude Code mods: function-hook plugins that add status lines, panes and
guards to a Claude Code session. This repository is a plugin marketplace;
each mod lives under `mods/`.

| Mod | What it does |
| --- | --- |
| [`swamp-watch`](mods/swamp-watch/) | Status line, pane and toasts for [swamp](https://github.com/swamp-club/swamp) workflow runs in the current repo and a `swamp serve` server |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install swamp-watch --marketplace jpisgeek/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.

## swamp-watch

Silent unless the session is inside a swamp repo (a `.swamp.yaml` at or above
the working directory) or a `server` is set. Set `server` to a `swamp serve`
URL (for example `http://127.0.0.1:9090`) and its runs are watched as well,
through `--server`, from any directory. With a server each source is named in
the status line: `swamp lab ✓ 4 ok │ serve ✗ 1 failed: truenas-baseline (2h ago)`.
It shows:

- **Status line**: each workflow's latest run, failures named first.
  `swamp ✗ 1 failed: truenas-baseline (2h ago) · ● 1 running · ✓ 4 ok`
- **Toasts** when a workflow's latest run newly fails, and when it recovers.
- **`/swamp`**: a pane with each workflow's latest run (age, duration, step
  progress), the failing step and reason, the `swamp report get` command to
  dig in, a **Diagnose** button that asks Claude to investigate read-only, and
  the recent run history. `r` refreshes.

It reads `swamp workflow run search --json` from the repo root every
`pollSeconds` (default 120), after any `swamp` command Claude runs, and when
`/swamp` opens. Those background reads set `SWAMP_NO_TELEMETRY`,
`DO_NOT_TRACK` and `SWAMP_NO_UPDATE_CHECK`; your own swamp commands are left
alone. swamp needs a signed-in account; if it refuses, its error shows in the
status line. A server needs a token: sign in once with
`swamp auth server-login --server <url>`, or point `serverTokenFile` at a file
holding it. The token never goes in the URL or in `/config`.

Options, in `/config`:

| Option | Default | |
| --- | --- | --- |
| `swampPath` | `swamp` | The swamp CLI, by path or name on `PATH`. Set it if Claude Code's `PATH` lacks swamp. |
| `pollSeconds` | `120` | Re-read interval; 30 at least. |
| `server` | empty | A `swamp serve` URL (`ws://`, `wss://`, `http://` or `https://`) to watch as well. |
| `serverTokenFile` | empty | File holding the server token; empty uses the `swamp auth server-login` credentials. |

### Developing

```
claude --plugin-dir mods/swamp-watch      # run it from this checkout
claude plugin validate mods/swamp-watch
claude plugin test mods/swamp-watch
```
