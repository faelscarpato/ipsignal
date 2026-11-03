/**
 * Executor de testes com CONCORRÊNCIA LIMITADA + cancelamento + progresso.
 * Genérico (não depende de hls.js) para ser testável em Node com tarefas fake.
 */

export interface PoolTask<T> {
  id: string;
  run: (signal: AbortSignal) => Promise<T>;
}

export interface PoolProgress {
  done: number;
  total: number;
  activeIds: string[];
}

export interface PoolOutcome<T> {
  results: Map<string, { ok: true; value: T } | { ok: false; cancelled: boolean }>;
  done: number;
  cancelled: boolean;
}

export async function runPool<T>(
  tasks: PoolTask<T>[],
  opts: {
    concurrency: number;
    signal?: AbortSignal;
    onProgress?: (p: PoolProgress) => void;
    onTaskResult?: (id: string, outcome: { ok: true; value: T } | { ok: false; cancelled: boolean }) => void;
  },
): Promise<PoolOutcome<T>> {
  const concurrency = Math.max(1, Math.min(8, opts.concurrency));
  const results = new Map<string, { ok: true; value: T } | { ok: false; cancelled: boolean }>();
  const active = new Set<string>();
  const controllers = new Map<string, AbortController>();
  let cursor = 0;
  let done = 0;
  let cancelled = opts.signal?.aborted ?? false;

  const cancelAll = () => {
    cancelled = true;
    for (const c of controllers.values()) c.abort();
  };
  const onAbort = cancelAll;
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const emit = (total: number) =>
    opts.onProgress?.({ done, total, activeIds: [...active] });

  const total = tasks.length;
  emit(total);

  const worker = async () => {
    while (cursor < tasks.length) {
      if (cancelled) {
        // marca o restante como cancelado sem executar
        while (cursor < tasks.length) {
          const t = tasks[cursor++];
          results.set(t.id, { ok: false, cancelled: true });
          done++;
        }
        emit(total);
        return;
      }
      const task = tasks[cursor++];
      const ctl = new AbortController();
      controllers.set(task.id, ctl);
      if (cancelled) {
        results.set(task.id, { ok: false, cancelled: true });
        done++;
        continue;
      }
      active.add(task.id);
      emit(total);
      try {
        const value = await task.run(ctl.signal);
        results.set(task.id, { ok: true, value });
        opts.onTaskResult?.(task.id, results.get(task.id)!);
      } catch (err) {
        const isAbort = ctl.signal.aborted || (err as Error)?.name === "AbortError";
        results.set(task.id, { ok: false, cancelled: isAbort });
        opts.onTaskResult?.(task.id, results.get(task.id)!);
      } finally {
        controllers.delete(task.id);
        active.delete(task.id);
        done++;
        emit(total);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  opts.signal?.removeEventListener("abort", onAbort);
  return { results, done, cancelled };
}
