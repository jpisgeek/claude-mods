/** One top-level workflow run, as `swamp workflow run search --json` reports it. */
export type Run = {
  runId: string
  workflowName: string
  /** pending, running, succeeded, failed, cancelled or suspended */
  status: string
  startedAt?: string
  /** milliseconds, once the run has completed */
  duration?: number
  failedStep?: string
  failureReason?: string
  stepProgress?: { completed: number; total: number }
  triggerSource?: string
  /** suspended with every gate decided: it needs a `swamp workflow resume` */
  awaitingResume: boolean
}

/** Where runs are read from: the local repo, or a `swamp serve` server. */
export type Source = {
  kind: 'repo' | 'server'
  /** the repo directory, or the server URL */
  target: string
}

/** One source's runs at its last read. */
export type SourceSnapshot = Source & {
  /** newest first; kept from the last good read when a refresh fails */
  runs: Run[]
  checkedAt: number | null
  error: string | null
  isRefreshing: boolean
}

export type Snapshot = {
  /** the swamp repo at or above the session's directory, then the configured server; empty when neither */
  sources: SourceSnapshot[]
}

declare module 'claude-code' {
  interface PluginState {
    'swamp-watch': { sources: Snapshot }
  }
}
