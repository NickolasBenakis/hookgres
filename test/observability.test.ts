import * as otel from "@opentelemetry/api";
import {
  type CollectionResult,
  MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HookgresValidationError,
  type OpenTelemetryOptions,
} from "../src/index.js";
import { type Receiver, startReceiver, useHookgres } from "./helpers.js";

const ctx = useHookgres();
let receiver: Receiver;

beforeEach(async () => {
  receiver = await startReceiver();
});
afterEach(async () => {
  await receiver.close();
});

// The real API module must fit the option's type.
const _fits: OpenTelemetryOptions = { api: otel };
void _fits;

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

/** A private meter provider: tests don't touch the global one. */
function meter() {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  const api = {
    metrics: {
      getMeter: (name: string, version?: string) =>
        provider.getMeter(name, version),
    },
  };
  const collect = async () => {
    const { resourceMetrics, errors }: CollectionResult =
      await reader.collect();
    expect(errors).toEqual([]);
    const points = new Map<
      string,
      { attributes: Record<string, unknown>; value: unknown }[]
    >();
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        points.set(
          metric.descriptor.name,
          metric.dataPoints.map((p) => ({
            attributes: p.attributes,
            value: p.value,
          })),
        );
      }
    }
    return points;
  };
  return { api, collect };
}

async function setDue(sql: string) {
  await ctx.pool.query(
    `UPDATE "${ctx.schema}".deliveries SET next_attempt_at = ${sql}`,
  );
}

describe("stats", () => {
  it("reports an empty queue as zeros", async () => {
    const hw = ctx.create();
    expect(await hw.stats()).toEqual({
      pending: 0,
      due: 0,
      delivering: 0,
      oldestDueAt: null,
      lagMs: 0,
    });
  });

  it("counts pending, due and delivering, and measures lag", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    for (let i = 0; i < 3; i++) {
      await hw.send({ tenantId: "acme", eventType: "e", payload: { i } });
    }
    await setDue("now() - interval '90 seconds'");
    // One scheduled for later, one claimed by a worker.
    const { rows } = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM "${ctx.schema}".deliveries ORDER BY id`,
    );
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".deliveries SET next_attempt_at = now() + interval '1 hour' WHERE id = $1`,
      [rows[0]?.id],
    );
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".deliveries SET status = 'delivering', locked_until = now() + interval '1 minute' WHERE id = $1`,
      [rows[1]?.id],
    );
    const stats = await hw.stats();
    expect(stats).toMatchObject({ pending: 2, due: 1, delivering: 1 });
    expect(stats.lagMs).toBeGreaterThanOrEqual(89_000);
    expect(stats.lagMs).toBeLessThan(120_000);
    expect(stats.oldestDueAt).toBeInstanceOf(Date);
    expect(Date.now() - (stats.oldestDueAt?.getTime() ?? 0)).toBeGreaterThan(
      89_000,
    );
  });

  it("narrows to a tenant or an endpoint", async () => {
    const hw = ctx.create();
    const a = await hw.createEndpoint({ tenantId: "a", url: receiver.url });
    const a2 = await hw.createEndpoint({ tenantId: "a", url: receiver.url });
    await hw.createEndpoint({ tenantId: "b", url: receiver.url });
    await hw.send({ tenantId: "a", eventType: "e", payload: {} });
    await hw.send({ tenantId: "b", eventType: "e", payload: {} });
    await hw.send({ tenantId: "b", eventType: "e", payload: {} });
    expect((await hw.stats()).pending).toBe(4);
    expect((await hw.stats({ tenantId: "a" })).pending).toBe(2);
    expect((await hw.stats({ tenantId: "b" })).pending).toBe(2);
    expect((await hw.stats({ endpointId: a.id })).pending).toBe(1);
    expect((await hw.stats({ tenantId: "b", endpointId: a2.id })).pending).toBe(
      0,
    );
    expect((await hw.stats({ tenantId: "nobody" })).pending).toBe(0);
  });

  it("rejects a blank or non-string filter", async () => {
    const hw = ctx.create();
    for (const filter of [
      { tenantId: "" },
      { endpointId: 42 },
      { tenant: "acme" },
      null,
    ]) {
      await expect(
        hw.stats(filter as { tenantId?: string }),
      ).rejects.toBeInstanceOf(HookgresValidationError);
    }
  });
});

describe("OpenTelemetry metrics", () => {
  it("counts attempts by outcome and status, and times them", async () => {
    const { api, collect } = meter();
    const hw = ctx.create({
      retrySchedule: [0],
      opentelemetry: { api, queueMetrics: false },
    });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    // First message: 500 then 200. Second: 500 twice, so it fails.
    receiver.respond = (n) => (n === 2 ? 200 : 500);
    await hw.send({ tenantId: "acme", eventType: "e", payload: { i: 1 } });
    await hw.drain({ timeoutMs: 10_000 });
    receiver.respond = () => 500;
    await hw.send({ tenantId: "acme", eventType: "e", payload: { i: 2 } });
    await hw.drain({ timeoutMs: 10_000 });

    const points = await collect();
    const attempts = points.get("hookgres.delivery.attempts") ?? [];
    const byOutcome = Object.fromEntries(
      attempts.map((p) => [JSON.stringify(p.attributes), p.value]),
    );
    expect(byOutcome).toEqual({
      [JSON.stringify({
        "hookgres.outcome": "retrying",
        "http.response.status_code": 500,
        "error.type": "500",
      })]: 2,
      [JSON.stringify({
        "hookgres.outcome": "succeeded",
        "http.response.status_code": 200,
      })]: 1,
      [JSON.stringify({
        "hookgres.outcome": "failed",
        "http.response.status_code": 500,
        "error.type": "500",
      })]: 1,
    });
    const durations = points.get("hookgres.delivery.attempt.duration") ?? [];
    const count = durations.reduce(
      (n, p) => n + (p.value as { count: number }).count,
      0,
    );
    expect(count).toBe(4);
    // No per-customer attributes: they'd make a series per tenant.
    for (const p of [...attempts, ...durations]) {
      expect(Object.keys(p.attributes)).not.toContain("hookgres.tenant_id");
    }
    expect(points.has("hookgres.queue.pending")).toBe(false);
  });

  it("names timeouts in error.type", async () => {
    const { api, collect } = meter();
    const hw = ctx.create({
      retrySchedule: [],
      requestTimeoutMs: 300,
      opentelemetry: { api, queueMetrics: false },
    });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => new Promise((r) => setTimeout(() => r(200), 2000));
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await hw.runOnce();
    const [point] = (await collect()).get("hookgres.delivery.attempts") ?? [];
    expect(point?.attributes).toEqual({
      "hookgres.outcome": "failed",
      "error.type": "timeout",
    });
  });

  it("counts disabled endpoints and worker errors", async () => {
    const { api, collect } = meter();
    const hw = ctx.create({
      retrySchedule: [],
      disableEndpointAfterMs: 0,
      onError: () => {},
      opentelemetry: { api, queueMetrics: false },
    });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await hw.runOnce();
    // A worker error: the table is gone.
    await ctx.pool.query(
      `ALTER TABLE "${ctx.schema}".deliveries RENAME TO deliveries_gone`,
    );
    try {
      hw.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await hw.stop();
    } finally {
      await ctx.pool.query(
        `ALTER TABLE "${ctx.schema}".deliveries_gone RENAME TO deliveries`,
      );
    }
    const points = await collect();
    expect(points.get("hookgres.endpoints.disabled")?.[0]?.value).toBe(1);
    const errors = points.get("hookgres.worker.errors") ?? [];
    expect(errors[0]?.attributes).toEqual({ "error.type": "42P01" });
    expect(errors[0]?.value).toBeGreaterThan(0);
  });

  it("reports the queue from the database, and stops after close()", async () => {
    const { api, collect } = meter();
    const hw = ctx.create({ opentelemetry: { api } });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await setDue("now() - interval '30 seconds'");
    const points = await collect();
    expect(points.get("hookgres.queue.pending")?.[0]?.value).toBe(2);
    expect(points.get("hookgres.queue.due")?.[0]?.value).toBe(2);
    expect(points.get("hookgres.queue.delivering")?.[0]?.value).toBe(0);
    const lag = points.get("hookgres.queue.lag")?.[0]?.value as number;
    expect(lag).toBeGreaterThanOrEqual(29);
    expect(lag).toBeLessThan(60);

    // After close(), exporting no longer queries the database.
    let reads = 0;
    const stats = hw.stats.bind(hw);
    hw.stats = (filter) => {
      reads++;
      return stats(filter);
    };
    await collect();
    expect(reads).toBe(1);
    await hw.close();
    await collect();
    expect(reads).toBe(1);
  });

  it("reports a failed queue read to onError instead of failing the export", async () => {
    const { api, collect } = meter();
    const errors: unknown[] = [];
    const hw = ctx.create({
      onError: (error) => {
        errors.push(error);
      },
      opentelemetry: { api },
    });
    await ctx.pool.query(
      `ALTER TABLE "${ctx.schema}".deliveries RENAME TO deliveries_gone`,
    );
    try {
      const points = await collect();
      expect(points.get("hookgres.queue.pending") ?? []).toEqual([]);
    } finally {
      await ctx.pool.query(
        `ALTER TABLE "${ctx.schema}".deliveries_gone RENAME TO deliveries`,
      );
    }
    expect(errors).toHaveLength(1);
    void hw;
  });

  it("keeps delivering, and calls every hook, when the meter throws", async () => {
    const broken = () => {
      throw new Error("broken meter");
    };
    const instrument = { add: broken, record: broken };
    const api = {
      metrics: {
        getMeter: () => ({
          createCounter: () => instrument,
          createHistogram: () => instrument,
          createObservableGauge: () => ({}),
          addBatchObservableCallback: () => {},
          removeBatchObservableCallback: broken,
        }),
      },
    };
    const seen: string[] = [];
    const hw = ctx.create({
      retrySchedule: [],
      disableEndpointAfterMs: 0,
      opentelemetry: { api },
      onAttempt: (event) => {
        seen.push(`attempt:${event.outcome}`);
      },
      onEndpointDisabled: () => {
        seen.push("disabled");
      },
      onError: (error) => {
        seen.push(`error:${(error as Error).message}`);
      },
    });
    const ep = await hw.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
    });
    receiver.respond = () => 500;
    await hw.send({ tenantId: "acme", eventType: "e", payload: { i: 1 } });
    // Queued behind the first; failed as soon as the endpoint is disabled.
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".deliveries SET next_attempt_at = now() + interval '1 hour'`,
    );
    await hw.send({ tenantId: "acme", eventType: "e", payload: { i: 2 } });
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".deliveries SET next_attempt_at = now() - interval '1 hour'
       WHERE next_attempt_at < now() + interval '30 minutes'`,
    );
    expect(await hw.runOnce()).toBe(1);
    expect(seen).toEqual(["attempt:failed", "disabled"]);
    const deliveries = await hw.listDeliveries({ endpointId: ep.id });
    expect(deliveries.map((d) => d.status)).toEqual(["failed", "failed"]);
    await hw.close();
  });

  it("records nothing and needs nothing without the option", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    expect(await hw.runOnce()).toBe(1);
  });
});
