import * as otel from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { type Receiver, startReceiver, useHookgres } from "./helpers.js";

// The real undici instrumentation, set up globally the way an app's
// auto-instrumentation would be. Each test file runs in its own worker, so
// these globals don't reach other files.

const ctx = useHookgres();
const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
});
let instrumentation: UndiciInstrumentation;
let receiver: Receiver;

beforeAll(() => {
  otel.trace.setGlobalTracerProvider(provider);
  otel.context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  otel.propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  );
  instrumentation = new UndiciInstrumentation();
  instrumentation.enable();
});
afterAll(async () => {
  instrumentation.disable();
  await provider.shutdown();
  otel.trace.disable();
  otel.context.disable();
  otel.propagation.disable();
});
beforeEach(async () => {
  receiver = await startReceiver();
  exporter.reset();
});
afterEach(async () => {
  await receiver.close();
});

/** Sends one webhook from inside a request with baggage, and delivers it. */
async function sendAndDeliver(
  options: Parameters<typeof ctx.create>[0],
): Promise<void> {
  const hw = ctx.create(options);
  const endpoint = await hw.createEndpoint({
    tenantId: "acme",
    url: `${receiver.url}?token=SECRET`,
  });
  const tracer = otel.trace.getTracer("app");
  await tracer.startActiveSpan("POST /invoices", async (span) => {
    const withBaggage = otel.propagation.setBaggage(
      otel.context.active(),
      otel.propagation.createBaggage({ email: { value: "a@b.c" } }),
    );
    await otel.context.with(withBaggage, () =>
      hw.send({ tenantId: "acme", eventType: "e", payload: {} }),
    );
    span.end();
  });
  expect(await hw.runOnce()).toBe(1);
  await hw.deleteEndpoint(endpoint.id);
}

const undiciSpans = () =>
  exporter
    .getFinishedSpans()
    .filter(
      (s) =>
        s.instrumentationScope.name === "@opentelemetry/instrumentation-undici",
    );

describe("with the real undici instrumentation", () => {
  it("records no span for webhook requests and sends no trace headers", async () => {
    for (const traces of [true, false]) {
      await sendAndDeliver({ opentelemetry: { api: otel, traces } });
    }
    expect(undiciSpans()).toEqual([]);
    expect(
      JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes)),
    ).not.toContain("SECRET");
    expect(receiver.requests).toHaveLength(2);
    for (const request of receiver.requests) {
      expect(request.headers.traceparent).toBeUndefined();
      expect(request.headers.baggage).toBeUndefined();
    }
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === "deliver webhook"),
    ).toHaveLength(1);
  });

  it("traces webhook requests with httpInstrumentation: true", async () => {
    await sendAndDeliver({
      opentelemetry: { api: otel, httpInstrumentation: true },
    });
    // The instrumentation is live, so the test above isn't passing vacuously.
    const [span] = undiciSpans();
    expect(span?.attributes["url.full"]).toContain("SECRET");
    const [deliver] = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "deliver webhook");
    expect(span?.parentSpanContext?.spanId).toBe(deliver?.spanContext().spanId);
    expect(receiver.requests[0]?.headers.traceparent).toContain(
      deliver?.spanContext().traceId,
    );
  });
});
