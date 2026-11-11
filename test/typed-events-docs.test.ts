// Runs the code in docs/guides/typed-events.md (docs/snippets/typed-events)
// as written. The snippets use the default "hookgres" schema, so this file
// gets its own database.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createHookgres as createTypeOnly } from "../docs/snippets/typed-events/event-map.js";
import {
  type AppHookgres,
  createHookgres,
} from "../docs/snippets/typed-events/hookgres.js";
import { POST } from "../docs/snippets/typed-events/receiver.js";
import { markInvoicePaid } from "../docs/snippets/typed-events/send.js";
import { generateSecret, HookgresValidationError, sign } from "../src/index.js";

const database = `typed_docs_${randomBytes(4).toString("hex")}`;
let admin: pg.Pool;
let pool: pg.Pool;
let hookgres: AppHookgres;

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: inject("databaseUrl") });
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(inject("databaseUrl"));
  url.pathname = `/${database}`;
  pool = new pg.Pool({ connectionString: url.toString() });
  await pool.query(
    "CREATE TABLE invoices (id text PRIMARY KEY, status text NOT NULL)",
  );
  hookgres = createHookgres(pool);
  await hookgres.migrate();
});

afterAll(async () => {
  // pool.end() can resolve while a client is still closing; DROP DATABASE
  // WITH (FORCE) then terminates it, which would surface as an unhandled
  // pool error.
  pool.on("error", () => {});
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
});

async function invoiceStatus(id: string): Promise<string | undefined> {
  const { rows } = await pool.query(
    "SELECT status FROM invoices WHERE id = $1",
    [id],
  );
  return rows[0]?.status;
}

async function messagesFor(invoiceId: string): Promise<unknown[]> {
  const { rows } = await pool.query(
    "SELECT payload FROM hookgres.messages WHERE payload->>'invoiceId' = $1",
    [invoiceId],
  );
  return rows.map((row) => row.payload);
}

describe("typed events docs", () => {
  it("markInvoicePaid commits the update and the webhook together", async () => {
    await pool.query("INSERT INTO invoices VALUES ('in_ok', 'open')");
    await hookgres.createEndpoint({
      tenantId: "acme",
      url: "https://example.com/webhooks",
      eventTypes: ["invoice.*"],
    });
    await markInvoicePaid(hookgres, "acme", "in_ok", 4200);
    expect(await invoiceStatus("in_ok")).toBe("paid");
    expect(await messagesFor("in_ok")).toEqual([
      { invoiceId: "in_ok", amount: 4200 },
    ]);
  });

  it("markInvoicePaid rolls back and logs the issues for an invalid payload", async () => {
    await pool.query("INSERT INTO invoices VALUES ('in_bad', 'open')");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const error = await markInvoicePaid(
        hookgres,
        "acme",
        "in_bad",
        "4200" as unknown as number, // e.g. an unparsed form field
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HookgresValidationError);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/payload\.amount failed the schema/),
        (error as HookgresValidationError).issues,
      );
    } finally {
      warn.mockRestore();
    }
    // Rolled back: the invoice is still open and nothing was queued.
    expect(await invoiceStatus("in_bad")).toBe("open");
    expect(await messagesFor("in_bad")).toEqual([]);
  });

  it("the receiver verifies and narrows a delivered event", async () => {
    const secret = generateSecret();
    const id = "msg_docs";
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: "invoice.paid",
      timestamp: new Date().toISOString(),
      data: { invoiceId: "in_ok", amount: 4200 },
    });
    const request = () =>
      new Request("https://example.com/webhooks", {
        method: "POST",
        headers: {
          "webhook-id": id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": sign(secret, id, timestamp, body),
        },
        body,
      });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await POST(request(), secret);
      expect(response.status).toBe(204);
      expect(log).toHaveBeenCalledWith("Invoice in_ok paid: 4200");
    } finally {
      log.mockRestore();
    }
    await expect(POST(request(), generateSecret())).rejects.toThrow();
  });

  it("the event map version sends without runtime validation", async () => {
    const typeOnly = createTypeOnly(pool);
    const { message } = await typeOnly.send({
      tenantId: "acme",
      eventType: "invoice.voided",
      payload: { invoiceId: "in_void" },
    });
    expect(message.payload).toEqual({ invoiceId: "in_void" });
    // Only the compiler checks it: a cast payload is stored as given.
    const unchecked = await typeOnly.send({
      tenantId: "acme",
      eventType: "invoice.voided",
      payload: { invoiceId: 1 } as unknown as { invoiceId: string },
    });
    expect(unchecked.message.payload).toEqual({ invoiceId: 1 });
  });
});
