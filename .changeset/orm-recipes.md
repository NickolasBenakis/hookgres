---
"hookgres": patch
---

`send()` works on a `client` whose driver returns timestamps as strings, such as a Drizzle transaction: `message.createdAt` and `message.redactedAt` are now always `Date` objects. Before, they came back as strings on those clients.

The package's `AGENTS.md` also points coding agents to [Using your ORM's transaction](https://hookgres.dev/docs/guides/orms), which has tested wrappers of a few lines for Drizzle, postgres.js, Knex, Sequelize and TypeORM, so `send()` joins those transactions too.
