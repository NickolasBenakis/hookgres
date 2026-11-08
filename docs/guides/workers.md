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

On platforms without long-running processes, call `runOnce()` from a
scheduled function. It claims one batch, sends it, waits for every request,
and returns how many deliveries it handled.

```ts
// For example a route your platform's cron calls every minute.
export async function GET() {
  const deadline = Date.now() + 45_000; // stay under the function timeout
  let total = 0;
  let processed: number;
  do {
    processed = await hookgres.runOnce();
    total += processed;
  } while (processed > 0 && Date.now() < deadline);
  return Response.json({ delivered: total });
}
```

Each batch can take up to `requestTimeoutMs` (15 seconds) if a receiver is
slow, so leave that much headroom below your function's time limit.

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
