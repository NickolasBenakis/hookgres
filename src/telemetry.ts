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

  constructor(
    options: OpenTelemetryOptions,
    readStats: () => Promise<QueueStats>,
    onError: (error: unknown) => void,
  ) {
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
    const attributes: Attributes = { "hookgres.outcome": event.outcome };
    if (event.statusCode !== null) {
      attributes["http.response.status_code"] = event.statusCode;
    }
    if (event.outcome !== "succeeded") {
      attributes["error.type"] = errorType(event);
    }
    this.attempts.add(1, attributes);
    this.duration.record(event.durationMs / 1000, attributes);
  }

  recordEndpointDisabled(): void {
    this.disabled.add(1);
  }

  recordError(error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code;
    this.errors.add(1, {
      "error.type":
        typeof code === "string" && code.length <= 32
          ? code
          : error instanceof Error
            ? error.name
            : "_OTHER",
    });
  }

  /** Stops reading queue stats, so a closed instance doesn't query. */
  close(): void {
    if (this.observeQueue) {
      this.meter.removeBatchObservableCallback(this.observeQueue, this.gauges);
    }
  }
}

/** OpenTelemetry's `error.type`: the status code, or the kind of failure. */
function errorType(event: AttemptEvent): string {
  if (event.statusCode !== null) return String(event.statusCode);
  const error = event.error ?? "";
  if (error.startsWith("Timed out")) return "timeout";
  if (error.startsWith("Blocked")) return "blocked_address";
  return "_OTHER";
}
