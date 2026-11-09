import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookgresValidationError } from "../src/index.js";
import { type Receiver, startReceiver, useHookgres } from "./helpers.js";

const ctx = useHookgres();
let receiver: Receiver;

beforeEach(async () => {
  receiver = await startReceiver();
});
afterEach(async () => {
  await receiver.close();
});

async function queue(
  hw: ReturnType<typeof ctx.create>,
  url: string,
  count: number,
) {
  await hw.createEndpoint({ tenantId: "acme", url });
  for (let i = 0; i < count; i++) {
    await hw.send({ tenantId: "acme", eventType: "a.b", payload: { i } });
  }
}

async function statuses(): Promise<Record<string, number>> {
  const { rows } = await ctx.pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM "${ctx.schema}".deliveries GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

describe("drain", () => {
  it("runs batches until nothing is due and returns the total", async () => {
    const hw = ctx.create({ concurrency: 2 });
    await queue(hw, receiver.url, 5);
    expect(await hw.drain({ timeoutMs: 10_000 })).toBe(5);
    expect(receiver.requests).toHaveLength(5);
    expect(await statuses()).toEqual({ succeeded: 5 });
    expect(await hw.drain({ timeoutMs: 10_000 })).toBe(0);
  });

  it("rejects a timeout too short for one batch", async () => {
    const hw = ctx.create({ requestTimeoutMs: 2000 });
    await queue(hw, receiver.url, 1);
    for (const timeoutMs of [2999, 0, Number.NaN, -1]) {
      const error = await hw.drain({ timeoutMs }).catch((e) => e);
      expect(error).toBeInstanceOf(HookgresValidationError);
      expect(error.message).toMatch(
        /^drain\(\) timeoutMs must be at least requestTimeoutMs \+ 1s \(3000ms\)/,
      );
    }
    expect(receiver.requests).toHaveLength(0);
    expect(await hw.drain({ timeoutMs: 3000 })).toBe(1);
  });

  it("doesn't start a batch that could outlast the timeout", async () => {
    // Every request hangs until requestTimeoutMs aborts it.
    const hw = ctx.create({
      concurrency: 1,
      requestTimeoutMs: 300,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    await queue(hw, "https://example.com/hook", 10);
    const started = Date.now();
    const processed = await hw.drain({ timeoutMs: 2000 });
    const elapsed = Date.now() - started;
    // Each batch takes ~300ms and needs 1300ms left to start.
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThan(2000 - 1300 - 100);
    expect(processed).toBeGreaterThanOrEqual(2);
    expect(processed).toBeLessThan(10);
  });

  it("budgets for the slowest batch so far", async () => {
    // A fetch that ignores the abort signal makes a batch outlast
    // requestTimeoutMs: 2s instead of 0.3s.
    const hw = ctx.create({
      concurrency: 1,
      requestTimeoutMs: 300,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return new Response("ok");
      },
    });
    await queue(hw, "https://example.com/hook", 3);
    const started = Date.now();
    // After the first batch (~2s), 1.8s are left: enough for the 1.3s
    // minimum, but not for another 2s batch.
    expect(await hw.drain({ timeoutMs: 3800 })).toBe(1);
    expect(Date.now() - started).toBeLessThan(3800);
  });
});
