---
"hookgres": patch
---

Fix endpoint auto-disable: when an endpoint is disabled after failing for `disableEndpointAfterMs`, its queued deliveries are now marked `failed` right away, as documented, instead of staying `pending` until their next retry time (up to 10 hours later, or for good with no worker running) and being resent if the endpoint was re-enabled first. The attempt that disables the endpoint, and any attempt recorded after it was disabled automatically, now report `onAttempt` outcome `"failed"` instead of `"retrying"`. Manually disabled endpoints are unchanged. `attemptCount` no longer counts deliveries failed without an HTTP request (endpoint disabled, payload redacted, or out of attempts after a worker crash).
