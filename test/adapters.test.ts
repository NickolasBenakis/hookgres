import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import { describe, expect, it } from "vitest";
import { fromKysely } from "../src/kysely.js";
import { fromPrisma, type PrismaTransactionClient } from "../src/prisma.js";
import { useHookgres } from "./helpers.js";

const ctx = useHookgres();

async function messageCount(): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "${ctx.schema}".messages`,
  );
  return rows[0]?.n ?? 0;
}

const input = {
  tenantId: "acme",
  eventType: "invoice.paid",
  payload: { invoice_id: "inv_1", nested: { snake_key: 1 } },
};

describe("hookgres/kysely", () => {
  function kysely() {
    // CamelCasePlugin would rename the columns send() reads if the adapter
    // didn't skip plugins.
    return new Kysely<Record<string, never>>({
      dialect: new PostgresDialect({ pool: ctx.pool }),
      plugins: [new CamelCasePlugin()],
    });
  }

  it("queues the webhook when the transaction commits", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: "https://example.com/" });
    const db = kysely();
    const result = await db
      .transaction()
      .execute((trx) => hw.send(input, { client: fromKysely(trx) }));
    expect(result.deliveryCount).toBe(1);
    expect(result.message.tenantId).toBe("acme");
    expect(result.message.payload).toEqual(input.payload);
    expect(await messageCount()).toBe(1);

    // The idempotency path's second query goes through the adapter too.
    const send = () =>
      db.transaction().execute((trx) =>
        hw.send(
          { ...input, idempotencyKey: "k" },
          {
            client: fromKysely(trx),
          },
        ),
      );
    await send();
    expect((await send()).deduplicated).toBe(true);
  });

  it("queues nothing when the transaction rolls back", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: "https://example.com/" });
    const db = kysely();
    await expect(
      db.transaction().execute(async (trx) => {
        await hw.send(input, { client: fromKysely(trx) });
        expect(await messageCount()).toBe(0); // not visible before commit
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await messageCount()).toBe(0);

    const trx = await db.startTransaction().execute();
    await hw.send(input, { client: fromKysely(trx) });
    await trx.rollback().execute();
    expect(await messageCount()).toBe(0);
  });
});

describe("hookgres/prisma", () => {
  /** Runs `fn` with a stand-in for Prisma's interactive transaction client. */
  async function transaction<T>(
    fn: (tx: PrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      const tx: PrismaTransactionClient = {
        async $queryRawUnsafe<T>(query: string, ...values: unknown[]) {
          return (await client.query(query, values)).rows as T;
        },
      };
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("queues the webhook when the transaction commits", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: "https://example.com/" });
    const result = await transaction((tx) =>
      hw.send(input, { client: fromPrisma(tx) }),
    );
    expect(result.deliveryCount).toBe(1);
    expect(await messageCount()).toBe(1);
  });

  it("queues nothing when the transaction rolls back", async () => {
    const hw = ctx.create();
    await expect(
      transaction(async (tx) => {
        await hw.send(input, { client: fromPrisma(tx) });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await messageCount()).toBe(0);
  });
});
