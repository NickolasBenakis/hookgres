# Configuration

```ts
const hookgres = new Hookgres({
  pool, // or connectionString
  schema: "hookgres",
  retrySchedule: DEFAULT_RETRY_SCHEDULE,
  requestTimeoutMs: 15_000,
  disableEndpointAfterMs: 5 * 24 * 60 * 60 * 1000,
  concurrency: 10,
  pollIntervalMs: 1_000,
  lockTimeoutMs: 45_000,
  secretRotationGraceMs: 24 * 60 * 60 * 1000,
  blockPrivateAddresses: false,
  fetch: globalThis.fetch,
  userAgent: "Hookgres/0.1",
  onError: console.error,
});
```

| Option                   | Default                       | Description                                                                                                                                                                                                       |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pool`                   | —                             | A `pg.Pool`. Hookgres never closes a pool it didn't create.                                                                                                                                                       |
| `connectionString`       | —                             | Used to create a pool when `pool` isn't given. `close()` ends it.                                                                                                                                                 |
| `schema`                 | `"hookgres"`                  | Postgres schema for the tables. Lowercase letters, digits and underscores, not starting with a digit, up to 63 characters.                                                                                        |
| `retrySchedule`          | 5s, 5m, 30m, 2h, 5h, 10h, 10h | Waits between attempts, in milliseconds. Attempts = length + 1.                                                                                                                                                   |
| `requestTimeoutMs`       | `15000`                       | How long to wait for a response before the attempt counts as failed.                                                                                                                                              |
| `disableEndpointAfterMs` | 5 days                        | Disable an endpoint after it has failed this long with no success. `null` never disables.                                                                                                                         |
| `concurrency`            | `10`                          | Deliveries each worker claims and sends at once. Also the batch size of `runOnce()`.                                                                                                                              |
| `pollIntervalMs`         | `1000`                        | How long an idle worker waits before checking again. Sends from the same process wake it sooner.                                                                                                                  |
| `lockTimeoutMs`          | `requestTimeoutMs` + 30s      | How long a claimed delivery stays locked before another worker may retry it after a crash. Must be greater than `requestTimeoutMs`.                                                                               |
| `secretRotationGraceMs`  | 24 hours                      | Default grace period for `rotateEndpointSecret`.                                                                                                                                                                  |
| `blockPrivateAddresses`  | `false`                       | `true` refuses to send to private and internal addresses; `{ allow: [...] }` does the same except for the listed IPs and CIDRs. See [Block internal addresses](/guides/production#block-internal-addresses-ssrf). |
| `fetch`                  | `globalThis.fetch`            | Custom fetch, for a proxy or tests. Can't be combined with `blockPrivateAddresses`.                                                                                                                               |
| `userAgent`              | `"Hookgres/0.1"`              | The `user-agent` header on every request.                                                                                                                                                                         |
| `onError`                | `console.error`               | Called with unexpected worker errors, like a lost database connection. Failed deliveries are not errors.                                                                                                          |

The constructor throws if neither `pool` nor `connectionString` is given, if
`schema` is invalid, if `retrySchedule` contains a negative or non-finite
number, if `lockTimeoutMs` isn't greater than `requestTimeoutMs`, if a
`blockPrivateAddresses.allow` entry isn't an IP address or CIDR, or if
`blockPrivateAddresses` is combined with `fetch` or with Node's env proxy
(`NODE_USE_ENV_PROXY` plus `HTTP_PROXY`/`HTTPS_PROXY`).

## Several instances

Different `schema` values give you fully separate queues in the same
database, for example one per environment or per product:

```ts
const billing = new Hookgres({ pool, schema: "hookgres_billing" });
const platform = new Hookgres({ pool, schema: "hookgres_platform" });
```

All workers that use the same schema should use the same options, especially
`retrySchedule`.
