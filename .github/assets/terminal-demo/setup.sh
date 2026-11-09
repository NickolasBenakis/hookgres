# Hidden setup for demo.tape: env vars, a psql wrapper for the Docker Postgres, and a clean schema.
# Start Postgres first: docker run -d --name hookgres-demo-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55433:5432 postgres:18-alpine
export PS1='$ ' DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres WEBHOOK_SECRET=$(node -e 'import("hookgres").then((m) => console.log(m.generateSecret()))') BAT_THEME='Visual Studio Dark+'
psql() { docker exec -i hookgres-demo-pg psql -U postgres "$@"; }
psql -q -c "DROP SCHEMA IF EXISTS hookgres CASCADE; DROP TABLE IF EXISTS invoices; CREATE TABLE invoices (id text PRIMARY KEY, status text); INSERT INTO invoices VALUES ('in_123','open'),('in_124','open');" >/dev/null 2>&1
