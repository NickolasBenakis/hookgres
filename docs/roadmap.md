# Roadmap

What's planned for Hookgres, roughly in order. There are no dates: items ship
when they're ready and tested on every supported Postgres and Node.js version.
Until 1.0, minor versions (0.2, 0.3) may include breaking changes, always listed
in the [changelog](https://github.com/NickolasBenakis/hookgres/blob/main/CHANGELOG.md).

Something missing, or something you need sooner?
[Open an issue](https://github.com/NickolasBenakis/hookgres/issues/new) and
describe your use case. Use cases decide the order more than anything else.

## Shipped in 0.1

- Signed deliveries using [Standard Webhooks](https://www.standardwebhooks.com).
- `send()` inside your own transaction, with idempotency keys.
- 8 attempts over about 28 hours, with any number of workers.
- Endpoints per tenant with event-type filters, auto-disabled after 5 days of
  failures.
- Secret rotation with a grace period.
- A delivery log of every attempt, and replay.

## Now: 0.2

The gaps teams hit first when they put Hookgres in production.

| Item                 | What it means                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in SSRF guard  | An opt-in option that refuses to deliver to private, loopback and link-local addresses, checked after DNS resolution. Today you [plug in your own](/guides/production#block-internal-addresses-ssrf). |
| Cleanup helper       | One call to delete finished messages, deliveries and attempts older than a retention period, instead of writing the [cleanup query](/guides/production#clean-up-old-rows) yourself.                   |
| Retry jitter         | A small random offset on each retry, so endpoints that fail together don't all retry at the same moment.                                                                                              |
| Wildcard event types | Subscribe an endpoint to `invoice.*` instead of listing every invoice event.                                                                                                                          |

## Next

| Item                       | What it means                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delivery hooks and metrics | Callbacks for every attempt, success and failure, and an OpenTelemetry example, so the backlog and failure rate reach your dashboards.                       |
| Ordered delivery           | Opt-in, per endpoint: the next webhook waits until the previous one succeeds. Today [delivery isn't strictly ordered](/faq#are-webhooks-delivered-in-order). |
| Faster wake-up             | Optional `LISTEN/NOTIFY`, so webhooks sent inside a transaction go out right after the commit instead of on the next poll.                                   |

## Exploring

Ideas we're researching. They may change shape or not ship at all.

| Item                    | What it means                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Send from any language  | A SQL function, so Python, Go, Ruby or plain SQL can queue webhooks in the same database, while a Node.js worker delivers them.             |
| Customer portal         | A UI your customers use to add endpoints, see deliveries and replay failures. Likely a separate package, so the core stays a small library. |
| Payload transformations | Reshape the body per endpoint, for receivers that expect a different format.                                                                |
| Bun and Deno            | Run the test suite on both and support them officially. Today they [aren't tested](/faq#does-it-run-on-bun-or-deno).                        |

## Road to 1.0

1.0 means the API and the database schema are stable, and breaking changes
only come with a major version and an upgrade guide. Before that:

- The 0.2 and Next items above have shipped.
- Several teams run Hookgres in production and the API has stopped changing.
- Every schema change since 0.1 upgrades in place through `migrate()`.

## Not planned

- **Other databases.** Hookgres is built on Postgres features (`FOR UPDATE SKIP LOCKED`,
  `jsonb`, transactions you already use). Supporting MySQL or SQLite would mean a
  different library.
- **A hosted service.** Hookgres runs in your infrastructure. That's the point.
- **Receiving webhooks.** Hookgres sends webhooks. To verify ones you receive,
  use `verifyWebhook` or any Standard Webhooks library.
