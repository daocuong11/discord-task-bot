import { describe, it, expect, vi, afterEach } from 'vitest';
import { createShutdown } from '../src/shutdown';

function fakes() {
  const order: string[] = [];
  const taskBot = { destroy: vi.fn(async () => void order.push('taskBot')) };
  const roost = { destroy: vi.fn(async () => void order.push('roost')) };
  const db = { close: vi.fn(() => void order.push('db')) };
  const exit = vi.fn((code: number) => void order.push(`exit ${code}`));
  const log = vi.fn();
  return { order, taskBot, roost, db, exit, log };
}

describe('createShutdown', () => {
  it('closes both clients, then the database, then exits 0', async () => {
    const f = fakes();
    const shutdown = createShutdown({ clients: [f.taskBot, f.roost], db: f.db, exit: f.exit, log: f.log });

    await shutdown('SIGTERM');

    expect(f.order).toEqual(['taskBot', 'roost', 'db', 'exit 0']);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('SIGTERM'));
  });

  it('runs only once when a second signal arrives during shutdown', async () => {
    const f = fakes();
    const shutdown = createShutdown({ clients: [f.taskBot, f.roost], db: f.db, exit: f.exit, log: f.log });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(f.db.close).toHaveBeenCalledOnce();
    expect(f.exit).toHaveBeenCalledOnce();
  });

  it('still closes the database when a client fails to close, and exits 1', async () => {
    const f = fakes();
    const failure = new Error('gateway already gone');
    f.roost.destroy.mockRejectedValueOnce(failure);
    const shutdown = createShutdown({ clients: [f.taskBot, f.roost], db: f.db, exit: f.exit, log: f.log });

    await shutdown('SIGTERM');

    expect(f.db.close).toHaveBeenCalledOnce();
    expect(f.exit).toHaveBeenCalledWith(1);
    expect(f.log).toHaveBeenCalledWith(expect.any(String), failure);
  });

  describe('timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('exits 1 when a client never finishes closing', async () => {
      vi.useFakeTimers();
      const f = fakes();
      f.roost.destroy.mockReturnValueOnce(new Promise(() => {})); // hangs forever
      const shutdown = createShutdown({
        clients: [f.taskBot, f.roost],
        db: f.db,
        exit: f.exit,
        log: f.log,
        timeoutMs: 5000,
      });

      void shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(4999);
      expect(f.exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(f.exit).toHaveBeenCalledOnce();
      expect(f.exit).toHaveBeenCalledWith(1);
      expect(f.log).toHaveBeenCalledWith(expect.stringContaining('5000'));
    });

    it('does not fire after a shutdown that finished in time', async () => {
      vi.useFakeTimers();
      const f = fakes();
      const shutdown = createShutdown({
        clients: [f.taskBot],
        db: f.db,
        exit: f.exit,
        log: f.log,
        timeoutMs: 5000,
      });

      await shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(10_000);

      expect(f.exit).toHaveBeenCalledOnce();
      expect(f.exit).toHaveBeenCalledWith(0);
    });
  });

  it('exits 1 when the database fails to close', async () => {
    const f = fakes();
    f.db.close.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const shutdown = createShutdown({ clients: [f.taskBot], db: f.db, exit: f.exit, log: f.log });

    await shutdown('SIGTERM');

    expect(f.exit).toHaveBeenCalledWith(1);
  });
});
