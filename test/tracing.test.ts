import * as otel from "@opentelemetry/api";
import { createNoopMeter } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Receiver, startReceiver, useHookgres } from "./helpers.js";

const ctx = useHookgres();
let receiver: Receiver;

beforeEach(async () => {
  receiver = await startReceiver();
});
afterEach(async () => {
  await receiver.close();
});

/**
 * A private tracer provider, context manager and propagator: tests don't
 * touch OpenTelemetry's globals.
 */
function tracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const manager = new AsyncLocalStorageContextManager().enable();
  const propagator = new CompositePropagator({
    propagators: [
      new W3CTraceContextPropagator(),
      new W3CBaggagePropagator(),
      // Like Jaeger's: baggage under its own keys, not "baggage".
      {
        inject(context: otel.Context, carrier: Record<string, string>) {
          for (const [key, entry] of otel.propagation
            .getBaggage(context)
            ?.getAllEntries() ?? []) {
            carrier[`uberctx-${key}`] = entry.value;
          }
        },
        extract: (context: otel.Context) => context,
        fields: () => [],
      },
    ],
  });
  const api = {
    metrics: { getMeter: () => createNoopMeter() },
    trace: {
      getTracer: (name: string, version?: string) =>
        provider.getTracer(name, version),
      setSpan: otel.trace.setSpan,
      getSpanContext: otel.trace.getSpanContext,
    },
    context: {
      active: () => manager.active(),
      with: <T>(context: otel.Context, fn: () => T): T =>
        manager.with(context, fn),
    },
    propagation: {
      inject: (context: otel.Context, carrier: Record<string, string>) =>
        propagator.inject(context, carrier, otel.defaultTextMapSetter),
      extract: (context: otel.Context, carrier: Record<string, string>) =>
        propagator.extract(context, carrier, otel.defaultTextMapGetter),
    },
    ROOT_CONTEXT: otel.ROOT_CONTEXT,
    createContextKey: otel.createContextKey,
  };
  const tracer = provider.getTracer("test");
  const spans = (name: string): ReadableSpan[] =>
    exporter.getFinishedSpans().filter((s) => s.name === name);
  const inRequest = <T>(fn: () => Promise<T>, baggage = false) => {
    const span = tracer.startSpan("POST /invoices");
    let context = otel.trace.setSpan(manager.active(), span);
    if (baggage) {
      context = otel.propagation.setBaggage(
        context,
        otel.propagation.createBaggage({ email: { value: "a@b.c" } }),
      );
    }
    return manager.with(context, fn).finally(() => span.end());
  };
  /**
   * A fetch that does what an HTTP instrumentation (undici, node:http) does:
   * a client span recording the URL, and trace headers on the request.
   */
  const activeSpanIds: (string | undefined)[] = [];
  const instrumentedFetch: typeof fetch = (input, init) => {
    const active = manager.active();
    activeSpanIds.push(otel.trace.getSpanContext(active)?.spanId);
    const span = provider
      .getTracer("instrumentation-undici")
      .startSpan("POST", { kind: otel.SpanKind.CLIENT }, active);
    span.setAttribute("url.full", String(input));
    const headers = new Headers(init?.headers);
    propagator.inject(otel.trace.setSpan(active, span), headers, {
      set: (h, k, v) => h.set(k, v),
    });
    return fetch(input, { ...init, headers }).finally(() => span.end());
  };
  return {
    api,
    manager,
    instrumentedFetch,
    activeSpanIds,
    spans,
    inRequest,
    close: () => manager.disable(),
  };
}

async function storedTraceContext(): Promise<unknown[]> {
  const { rows } = await ctx.pool.query(
    `SELECT trace_context FROM "${ctx.schema}".messages ORDER BY created_at`,
  );
  return rows.map((r) => r.trace_context);
}

describe("OpenTelemetry traces", () => {
  it("links each delivery attempt to the send() that queued it", async () => {
    const t = tracing();
    try {
      const hw = ctx.create({ opentelemetry: { api: t.api } });
      const ep = await hw.createEndpoint({
        tenantId: "acme",
        url: `${receiver.url}?token=secret`,
      });
      const { message } = await t.inRequest(() =>
        hw.send({ tenantId: "acme", eventType: "invoice.paid", payload: {} }),
      );
      await hw.runOnce();

      const [request] = t.spans("POST /invoices");
      const [send] = t.spans("send webhook");
      const [deliver] = t.spans("deliver webhook");
      expect(send?.parentSpanContext?.spanId).toBe(
        request?.spanContext().spanId,
      );
      expect(send?.kind).toBe(otel.SpanKind.PRODUCER);
      expect(send?.attributes).toMatchObject({
        "messaging.system": "hookgres",
        "messaging.operation.type": "send",
        "messaging.message.id": message.id,
        "hookgres.tenant_id": "acme",
        "hookgres.event_type": "invoice.paid",
        "hookgres.delivery_count": 1,
        "hookgres.deduplicated": false,
      });

      // A separate trace, linked back: retries can come hours later.
      expect(deliver?.kind).toBe(otel.SpanKind.CLIENT);
      expect(deliver?.spanContext().traceId).not.toBe(
        send?.spanContext().traceId,
      );
      expect(deliver?.links.map((l) => l.context.spanId)).toEqual([
        send?.spanContext().spanId,
      ]);
      const url = new URL(receiver.url);
      expect(deliver?.attributes).toMatchObject({
        "messaging.message.id": message.id,
        "hookgres.endpoint.id": ep.id,
        "hookgres.attempt_number": 1,
        "http.request.method": "POST",
        "http.response.status_code": 200,
        "server.address": url.hostname,
        "server.port": Number(url.port),
        "url.scheme": "http",
      });
      expect(deliver?.status.code).toBe(otel.SpanStatusCode.UNSET);
      // The URL can carry a secret: it's never recorded.
      expect(JSON.stringify(deliver?.attributes)).not.toContain("secret");
      // Nor sent to the customer.
      expect(receiver.requests[0]?.headers.traceparent).toBeUndefined();
    } finally {
      t.close();
    }
  });

  it("marks failed attempts as errors", async () => {
    const t = tracing();
    try {
      const hw = ctx.create({
        retrySchedule: [0],
        opentelemetry: { api: t.api },
      });
      await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
      receiver.respond = () => 503;
      await t.inRequest(() =>
        hw.send({ tenantId: "acme", eventType: "e", payload: {} }),
      );
      await hw.drain({ timeoutMs: 10_000 });
      const attempts = t.spans("deliver webhook");
      expect(
        attempts.map((s) => s.attributes["hookgres.attempt_number"]),
      ).toEqual([1, 2]);
      for (const span of attempts) {
        expect(span.status).toEqual({
          code: otel.SpanStatusCode.ERROR,
          message: "HTTP 503",
        });
        expect(span.attributes["error.type"]).toBe("503");
        expect(span.links).toHaveLength(1);
      }
    } finally {
      t.close();
    }
  });

  it("stores trace context without baggage, and nothing outside a trace", async () => {
    const t = tracing();
    try {
      const hw = ctx.create({ opentelemetry: { api: t.api } });
      await t.inRequest(
        () => hw.send({ tenantId: "acme", eventType: "e", payload: {} }),
        true,
      );
      const [stored] = await storedTraceContext();
      expect(Object.keys(stored as object)).toEqual(["traceparent"]);
      expect((stored as { traceparent: string }).traceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
      );
    } finally {
      t.close();
    }
  });

  it("sends and delivers untraced with traces off or no tracing API", async () => {
    const t = tracing();
    try {
      for (const opentelemetry of [
        { api: t.api, traces: false },
        { api: { metrics: t.api.metrics } },
      ]) {
        const hw = ctx.create({ opentelemetry });
        await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
        await t.inRequest(() =>
          hw.send({ tenantId: "acme", eventType: "e", payload: {} }),
        );
        expect(await hw.runOnce()).toBe(1);
        await hw.deleteEndpoint((await hw.listEndpoints("acme"))[0]?.id ?? "");
      }
      expect(t.spans("send webhook")).toEqual([]);
      expect(t.spans("deliver webhook")).toEqual([]);
      expect(await storedTraceContext()).toEqual([null, null]);
    } finally {
      t.close();
    }
  });

  it("records a failed send on its span", async () => {
    const t = tracing();
    try {
      const hw = ctx.create({ opentelemetry: { api: t.api } });
      await expect(
        t.inRequest(() =>
          hw.send({ tenantId: "acme", eventType: "e", payload: "\u0000" }),
        ),
      ).rejects.toThrow();
      const [send] = t.spans("send webhook");
      expect(send?.status.code).toBe(otel.SpanStatusCode.ERROR);
      expect(send?.events.map((e) => e.name)).toEqual(["exception"]);
    } finally {
      t.close();
    }
  });

  it("keeps sending and delivering when the tracer throws", async () => {
    const broken = () => {
      throw new Error("broken tracer");
    };
    const t = tracing();
    try {
      const api = {
        ...t.api,
        trace: { ...t.api.trace, getTracer: () => ({ startSpan: broken }) },
        context: { active: t.api.context.active, with: broken },
      };
      const hw = ctx.create({ opentelemetry: { api } });
      await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
      await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
      expect(await hw.runOnce()).toBe(1);
      expect(receiver.requests).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it("starts each attempt's own trace even inside a request", async () => {
    const t = tracing();
    try {
      const hw = ctx.create({ opentelemetry: { api: t.api } });
      await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
      await t.inRequest(() =>
        hw.send({ tenantId: "acme", eventType: "e", payload: {} }),
      );
      // e.g. drain() from a cron route
      await t.inRequest(() => hw.runOnce());
      const cron = t.spans("POST /invoices")[1];
      const [deliver] = t.spans("deliver webhook");
      expect(deliver?.parentSpanContext).toBeUndefined();
      expect(deliver?.spanContext().traceId).not.toBe(
        cron?.spanContext().traceId,
      );
      expect(deliver?.links).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it("sends once when the context manager fails after the request started", async () => {
    const t = tracing();
    try {
      const api = {
        ...t.api,
        context: {
          active: t.api.context.active,
          with: <T>(context: otel.Context, fn: () => T): T => {
            t.manager.with(context, fn);
            throw new Error("context manager broke on exit");
          },
        },
      };
      const attempts: string[] = [];
      const hw = ctx.create({
        opentelemetry: { api },
        onAttempt: (event) => {
          attempts.push(event.outcome);
        },
      });
      await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
      await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
      expect(await hw.runOnce()).toBe(1);
      expect(receiver.requests).toHaveLength(1);
      expect(attempts).toEqual(["succeeded"]);
    } finally {
      t.close();
    }
  });

  it("keeps HTTP instrumentations off webhook requests", async () => {
    const t = tracing();
    try {
      for (const traces of [true, false]) {
        const hw = ctx.create({
          opentelemetry: { api: t.api, traces },
          fetch: t.instrumentedFetch,
        });
        const ep = await hw.createEndpoint({
          tenantId: "acme",
          url: `${receiver.url}?token=SECRET`,
        });
        await t.inRequest(
          () => hw.send({ tenantId: "acme", eventType: "e", payload: {} }),
          true,
        );
        // Delivered inside a request with baggage, e.g. drain() in a route.
        expect(await t.inRequest(() => hw.runOnce(), true)).toBe(1);
        await hw.deleteEndpoint(ep.id);
      }
      expect(receiver.requests).toHaveLength(2);
      for (const request of receiver.requests) {
        expect(request.headers.traceparent).toBeUndefined();
        expect(request.headers.baggage).toBeUndefined();
        expect(request.headers["uberctx-email"]).toBeUndefined();
      }
      expect(t.spans("POST")).toEqual([]);
      const [deliver] = t.spans("deliver webhook");
      expect(t.spans("deliver webhook")).toHaveLength(1);
      // Still active during the request, and still linked to its send().
      expect(t.activeSpanIds[0]).toBe(deliver?.spanContext().spanId);
      expect(deliver?.links).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it("keeps HTTP instrumentations off and sends once with a misbehaving API", async () => {
    const t = tracing();
    try {
      const broken = () => {
        throw new Error("broken");
      };
      const apis = [
        // A tracer that throws: no span, still suppressed.
        {
          ...t.api,
          trace: { ...t.api.trace, getTracer: () => ({ startSpan: broken }) },
        },
        // A createContextKey that throws: the standard key is used.
        { ...t.api, createContextKey: broken },
        // A context manager whose with() returns the wrong thing.
        ...[true, false].map((traces) => ({
          ...t.api,
          traces,
          context: {
            active: t.api.context.active,
            with: <T>(context: otel.Context, fn: () => T): T => {
              t.manager.with(context, fn);
              return undefined as T;
            },
          },
        })),
      ];
      for (const { traces, ...api } of apis as (typeof t.api & {
        traces?: boolean;
      })[]) {
        const attempts: string[] = [];
        const hw = ctx.create({
          opentelemetry: { api, traces },
          fetch: t.instrumentedFetch,
          onAttempt: (event) => {
            attempts.push(event.outcome);
          },
        });
        const ep = await hw.createEndpoint({
          tenantId: "acme",
          url: receiver.url,
        });
        await t.inRequest(() =>
          hw.send({ tenantId: "acme", eventType: "e", payload: {} }),
        );
        expect(await hw.runOnce()).toBe(1);
        expect(attempts).toEqual(["succeeded"]);
        await hw.deleteEndpoint(ep.id);
      }
      expect(receiver.requests).toHaveLength(apis.length);
      for (const request of receiver.requests) {
        expect(request.headers.traceparent).toBeUndefined();
      }
      expect(t.spans("POST")).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("delivers a message queued before tracing was turned on", async () => {
    const t = tracing();
    try {
      const plain = ctx.create();
      await plain.createEndpoint({ tenantId: "acme", url: receiver.url });
      await plain.send({ tenantId: "acme", eventType: "e", payload: {} });
      const hw = ctx.create({ opentelemetry: { api: t.api } });
      expect(await hw.runOnce()).toBe(1);
      const [deliver] = t.spans("deliver webhook");
      expect(deliver?.links).toEqual([]);
    } finally {
      t.close();
    }
  });
});
