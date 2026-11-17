---
"hookgres": minor
---

Add three delivery options for receivers with their own conventions, such as MCP Events webhook mode: `envelope: false` sends the payload itself as the body, `deliveryHeaders` adds request headers per attempt, and `nonRetryableStatuses` fails a delivery at once on statuses like `410` without counting against the endpoint's health.
