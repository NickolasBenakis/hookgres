// The copy-paste recipes on docs/guides/orms.md, run against a real Postgres:
// each must queue a webhook when its transaction commits and nothing when it
// rolls back.
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import knex from "knex";
import postgres from "postgres";
import { Sequelize } from "sequelize";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { fromDrizzle } from "../docs/snippets/orms/drizzle.js";
import { fromKnex } from "../docs/snippets/orms/knex.js";
import { fromPostgresJs } from "../docs/snippets/orms/postgres-js.js";
import { fromSequelize } from "../docs/snippets/orms/sequelize.js";
import { fromTypeORM } from "../docs/snippets/orms/typeorm.js";
import type { Hookgres, Queryable } from "../src/index.js";
import { useHookgres } from "./helpers.js";

const ctx = useHookgres();
const url = inject("databaseUrl");

/** Runs `fn` in a transaction; throwing from `fn` rolls it back. */
type Transaction = <T>(fn: (client: Queryable) => Promise<T>) => Promise<T>;

// Drizzle changes the postgres.js client it's given (its serializers and date
// parsers), so the plain postgres.js recipe gets a client Drizzle never saw.
const sqlJs = postgres(url, { onnotice: () => {} });
const sqlJsForDrizzle = postgres(url, { onnotice: () => {} });
const drizzleJs = drizzlePostgresJs({ client: sqlJsForDrizzle });
const knexDb = knex({ client: "pg", connection: url });
const sequelize = new Sequelize(url, { logging: false });
const typeorm = new DataSource({ type: "postgres", url });

beforeAll(() => typeorm.initialize());
afterAll(async () => {
  await Promise.all([
    sqlJs.end(),
    sqlJsForDrizzle.end(),
    knexDb.destroy(),
    sequelize.close(),
    typeorm.destroy(),
  ]);
});

const recipes: [string, Transaction][] = [
  [
    "Drizzle (node-postgres)",
    (fn) =>
      drizzlePg({ client: ctx.pool }).transaction((tx) => fn(fromDrizzle(tx))),
  ],
  [
    "Drizzle (node-postgres, camelCase casing)",
    (fn) =>
      drizzlePg({ client: ctx.pool, casing: "camelCase" }).transaction((tx) =>
        fn(fromDrizzle(tx)),
      ),
  ],
  [
    "Drizzle (postgres.js)",
    (fn) => drizzleJs.transaction((tx) => fn(fromDrizzle(tx))),
  ],
  ["postgres.js", (fn) => sqlJs.begin((tx) => fn(fromPostgresJs(tx))) as never],
  ["Knex", (fn) => knexDb.transaction((trx) => fn(fromKnex(trx)))],
  [
    "Sequelize",
    (fn) => sequelize.transaction((t) => fn(fromSequelize(sequelize, t))),
  ],
  [
    "TypeORM",
    (fn) =>
      typeorm.transaction((manager) =>
        fn(fromTypeORM(manager.queryRunner as never)),
      ),
  ],
];

async function messages() {
  const { rows } = await ctx.pool.query<{ payload: unknown }>(
    `SELECT payload FROM "${ctx.schema}".messages`,
  );
  return rows;
}

/** What a recipe's client returns from the SQL `send()` runs, checked field by field. */
function expectMessage(
  message: Awaited<ReturnType<Hookgres["send"]>>["message"],
) {
  expect(message.id).toMatch(/^msg_/);
  expect(message.tenantId).toBe("acme");
  expect(message.eventType).toBe("invoice.paid");
  expect(message.payload).toEqual(input.payload);
  expect(message.createdAt).toBeInstanceOf(Date);
  expect(Number.isNaN(message.createdAt.getTime())).toBe(false);
}

const input = {
  tenantId: "acme",
  eventType: "invoice.paid",
  payload: { id: "in_1", lines: [{ amount: 100 }], note: "is it $1? yes" },
};

describe.each(recipes)("%s recipe", (_, transaction) => {
  it("queues the webhook when the transaction commits", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({
      tenantId: "acme",
      url: "https://example.com/",
      eventTypes: ["invoice.*"],
    });
    const result = await transaction((client) => hw.send(input, { client }));
    expect(result.deliveryCount).toBe(1);
    expectMessage(result.message);
    // Stored as a jsonb object, not a JSON string inside jsonb.
    expect(await messages()).toEqual([{ payload: input.payload }]);
  });

  it("works with notify on", async () => {
    const hw = ctx.create({ notify: true });
    await hw.createEndpoint({ tenantId: "acme", url: "https://example.com/" });
    const result = await transaction((client) => hw.send(input, { client }));
    expect(result.deliveryCount).toBe(1);
    expectMessage(result.message);
  });

  it("redacts a payload with no deliveries", async () => {
    const hw = ctx.create({ redactPayloads: true });
    const result = await transaction((client) => hw.send(input, { client }));
    expect(result.deliveryCount).toBe(0);
    expect(result.message.payload).toBeNull();
    expect(result.message.redactedAt).toBeInstanceOf(Date);
  });

  it("queues nothing when the transaction rolls back", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: "https://example.com/" });
    await expect(
      transaction(async (client) => {
        await hw.send(input, { client });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await messages()).toEqual([]);
  });

  it("deduplicates by idempotency key", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: "https://example.com/" });
    const send = () =>
      transaction((client) =>
        hw.send({ ...input, idempotencyKey: "k" }, { client }),
      );
    await send();
    const again = await send();
    expect(again.deduplicated).toBe(true);
    expectMessage(again.message);
    expect(await messages()).toHaveLength(1);
  });

  it("binds reordered, repeated and two-digit placeholders, and keeps a literal ?", async () => {
    const values = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const { rows } = await transaction((client) =>
      client.query(
        `SELECT $2::text AS x, $1::text AS y, $2::text AS z, $10::text AS ten,
                concat($3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text) AS rest,
                '?' AS q`,
        values,
      ),
    );
    expect(rows).toEqual([
      { x: "b", y: "a", z: "b", ten: "j", rest: "cdefghi", q: "?" },
    ]);
  });
});
