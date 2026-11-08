# Playground

The playground is a small web app that runs Hookgres against three fake
customer endpoints, so you can watch every part of the delivery lifecycle in
your browser.

## Run it

You need Docker and Git:

```sh
git clone https://github.com/NickolasBenakis/hookgres
cd hookgres
docker compose up
```

Then open [http://localhost:3000](http://localhost:3000).

`docker compose up` starts Postgres 18 and builds the playground from your
checkout. If port 3000 or 5432 is taken, pick others:
`PLAYGROUND_PORT=3100 POSTGRES_PORT=5433 docker compose up`.

To run it without Docker against your own Postgres, use Node 22.18+:

```sh
pnpm install
DATABASE_URL=postgres://... pnpm playground
```

## What to try

The playground creates tenant `acme` with three endpoints. Each one is a
route in the same process that verifies the signature like a real receiver
would:

| Endpoint  | Subscribes to                      | Behaviour                                |
| --------- | ---------------------------------- | ---------------------------------------- |
| `healthy` | every event                        | Answers `204`.                           |
| `flaky`   | `invoice.paid`, `invoice.refunded` | Answers `503` to the first two attempts. |
| `down`    | `invoice.paid`                     | Always answers `500`.                    |

To make things visible quickly, retries happen after 2s, 5s and 10s (4
attempts in total), and an endpoint is disabled after 15 seconds of failures.
The real defaults are 5s, 5m, 30m, 2h, 5h, 10h and 10h, and 5 days.

1. **Send `invoice.paid`.** Three deliveries appear. `healthy` succeeds at
   once, `flaky` succeeds on its third attempt, and `down` fails after four.
2. **Click a delivery** to see each attempt's status code, response and
   duration, and the exact headers the receiver got. The `webhook-id` is the
   same on every attempt.
3. **Send `customer.created`.** Only `healthy` subscribes to it, so only one
   delivery is created.
4. **Set an idempotency key** and send twice. The second send returns the
   first message instead of creating a new one.
5. **Watch `down` after its last attempt.** Its attempts span 17 seconds, so it gets disabled automatically,
   and new events skip it. Click **Re-enable** to bring it back.
6. **Replay** a finished delivery to send it again with a fresh retry
   schedule.
7. **Rotate a secret.** Webhooks keep verifying, because during the grace
   period Hookgres signs with both the old and the new secret.

**Reset playground** drops the `hookgres_playground` schema and starts over.

## How it's built

The playground is about 300 lines in
[`examples/playground/server.ts`](https://github.com/NickolasBenakis/hookgres/blob/main/examples/playground/server.ts),
using only the public API plus two plain SQL queries against Hookgres's
tables. It's also a starting point if you want to build your own delivery
dashboard.
