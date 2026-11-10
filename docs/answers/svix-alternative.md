# A Svix alternative without a separate service

[Svix](https://www.svix.com) is a good webhook service. If you'd rather not
add a vendor or run another server, and your app is Node.js on Postgres,
[Hookgres](https://hookgres.dev) gives you the sending side as a library that
uses your existing database.

## How they differ

|                                   | Hookgres                                                                 | Svix                                                       |
| --------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| What it is                        | A TypeScript library                                                     | A hosted API, or a self-hosted Rust server                 |
| Where it runs                     | Your app, your Postgres                                                  | Their cloud, or your server plus Postgres (Redis optional) |
| Part of your database transaction | Yes                                                                      | No, a separate API call                                    |
| Signatures                        | Standard Webhooks                                                        | Standard Webhooks                                          |
| Retries                           | About 28 hours, configurable                                             | Yes                                                        |
| Delivery log                      | Rows in your database                                                    | In their dashboard and API                                 |
| Customer portal                   | Build on the delivery log ([Pro waitlist](https://hookgres.dev/#portal)) | Included                                                   |
| Price                             | Free, MIT                                                                | Free tier, then per message or plan                        |
| Languages                         | Node.js / TypeScript                                                     | SDKs for many languages                                    |

## When Svix is the better choice

- You want a hosted customer portal today.
- Your backend isn't Node.js, or several services in different languages
  send webhooks.
- You'd rather not have webhook traffic touch your database.

## When Hookgres is the better choice

- You want webhooks to commit with your data, with no outbox to build. With
  any external service, a crash between "saved" and "sent" loses the event.
- You don't want another service, vendor or subprocessor. Payloads and logs
  stay in your database.
- You want to query deliveries with SQL, for support or a customer-facing log.

## Switching

Both use Standard Webhooks signatures and `whsec_` secrets, so receivers keep
working. The [migration guide](/guides/migrating-from-svix) maps every concept
and call.

```sh
npm install hookgres pg
```

Next: [Getting started](/getting-started).
