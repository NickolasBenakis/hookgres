# Database schema

`migrate()` creates these tables in the `hookgres` schema (or the one set
with the `schema` option). You can query them directly for dashboards,
reports and monitoring. Write to them through the API, so the invariants
hold.

## `endpoints`

| Column                       | Type          | Notes                                            |
| ---------------------------- | ------------- | ------------------------------------------------ |
| `id`                         | `text`        | `ep_` followed by a time-sortable id.            |
| `tenant_id`                  | `text`        | Indexed.                                         |
| `url`                        | `text`        |                                                  |
| `description`                | `text`        | Nullable.                                        |
| `event_types`                | `text[]`      | `NULL` means every event type.                   |
| `secret`                     | `text`        | The current `whsec_` secret.                     |
| `previous_secret`            | `text`        | The secret before the last rotation.             |
| `previous_secret_expires_at` | `timestamptz` | When `previous_secret` stops signing.            |
| `metadata`                   | `jsonb`       | Defaults to `{}`.                                |
| `disabled`                   | `boolean`     |                                                  |
| `disabled_reason`            | `text`        |                                                  |
| `disabled_at`                | `timestamptz` | When it was last disabled automatically.         |
| `failing_since`              | `timestamptz` | Start of the current run of failures, or `NULL`. |
| `created_at`, `updated_at`   | `timestamptz` |                                                  |

## `messages`

| Column            | Type          | Notes                                                        |
| ----------------- | ------------- | ------------------------------------------------------------ |
| `id`              | `text`        | `msg_` followed by a time-sortable id. Sent as `webhook-id`. |
| `tenant_id`       | `text`        |                                                              |
| `event_type`      | `text`        |                                                              |
| `payload`         | `jsonb`       | `NULL` once redacted.                                        |
| `idempotency_key` | `text`        | Unique per tenant when set.                                  |
| `created_at`      | `timestamptz` | Sent as the envelope's `timestamp`.                          |
| `redacted_at`     | `timestamptz` | When `redactPayloads` cleared the payload, or `NULL`.        |

## `deliveries`

One row per message and endpoint.

| Column                     | Type          | Notes                                                                           |
| -------------------------- | ------------- | ------------------------------------------------------------------------------- |
| `id`                       | `text`        | `dlv_` followed by a random id.                                                 |
| `message_id`               | `text`        | References `messages`, deleted with it.                                         |
| `endpoint_id`              | `text`        | References `endpoints`, deleted with it.                                        |
| `status`                   | `text`        | `pending`, `delivering`, `succeeded` or `failed`.                               |
| `attempt_count`            | `integer`     | Attempts started so far.                                                        |
| `next_attempt_at`          | `timestamptz` | When a `pending` delivery is due.                                               |
| `locked_until`             | `timestamptz` | When a `delivering` claim expires.                                              |
| `lock_token`               | `uuid`        | Identifies the current claim, so a stale worker can't overwrite a newer result. |
| `last_error`               | `text`        | The most recent failure.                                                        |
| `created_at`, `updated_at` | `timestamptz` |                                                                                 |

## `attempts`

One row per HTTP request.

| Column           | Type          | Notes                                                |
| ---------------- | ------------- | ---------------------------------------------------- |
| `id`             | `text`        | `att_` followed by a random id.                      |
| `delivery_id`    | `text`        | References `deliveries`, deleted with it.            |
| `attempt_number` | `integer`     | Starts again at 1 after a replay.                    |
| `status_code`    | `integer`     | `NULL` for timeouts and network errors.              |
| `response_body`  | `text`        | First `responseBodyLimit` characters (4,096).        |
| `error`          | `text`        | For example `HTTP 500` or `Timed out after 15000ms`. |
| `duration_ms`    | `integer`     |                                                      |
| `created_at`     | `timestamptz` |                                                      |

## `schema_migrations`

Records which migrations have run. Don't edit it.

## Lifecycle of a delivery

```
send() ──► pending ──claim──► delivering ──2xx──► succeeded
              ▲                    │
              └── retry scheduled ◄┤ failure
                                   └─ last attempt failed, or endpoint disabled ──► failed

replayDelivery(): succeeded / failed ──► pending
```
