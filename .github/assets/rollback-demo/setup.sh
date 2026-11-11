# Hidden setup for demo.tape: env vars, psql and reset helpers, and a clean database.
# Run it from a copy of this folder after `npm install bullmq hookgres pg`, with:
#   docker run -d --rm --name hookgres-demo-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55433:5432 postgres:18-alpine
#   docker run -d --rm --name hookgres-demo-redis -p 127.0.0.1:56379:6379 redis:7-alpine
export PS1='$ ' DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres REDIS_URL=redis://127.0.0.1:56379 WEBHOOK_SECRET=$(node -e 'import("hookgres").then((m) => console.log(m.generateSecret()))') BAT_THEME='Visual Studio Dark+'
psql() { docker exec -i hookgres-demo-pg psql -U postgres "$@"; }
reset() {
  docker exec hookgres-demo-redis redis-cli FLUSHALL >/dev/null
  psql -q -c "DROP SCHEMA IF EXISTS hookgres CASCADE; DROP TABLE IF EXISTS invoices, ledger; CREATE TABLE invoices (id text PRIMARY KEY, status text); INSERT INTO invoices VALUES ('in_123','open'),('in_124','open'); CREATE TABLE ledger (invoice_id text PRIMARY KEY); INSERT INTO ledger VALUES ('in_124');" >/dev/null 2>&1
}
reset
