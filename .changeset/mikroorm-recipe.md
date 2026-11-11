---
"hookgres": patch
---

The package's `AGENTS.md` now lists `fromMikroORM` among the tested ORM wrappers in [Using your ORM's transaction](https://hookgres.dev/docs/guides/orms#mikroorm). The recipe wraps `fromKysely(em.getKysely())`, so `send()` joins an `em.transactional()` transaction in MikroORM 7.
