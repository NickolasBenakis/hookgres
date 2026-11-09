---
"hookgres": minor
---

Add the opt-in `blockPrivateAddresses` option, which refuses to send webhooks to private and internal addresses (checked at endpoint creation and on every delivery, after DNS), and export `isPrivateAddress`.
