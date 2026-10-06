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

export type Snapshot = {
  /** the swamp repo at or above the session's directory; null outside one */
  repoDir: string | null
  /** newest first; kept from the last good read when a refresh fails */
  runs: Run[]
  checkedAt: number | null
  error: string | null
  isRefreshing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'swamp-watch': { snapshot: Snapshot }
  }
}
