import { describe, expect, it } from "vitest";
import { isFailureState } from "./status";
import { runPool, type PoolTask } from "./runner";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runPool — concorrência, progresso e cancelamento", () => {
  it("nunca excede o limite de concorrência", async () => {
    let active = 0;
    let maxActive = 0;
    const tasks: PoolTask<string>[] = Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`,
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
        active--;
        return `ok-${i}`;
      },
    }));
    const progress: number[] = [];
    const out = await runPool(tasks, {
      concurrency: 3,
      onProgress: (p) => progress.push(p.done),
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(out.done).toBe(12);
    expect(progress[progress.length - 1]).toBe(12);
    expect(out.results.get("t7")).toEqual({ ok: true, value: "ok-7" });
  });

  it("cancelamento aborta tarefas ativas e não inicia novas", async () => {
    const d1 = deferred<string>();
    const started: string[] = [];
    const ctl = new AbortController();
    const tasks: PoolTask<string>[] = [
      { id: "a", run: () => d1.promise },
      {
        id: "b",
        run: async (signal) => {
          started.push("b");
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          return "b-done";
        },
      },
      { id: "c", run: async () => "c-done" },
    ];
    const promise = runPool(tasks, { concurrency: 1, signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    d1.reject(new DOMException("aborted", "AbortError"));
    const out = await promise;
    expect(out.cancelled).toBe(true);
    expect(started).toEqual([]); // b e c nunca iniciaram
    const b = out.results.get("b");
    const c = out.results.get("c");
    expect(b && !b.ok && b.cancelled).toBe(true);
    expect(c && !c.ok && c.cancelled).toBe(true);
  });

  it("falha de uma tarefa não derruba as demais", async () => {
    const tasks: PoolTask<string>[] = [
      { id: "ok", run: async () => "fine" },
      {
        id: "bad",
        run: async () => {
          throw new Error("boom");
        },
      },
      { id: "ok2", run: async () => "fine2" },
    ];
    const out = await runPool(tasks, { concurrency: 2 });
    expect(out.results.get("ok")).toEqual({ ok: true, value: "fine" });
    const bad = out.results.get("bad")!;
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.cancelled).toBe(false);
    expect(out.results.get("ok2")).toEqual({ ok: true, value: "fine2" });
  });
});

describe("seleção de 'repetir apenas falhas'", () => {
  it("conjunto de estados falhos é explícito e não inclui sucesso/não-testado", () => {
    expect(isFailureState("playing")).toBe(false);
    expect(isFailureState("untested")).toBe(false);
    expect(isFailureState("reachable_unconfirmed")).toBe(false); // não é falha: endpoint respondeu
    for (const s of [
      "import_error",
      "network_error",
      "timeout",
      "blocked_cors",
      "auth_failed",
      "manifest_invalid",
      "codec_unsupported",
      "unavailable",
      "undetermined",
    ] as const) {
      expect(isFailureState(s)).toBe(true);
    }
  });
});
