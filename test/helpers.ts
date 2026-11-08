import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, afterEach, beforeAll, inject } from "vitest";
import { Hookgres, type HookgresOptions } from "../src/index.js";

export interface ReceivedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Receiver {
  url: string;
  requests: ReceivedRequest[];
  /** Decides the status code for each request (1-based request number). */
  respond: (n: number, request: ReceivedRequest) => number | Promise<number>;
  close(): Promise<void>;
}

export async function startReceiver(): Promise<Receiver> {
  const receiver = {
    url: "",
    requests: [] as ReceivedRequest[],
    respond: (() => 200) as Receiver["respond"],
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const request = {
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      receiver.requests.push(request);
      const status = await receiver.respond(receiver.requests.length, request);
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(`status ${status}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  receiver.url = `http://127.0.0.1:${port}/webhooks`;
  receiver.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return receiver;
}

/**
 * Per-file test context: a pool, a unique schema, and a factory for Hookgres
 * instances that are all stopped after each test.
 */
export function useHookgres() {
  const ctx = {
    pool: undefined as unknown as pg.Pool,
    schema: `hw_${randomBytes(6).toString("hex")}`,
    instances: [] as Hookgres[],
    create(options: Partial<HookgresOptions> = {}) {
      const hw = new Hookgres({
        pool: ctx.pool,
        schema: ctx.schema,
        retrySchedule: [0, 0],
        pollIntervalMs: 20,
        requestTimeoutMs: 2000,
        onError: (error) => {
          throw error;
        },
        ...options,
      });
      ctx.instances.push(hw);
      return hw;
    },
  };

  beforeAll(async () => {
    ctx.pool = new pg.Pool({
      connectionString: inject("databaseUrl"),
      max: 20,
    });
    await ctx.create().migrate();
  });

  afterEach(async () => {
    await Promise.all(ctx.instances.map((hw) => hw.stop()));
    ctx.instances = [];
    await ctx.pool.query(
      `TRUNCATE "${ctx.schema}".endpoints, "${ctx.schema}".messages CASCADE`,
    );
  });

  afterAll(async () => {
    await ctx.pool.query(`DROP SCHEMA IF EXISTS "${ctx.schema}" CASCADE`);
    await ctx.pool.end();
  });

  return ctx;
}

/** Runs the worker until `predicate` holds or the timeout expires. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timed out");
}

/** Calls runOnce() until a pass processes nothing. */
export async function drain(hw: Hookgres): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await hw.runOnce()) === 0) return;
  }
  throw new Error("drain did not settle");
}
