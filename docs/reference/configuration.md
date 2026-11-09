# Configuration

```ts
const hookgres = new Hookgres({
  pool, // or connectionString
  schema: "hookgres",
  retrySchedule: DEFAULT_RETRY_SCHEDULE,
  retryJitter: 0.1,
  requestTimeoutMs: 15_000,
  disableEndpointAfterMs: 5 * 24 * 60 * 60 * 1000,
  concurrency: 10,
  pollIntervalMs: 1_000,
  notify: false,
  lockTimeoutMs: 45_000,
  secretRotationGraceMs: 24 * 60 * 60 * 1000,
  blockPrivateAddresses: false,
  fetch: globalThis.fetch,
  userAgent: "Hookgres/0.1",
  onError: console.error,
  onAttempt: undefined,
  onEndpointDisabled: undefined,
});
```

| Option                   | Default                       | Description                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pool`                   | —                             | A `pg.Pool`. Hookgres never closes a pool it didn't create.                                                                                                                                                                                        |
| `connectionString`       | —                             | Used to create a pool when `pool` isn't given. `close()` ends it.                                                                                                                                                                                  |
| `schema`                 | `"hookgres"`                  | Postgres schema for the tables. Lowercase letters, digits and underscores, not starting with a digit, up to 63 characters.                                                                                                                         |
| `retrySchedule`          | 5s, 5m, 30m, 2h, 5h, 10h, 10h | Waits between attempts, in milliseconds. Attempts = length + 1.                                                                                                                                                                                    |
| `retryJitter`            | `0.1`                         | Spreads each wait randomly by up to this fraction: `0.1` turns 60s into 54s to 66s. `0` turns it off. Between 0 and 1.                                                                                                                             |
| `requestTimeoutMs`       | `15000`                       | How long to wait for a response before the attempt counts as failed.                                                                                                                                                                               |
| `disableEndpointAfterMs` | 5 days                        | Disable an endpoint after it has failed this long with no success. `null` never disables.                                                                                                                                                          |
| `concurrency`            | `10`                          | Deliveries each worker claims and sends at once. Also the batch size of `runOnce()`.                                                                                                                                                               |
| `pollIntervalMs`         | `1000`                        | How long an idle worker waits before checking again. Sends from the same process wake it sooner.                                                                                                                                                   |
| `notify`                 | `false`                       | Wake workers in every process right after a `send()` commits, with LISTEN/NOTIFY. Each started worker holds one pool connection. Not for PgBouncer in transaction mode. See [Instant wake-up](/guides/workers#instant-wake-up-with-listen-notify). |
| `lockTimeoutMs`          | `requestTimeoutMs` + 30s      | How long a claimed delivery stays locked before another worker may retry it after a crash. Must be greater than `requestTimeoutMs`.                                                                                                                |
| `secretRotationGraceMs`  | 24 hours                      | Default grace period for `rotateEndpointSecret`.                                                                                                                                                                                                   |
| `blockPrivateAddresses`  | `false`                       | `true` refuses to send to private and internal addresses; `{ allow: [...] }` does the same except for the listed IPs and CIDRs. See [Block internal addresses](/guides/production#block-internal-addresses-ssrf).                                  |
| `fetch`                  | `globalThis.fetch`            | Custom fetch, for a proxy or tests. With `blockPrivateAddresses`, only endpoint URLs are checked; delivery uses this fetch as is.                                                                                                                  |
| `userAgent`              | `"Hookgres/0.1"`              | The `user-agent` header on every request.                                                                                                                                                                                                          |
| `onError`                | `console.error`               | Called with unexpected worker errors, like a lost database connection. Failed deliveries are not errors.                                                                                                                                           |
| `onAttempt`              | —                             | Called with an [`AttemptEvent`](/reference/api#types) after every HTTP attempt. See [Metrics and tracing](/guides/production#metrics-and-tracing).                                                                                                 |
| `onEndpointDisabled`     | —                             | Called with an [`EndpointDisabledEvent`](/reference/api#types) when Hookgres disables an endpoint after `disableEndpointAfterMs`.                                                                                                                  |

Errors thrown by `onAttempt` or `onEndpointDisabled`, and promises they
reject, never affect delivery. Hookgres reports them with
`process.emitWarning` (code `HOOKGRES_HOOK_ERROR`).

The constructor throws if neither `pool` nor `connectionString` is given, if
`schema` is invalid, if `retrySchedule` contains a negative or non-finite
number, if `retryJitter` isn't between 0 and 1, if `lockTimeoutMs` isn't greater than `requestTimeoutMs`, or if a
`blockPrivateAddresses.allow` entry isn't an IP address or CIDR.

With `blockPrivateAddresses` on, it emits a process warning (once per
instance) if a custom `fetch` is given (`HOOKGRES_SSRF_CUSTOM_FETCH`) or if
Node's env proxy is set up (`NODE_USE_ENV_PROXY` plus `HTTP_PROXY` or
`HTTPS_PROXY`), which the guard ignores (`HOOKGRES_SSRF_ENV_PROXY`).

## Several instances

Different `schema` values give you fully separate queues in the same
database, for example one per environment or per product:

```ts
const billing = new Hookgres({ pool, schema: "hookgres_billing" });
const platform = new Hookgres({ pool, schema: "hookgres_platform" });
```

All workers that use the same schema should use the same options, especially
`retrySchedule`.
