# Database cost

Hookgres stores webhooks in your Postgres, so each one costs your database
some queries, some disk and some WAL. This page gives measured numbers, so
you can work out what your volume costs before you ship it.

## What one webhook costs

Measured with `pnpm db-cost` from the repository: 10,000 webhooks, one
endpoint, a 205-byte JSON payload, and a receiver that answers `204` with an
empty body on the first try. One worker with default options delivers them.

| Per webhook          | `send()` | Delivery | Total      |
| -------------------- | -------- | -------- | ---------- |
| SQL statements       | 1        | 1.1      | **2.1**    |
| WAL                  | 1.6 KB   | 1.7 KB   | **3.3 KB** |
| Table and index size |          |          | **1.3 KB** |

Statements and size barely moved between runs; WAL ranged from 3.2 to
3.5 KB.

The size splits into about 500 bytes in `messages`, 490 in `deliveries` and
290 in `attempts`, indexes included. It's the growth of
`pg_total_relation_size()` divided by the number of webhooks, measured on a
second batch after a `VACUUM`. Each delivery row is written three times
(queued, claimed, done), and vacuum lets new rows reuse the space of the old
versions, as autovacuum does in a running database. Starting from empty
tables, without vacuum, it's 1.32 KB.

Where the statements come from:

- `send()` is one `INSERT` that writes the message and one delivery per
  matching endpoint.
- Each delivery attempt writes its result in one statement: the delivery's
  new status and the attempt row.
- A worker claims up to `concurrency` (10) due deliveries in one statement.
  With a backlog, that's 0.1 claims per webhook. When webhooks trickle in
  one at a time, each claim finds one, so it's 3 statements per webhook.

WAL depends on your checkpoint settings, because the first change to a page
after each checkpoint writes the whole page. Treat it as a ballpark.

Measured on an Apple M3 Max with 36 GB of RAM, against Postgres 18.6 in
Docker with default settings.

## What an idle worker costs

A worker that has nothing to do polls once per `pollIntervalMs` (1 second
by default):

| Idle worker, empty queue | Statements per minute | Rows written |
| ------------------------ | --------------------- | ------------ |
| Default options          | 60                    | 0            |
| `notify: true`           | 62                    | 0            |

Each poll is one claim query that finds nothing and writes nothing. With
`notify: true` the worker also holds one connection open for `LISTEN`, and
polling keeps running as a fallback. The 2 extra statements run once, at
`start()`: the `LISTEN` and one claim to catch up.

That's 86,400 small queries a day per worker. To poll less, turn on `notify`
so new webhooks wake the worker right away, and raise `pollIntervalMs`:

```ts
const hookgres = new Hookgres({ pool, notify: true, pollIntervalMs: 10_000 });
```

That polls 6 times a minute instead of 60. Retries are only found by
polling, so they can go out up to 10 seconds after they're due. See
[LISTEN/NOTIFY](/guides/workers#instant-wake-up-with-listen-notify) for when
`notify` doesn't work, such as behind PgBouncer in transaction mode.

## At 1 million webhooks a day

Scaling the numbers above:

| Per day                  | Amount                      |
| ------------------------ | --------------------------- |
| SQL statements           | 2.1 million (24 per second) |
| New table and index data | 1.3 GB                      |
| WAL                      | 3.3 GB                      |

The table data stays until you delete it, so with 30 days of history you'd
keep about 38 GB. WAL is recycled after checkpoints, but it also goes to
replicas, backups and point-in-time recovery storage, so it counts there.

Your numbers change with:

- **Payload size.** The payload is stored once per message. Larger payloads
  add their size, and Postgres compresses large `jsonb` values.
- **Endpoints per event.** Each matching endpoint adds a delivery and its
  attempts.
- **Failures.** Each retry adds an attempt row and another round of
  statements.
- **Response bodies.** The receiver here answered with an empty body. Each
  attempt stores up to 4,096 characters of the response.

## Keeping it small

- **Delete old rows.** Run [`cleanup()`](/guides/production#clean-up-old-rows)
  from a daily job. With 7 days of history instead of 30, the example above
  keeps about 9 GB.
- **Send ids, not documents.** A small payload, such as
  `{ invoiceId: "inv_123" }`, keeps `messages` small. Receivers fetch the
  details from your API.
- **Store less of each response.** `responseBodyLimit: 0` stores no response
  bodies, and `256` stores just the start. See
  [Limit stored response bodies](/guides/privacy#limit-stored-response-bodies).
- **Clear payloads after delivery.** `redactPayloads: true` sets each
  payload to `null` once it's delivered. That costs more work, not less:
  `send()` without your own client runs in a `BEGIN`/`COMMIT`, and each
  delivered message gets one more `UPDATE`. Postgres reuses the freed space
  after vacuum, but the table files don't shrink. Use it for privacy, and
  `cleanup()` for size. See
  [Clear payloads after delivery](/guides/privacy#clear-payloads-after-delivery).
- **Run workers on other machines.** Workers spend most of their time
  waiting on HTTP, and hold no connection while they wait. Running them in
  separate processes, away from your database host and web servers, keeps
  that CPU and network traffic off them. The database work per webhook
  stays the same.

## Measure it yourself

The script is in the repository at `scripts/db-cost.ts`:

```sh
pnpm db-cost                    # starts Postgres 18 in Docker
DATABASE_URL=postgres://... pnpm db-cost
COST_N=50000 COST_IDLE_SECONDS=120 pnpm db-cost
```

It creates and then drops a `hookgres_cost` schema. Run it against a
database nothing else is writing to: WAL is counted for the whole server.
Statements are counted on the client, so they include everything Hookgres
sends and nothing else.
