# Running workers

Something has to send the queued deliveries. Hookgres gives you two ways:
a background loop with `start()`, or one batch at a time with `runOnce()`.

## A background loop

```ts
hookgres.start();
```

The loop claims up to `concurrency` due deliveries (10 by default), sends them
in parallel, records the results, and repeats. When there's nothing to do, it
sleeps for `pollIntervalMs` (1 second by default). A `send()` from the same
process wakes it immediately.

### Instant wake-up with LISTEN/NOTIFY

When your web servers send and separate processes deliver, a webhook waits up
to `pollIntervalMs` before a worker notices it. Turn on `notify` to wake
workers right away:

```ts
const hookgres = new Hookgres({ pool, notify: true });
```

Set it on the instances that call `send()` and on the ones that call
`start()`. With it on:

- `send()` also runs `pg_notify('<schema>_wake', '')` (`hookgres_wake` by
  default) in the same statement as the insert. Postgres delivers the
  notification when the transaction commits, so a `send()` inside your own
  transaction wakes workers on commit, and a rollback wakes no one.
  `replayDelivery()` notifies too.
- Each worker started with `start()` holds one connection from the pool that
  runs `LISTEN` and wakes the loop on every notification. Count it when you
  size the pool; the constructor throws if the pool's `max` is below 2.
  `stop()` closes it.
- Polling keeps running as a fallback. If the listening connection drops,
  the worker reports it to `onError` and reconnects, waiting 0.5 seconds at
  first and doubling up to 30 seconds. Deliveries keep going out on the poll
  interval in the meantime.

Leave it off if you connect through PgBouncer in transaction mode or a proxy
that doesn't support `LISTEN`. There `LISTEN` either fails or silently
receives nothing; delivery still works, only without the faster wake-up.
`runOnce()` doesn't listen.

At very high send rates, polling can be the better choice. Postgres commits
transactions that sent a notification one at a time, and every notification
wakes every worker, so each `send()` costs one claim query per worker.

You can run the loop in your web server process or in a separate worker
process. Both work. A separate process keeps slow receivers from competing
with your web requests for CPU and connections.

### Shutting down

```ts
process.on("SIGTERM", async () => {
  await hookgres.stop(); // waits for in-flight requests (up to requestTimeoutMs)
  await pool.end();
  process.exit(0);
});
```

`stop()` stops claiming new work and waits for the requests in flight. If the
process is killed before they finish, those deliveries stay locked until
`lockTimeoutMs` passes (45 seconds by default), then another worker retries
them.

If you passed `connectionString` instead of `pool`, call `close()` instead.
It stops the worker and closes the pool Hookgres created.

## Many workers

Run `start()` in as many processes as you like. Workers claim deliveries
with `FOR UPDATE SKIP LOCKED`, so they never pick the same delivery at the
same time and don't block each other.

Throughput is mostly limited by how fast receivers respond. Each worker sends
at most `concurrency` requests at once, so with 15-second timeouts and slow
receivers, raise `concurrency` or add workers.

Workers don't hold a database connection while waiting for an HTTP response.
Each claim and each result is a short query, so a pool of the default size (10)
is plenty for most setups.

## Cron or serverless

On platforms without long-running processes, call `drain()` from a
scheduled function. It calls `runOnce()`, which claims one batch, sends it
and waits for every request, until nothing is due or time runs out, and
returns how many deliveries it handled.

```ts
// For example a route your platform's cron calls every minute,
// with a 60-second function time limit.
export async function GET() {
  const delivered = await hookgres.drain({ timeoutMs: 50_000 });
  return Response.json({ delivered });
}
```

Each batch can take up to `requestTimeoutMs` (15 seconds) if a receiver is
slow, so `drain()` only starts a batch while at least that much time, plus a
second, is left (or as long as the slowest batch so far took, if longer). It returns within `timeoutMs`; set it a few seconds below
your function's time limit. A `timeoutMs` shorter than `requestTimeoutMs`
plus a second throws, since no batch could run.

With a one-minute cron, webhooks go out up to a minute late, and a 5-second
retry becomes a 1-minute retry. If that matters, also call `runOnce()` right
after important `send()` calls. Don't call `start()` in serverless functions:
the loop stops when the function is frozen.

Run `migrate()` from your deploy step rather than in every function
invocation.

## Errors

Unexpected errors in the loop, such as a lost database connection, go to
`onError` (`console.error` by default), and the loop keeps going. Failed
deliveries are not errors. They are recorded as attempts and retried.

```ts
new Hookgres({
  pool,
  onError: (error) => logger.error({ err: error }, "hookgres worker error"),
});
```
