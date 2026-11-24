export interface ShutdownDeps {
  clients: { destroy(): Promise<void> | void }[];
  db: { close(): void };
  exit: (code: number) => void;
  log: (message: string, error?: unknown) => void;
  /**
   * Give up and exit 1 if closing takes longer than this. Keep it well under
   * `drainingSeconds` in railway.json, or Railway's SIGKILL lands first and
   * the stop reads as a crash again.
   */
  timeoutMs?: number;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Build the handler for SIGTERM and SIGINT.
 *
 * Railway sends SIGTERM to the old container on every deploy. Without a
 * handler, Node dies on the signal (exit 143) and Railway reports the stop as
 * a crash. This closes the Discord connections and the SQLite database, then
 * exits 0, so a normal deploy reads as a normal stop.
 *
 * Every step runs even if an earlier one fails, and any failure exits 1. If a
 * step hangs, the timeout exits 1 instead of waiting for SIGKILL.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let started = false;
  let exited = false;

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };

  return async (signal) => {
    if (started) return;
    started = true;

    deps.log(`Received ${signal}, shutting down`);

    const timer = setTimeout(() => {
      deps.log(`Shutdown did not finish within ${timeoutMs} ms, exiting anyway`);
      exitOnce(1);
    }, timeoutMs);
    // The timer alone must not keep the process alive.
    timer.unref?.();

    let failed = false;

    const results = await Promise.allSettled(deps.clients.map(async (client) => client.destroy()));
    for (const result of results) {
      if (result.status === 'rejected') {
        failed = true;
        deps.log('A Discord client failed to close', result.reason);
      }
    }

    try {
      deps.db.close();
    } catch (error) {
      failed = true;
      deps.log('The database failed to close', error);
    }

    clearTimeout(timer);
    exitOnce(failed ? 1 : 0);
  };
}
