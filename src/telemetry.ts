import type { AttemptEvent, QueueStats } from "./types.js";

// The slice of `@opentelemetry/api` (1.7 or later) Hookgres uses, typed here
// so Hookgres doesn't depend on it: you pass in your own copy, the same one
// your SDK registered with.

type Attributes = Record<string, string | number | boolean>;

interface InstrumentOptions {
  description?: string;
  unit?: string;
  advice?: { explicitBucketBoundaries?: number[] };
}

/** An observable instrument, as `@opentelemetry/api` returns it. */
export type OtelObservable = object;

type BatchCallback = (result: {
  observe(
    observable: OtelObservable,
    value: number,
    attributes?: Attributes,
  ): void;
}) => void | Promise<void>;

/** The parts of an `@opentelemetry/api` `Meter` Hookgres calls. */
export interface OtelMeter {
  createCounter(
    name: string,
    options?: InstrumentOptions,
  ): { add(value: number, attributes?: Attributes): void };
  createHistogram(
    name: string,
    options?: InstrumentOptions,
  ): { record(value: number, attributes?: Attributes): void };
  createObservableGauge(
    name: string,
    options?: InstrumentOptions,
  ): OtelObservable;
  addBatchObservableCallback(
    callback: BatchCallback,
    observables: OtelObservable[],
  ): void;
  removeBatchObservableCallback(
    callback: BatchCallback,
    observables: OtelObservable[],
  ): void;
}

/**
 * The `@opentelemetry/api` module, or any object with the same shape:
 * `import * as otel from "@opentelemetry/api"`.
 */
export interface OpenTelemetryApi {
  metrics: { getMeter(name: string, version?: string): OtelMeter };
  /** For traces: `trace`, `context`, `propagation` and `ROOT_CONTEXT` are all needed, as in the real module. */
  trace?: {
    getTracer(name: string, version?: string): OtelTracer;
    setSpan(context: OtelContext, span: OtelSpan): OtelContext;
    getSpanContext(context: OtelContext): OtelSpanContext | undefined;
  };
  context?: {
    active(): OtelContext;
    with<T>(context: OtelContext, fn: () => T): T;
  };
  propagation?: {
    inject(context: OtelContext, carrier: Record<string, string>): void;
    extract(context: OtelContext, carrier: Record<string, string>): OtelContext;
  };
  ROOT_CONTEXT?: OtelContext;
  /** Makes the key that keeps HTTP instrumentations off webhook requests. */
  createContextKey?(description: string): symbol;
}

/** An OpenTelemetry `Context`; opaque to Hookgres. */
export type OtelContext = object;

/** The parts of an OpenTelemetry `SpanContext` Hookgres reads. */
export interface OtelSpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

/** The parts of an OpenTelemetry `Span` Hookgres calls. */
export interface OtelSpan {
  setAttributes(attributes: Attributes): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(exception: Error | string): void;
  end(endTime?: number): void;
}

/** The parts of an OpenTelemetry `Tracer` Hookgres calls. */
export interface OtelTracer {
  startSpan(
    name: string,
    options?: {
      kind?: number;
      attributes?: Attributes;
      links?: { context: OtelSpanContext }[];
      root?: boolean;
    },
    context?: OtelContext,
  ): OtelSpan;
}

/** The `opentelemetry` option. */
export interface OpenTelemetryOptions {
  /** Your `@opentelemetry/api` module: `import * as otel from "@opentelemetry/api"`. */
  api: OpenTelemetryApi;
  /**
   * Report the `hookgres.queue.*` gauges, read with one query per metric
   * export. Every process with this on reports the same values, so take the
   * max (not the sum) across processes, or turn it off on all but one kind
   * of process. Default `true`.
   */
  queueMetrics?: boolean;
  /**
   * Record a span for each `send()` and each delivery attempt, linked to
   * each other. Needs `api` to include `trace`, `context` and `propagation`,
   * as the real module does. Default `true`.
   */
  traces?: boolean;
}

// SpanKind and SpanStatusCode values from @opentelemetry/api.
const SPAN_KIND_CLIENT = 2;
const SPAN_KIND_PRODUCER = 3;
const SPAN_STATUS_ERROR = 2;
/** Trace context bigger than this isn't stored. */
const MAX_TRACE_CONTEXT_BYTES = 1024;

type TracingApi = Required<
  Pick<OpenTelemetryApi, "trace" | "context" | "propagation" | "ROOT_CONTEXT">
>;
type ContextApi = NonNullable<OpenTelemetryApi["context"]>;

/**
 * The key `@opentelemetry/core`'s `suppressTracing()` sets, which the SDK's
 * tracers and propagators honor: no spans and no injected headers. Its
 * `createContextKey` is `Symbol.for(description)`.
 */
const SUPPRESS_TRACING = "OpenTelemetry SDK Context Key SUPPRESS_TRACING";

/** What `traceAttempt` needs to know about the delivery. */
export interface TracedDelivery {
  deliveryId: string;
  messageId: string;
  endpointId: string;
  tenantId: string;
  eventType: string;
  attemptNumber: number;
  url: string;
  traceContext: Record<string, string> | null;
}

/** Seconds; covers fast receivers up to the longest request timeouts. */
const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30, 60,
];

/**
 * Records Hookgres's metrics. Attributes are deliberately low-cardinality:
 * no tenant, endpoint or event type, which would make a series per customer.
 */
export class Telemetry {
  private readonly attempts;
  private readonly duration;
  private readonly disabled;
  private readonly errors;
  private readonly meter: OtelMeter;
  private readonly gauges: OtelObservable[] = [];
  private readonly observeQueue: BatchCallback | null = null;
  private closed = false;
  /** Set when traces are on. */
  readonly tracing: TracingApi | null = null;
  private readonly tracer: OtelTracer | null = null;
  private readonly context: ContextApi | null;
  private readonly suppressKey: symbol;

  constructor(
    options: OpenTelemetryOptions,
    readStats: () => Promise<QueueStats>,
    onError: (error: unknown) => void,
  ) {
    const { trace, context, propagation, ROOT_CONTEXT } = options.api;
    this.context = context ?? null;
    let suppressKey = Symbol.for(SUPPRESS_TRACING);
    guard(() => {
      suppressKey =
        options.api.createContextKey?.(SUPPRESS_TRACING) ?? suppressKey;
    });
    this.suppressKey = suppressKey;
    if (
      options.traces !== false &&
      trace &&
      context &&
      propagation &&
      ROOT_CONTEXT
    ) {
      this.tracing = { trace, context, propagation, ROOT_CONTEXT };
      this.tracer = trace.getTracer("hookgres");
    }
    const meter = options.api.metrics.getMeter("hookgres");
    this.meter = meter;
    this.attempts = meter.createCounter("hookgres.delivery.attempts", {
      description: "HTTP delivery attempts, by outcome",
      unit: "{attempt}",
    });
    this.duration = meter.createHistogram(
      "hookgres.delivery.attempt.duration",
      {
        description: "How long each HTTP delivery attempt took",
        unit: "s",
        advice: { explicitBucketBoundaries: DURATION_BUCKETS },
      },
    );
    this.disabled = meter.createCounter("hookgres.endpoints.disabled", {
      description: "Endpoints disabled automatically after failing too long",
      unit: "{endpoint}",
    });
    this.errors = meter.createCounter("hookgres.worker.errors", {
      description: "Errors passed to onError",
      unit: "{error}",
    });
    if (options.queueMetrics === false) return;

    const gauge = (name: string, description: string, unit: string) => {
      const g = meter.createObservableGauge(name, { description, unit });
      this.gauges.push(g);
      return g;
    };
    const pending = gauge(
      "hookgres.queue.pending",
      "Deliveries waiting, including retries scheduled for later",
      "{delivery}",
    );
    const due = gauge(
      "hookgres.queue.due",
      "Pending deliveries whose time has come",
      "{delivery}",
    );
    const delivering = gauge(
      "hookgres.queue.delivering",
      "Deliveries claimed by a worker",
      "{delivery}",
    );
    const lag = gauge(
      "hookgres.queue.lag",
      "How long the oldest due delivery has been waiting",
      "s",
    );
    this.observeQueue = async (result) => {
      // An export that began before close() mustn't query a closing pool.
      if (this.closed) return;
      let stats: QueueStats;
      try {
        stats = await readStats();
      } catch (error) {
        onError(error);
        return;
      }
      result.observe(pending, stats.pending);
      result.observe(due, stats.due);
      result.observe(delivering, stats.delivering);
      result.observe(lag, stats.lagMs / 1000);
    };
    meter.addBatchObservableCallback(this.observeQueue, this.gauges);
  }

  recordAttempt(event: AttemptEvent): void {
    guard(() => {
      const attributes: Attributes = { "hookgres.outcome": event.outcome };
      if (event.statusCode !== null) {
        attributes["http.response.status_code"] = event.statusCode;
      }
      if (event.outcome !== "succeeded") {
        attributes["error.type"] = errorType(event);
      }
      this.attempts.add(1, attributes);
      this.duration.record(event.durationMs / 1000, attributes);
    });
  }

  recordEndpointDisabled(): void {
    guard(() => this.disabled.add(1));
  }

  recordError(error: unknown): void {
    guard(() => {
      const code = (error as { code?: unknown } | null)?.code;
      this.errors.add(1, {
        "error.type":
          typeof code === "string" && code.length <= 32
            ? code
            : error instanceof Error
              ? error.name
              : "_OTHER",
      });
    });
  }

  /**
   * Runs `send()` in a producer span and hands it the trace context to store
   * with the message, so delivery spans can link back to this one.
   */
  async traceSend<
    R extends {
      message: { id: string };
      deliveryCount: number;
      deduplicated: boolean;
    },
  >(
    attributes: { tenantId: string; eventType: string },
    run: (traceContext: Record<string, string> | null) => Promise<R>,
  ): Promise<R> {
    const tracing = this.tracing;
    const tracer = this.tracer;
    if (!tracing || !tracer) return run(null);
    let span: OtelSpan | undefined;
    let traceContext: Record<string, string> | null = null;
    guard(() => {
      span = tracer.startSpan(
        "send webhook",
        {
          kind: SPAN_KIND_PRODUCER,
          attributes: {
            "messaging.system": "hookgres",
            "messaging.operation.type": "send",
            "hookgres.tenant_id": attributes.tenantId,
            "hookgres.event_type": attributes.eventType,
          },
        },
        // Explicit, so the parent comes from your API's context manager.
        tracing.context.active(),
      );
      const carrier: Record<string, string> = {};
      // From a context holding only the span: no propagator can add the
      // caller's baggage (application data, possibly personal) to what's
      // stored.
      tracing.propagation.inject(
        tracing.trace.setSpan(tracing.ROOT_CONTEXT, span),
        carrier,
      );
      traceContext = storable(carrier);
    });
    let result: R;
    try {
      result = await run(traceContext);
    } catch (error) {
      guard(() => {
        span?.recordException(error instanceof Error ? error : String(error));
        span?.setStatus({ code: SPAN_STATUS_ERROR });
        span?.end();
      });
      throw error;
    }
    guard(() => {
      span?.setAttributes({
        "messaging.message.id": result.message.id,
        "hookgres.delivery_count": result.deliveryCount,
        "hookgres.deduplicated": result.deduplicated,
      });
      span?.end();
    });
    return result;
  }

  /**
   * Runs one HTTP attempt in a client span, linked to the `send()` that
   * queued it. With traces off, just runs it untraced.
   *
   * Either way, HTTP instrumentations are kept off the request: their span
   * would record the full URL (often holding a secret), and they'd send the
   * receiver a `traceparent` and your baggage.
   */
  async traceAttempt<
    R extends { ok: boolean; statusCode: number | null; error: string | null },
  >(delivery: TracedDelivery, run: () => Promise<R>): Promise<R> {
    const tracing = this.tracing;
    const tracer = this.tracer;
    const contextApi = this.context;
    if (!contextApi) return run();
    // Suppressed first and on its own, so a broken tracer can't undo it.
    let active: OtelContext | undefined;
    guard(() => {
      active = this.suppress(contextApi.active());
    });
    if (!tracing || !tracer) return runIn(contextApi, active, run);
    let span: OtelSpan | undefined;
    guard(() => {
      const attributes: Attributes = {
        "messaging.system": "hookgres",
        "messaging.operation.type": "process",
        "messaging.message.id": delivery.messageId,
        "hookgres.delivery.id": delivery.deliveryId,
        "hookgres.endpoint.id": delivery.endpointId,
        "hookgres.tenant_id": delivery.tenantId,
        "hookgres.event_type": delivery.eventType,
        "hookgres.attempt_number": delivery.attemptNumber,
        "http.request.method": "POST",
      };
      // Not url.full: webhook URLs often carry a secret in the path or query.
      const url = new URL(delivery.url);
      attributes["url.scheme"] = url.protocol.replace(/:$/, "");
      attributes["server.address"] = url.hostname;
      attributes["server.port"] =
        Number(url.port) || (url.protocol === "https:" ? 443 : 80);
      span = tracer.startSpan(
        "deliver webhook",
        {
          kind: SPAN_KIND_CLIENT,
          attributes,
          links: linkTo(tracing, delivery.traceContext),
          // Its own trace even when run inside a request, e.g. drain() from
          // a cron route: retries can come a day later.
          root: true,
        },
        tracing.context.active(),
      );
      active = tracing.trace.setSpan(active ?? contextApi.active(), span);
    });
    let result: R;
    try {
      result = await runIn(contextApi, active, run);
    } catch (error) {
      guard(() => {
        span?.recordException(error instanceof Error ? error : String(error));
        span?.setStatus({ code: SPAN_STATUS_ERROR });
        span?.end();
      });
      throw error;
    }
    guard(() => {
      const attributes: Attributes = {};
      if (result.statusCode !== null) {
        attributes["http.response.status_code"] = result.statusCode;
      }
      if (!result.ok) {
        attributes["error.type"] = errorType(result);
        span?.setStatus({
          code: SPAN_STATUS_ERROR,
          message: result.error ?? `HTTP ${result.statusCode}`,
        });
      }
      span?.setAttributes(attributes);
      span?.end();
    });
    return result;
  }

  /** `context` with tracing suppressed, or as is if it can't be. */
  private suppress(context: OtelContext): OtelContext {
    const { setValue } = context as {
      setValue?: (key: symbol, value: unknown) => OtelContext;
    };
    return typeof setValue === "function"
      ? setValue.call(context, this.suppressKey, true)
      : context;
  }

  /** Stops reading queue stats, so a closed instance doesn't query. */
  close(): void {
    this.closed = true;
    if (this.observeQueue) {
      const callback = this.observeQueue;
      guard(() =>
        this.meter.removeBatchObservableCallback(callback, this.gauges),
      );
    }
  }
}

/**
 * Metrics must never break delivery: a meter that throws (a broken SDK or
 * wrapper) loses the measurement, not the attempt's follow-up work.
 */
function guard(record: () => void): void {
  try {
    record();
  } catch {
    // Dropped on purpose; see above.
  }
}

/** Runs `run` with `context` active, or plainly if there's none. */
async function runIn<R>(
  contextApi: ContextApi,
  context: OtelContext | undefined,
  run: () => Promise<R>,
): Promise<R> {
  if (!context) return run();
  let running: Promise<R> | undefined;
  try {
    await contextApi.with(context, () => {
      running = run();
      return running;
    });
  } catch {
    // The context manager failed, or the request did: either way, the
    // outcome is the request's own, below.
  }
  // Never what `with` returned (a broken one may return anything), and never
  // a second send: run untraced only if it never ran.
  return running ?? run();
}

/**
 * The injected trace context, without baggage (application data, possibly
 * personal) and only if small. `null` when there's nothing to link to.
 */
function storable(
  carrier: Record<string, string>,
): Record<string, string> | null {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(carrier)) {
    if (key !== "baggage" && typeof value === "string") kept[key] = value;
  }
  if (Object.keys(kept).length === 0) return null;
  if (Buffer.byteLength(JSON.stringify(kept)) > MAX_TRACE_CONTEXT_BYTES) {
    return null;
  }
  return kept;
}

/** A link to the stored trace context's span, if it holds a valid one. */
function linkTo(
  tracing: TracingApi,
  traceContext: Record<string, string> | null,
): { context: OtelSpanContext }[] {
  if (!traceContext) return [];
  const extracted = tracing.propagation.extract(
    tracing.ROOT_CONTEXT,
    traceContext,
  );
  const context = tracing.trace.getSpanContext(extracted);
  if (
    !context ||
    !/^[0-9a-f]{32}$/.test(context.traceId) ||
    /^0+$/.test(context.traceId) ||
    !/^[0-9a-f]{16}$/.test(context.spanId) ||
    /^0+$/.test(context.spanId)
  ) {
    return [];
  }
  return [{ context }];
}

/** OpenTelemetry's `error.type`: the status code, or the kind of failure. */
function errorType(event: {
  statusCode: number | null;
  error: string | null;
}): string {
  if (event.statusCode !== null) return String(event.statusCode);
  const error = event.error ?? "";
  if (error.startsWith("Timed out")) return "timeout";
  if (error.startsWith("Blocked")) return "blocked_address";
  return "_OTHER";
}
