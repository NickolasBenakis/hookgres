# Hidden setup for demo.tape: env vars, psql and reset helpers, and a clean database.
# Run `vhs demo.tape` from a copy of this folder after `npm install bullmq ioredis hookgres pg`, with:
#   docker run -d --rm --name hookgres-demo-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55433:5432 postgres:18-alpine
#   docker run -d --rm --name hookgres-demo-redis -p 127.0.0.1:56379:6379 redis:7-alpine
# The landing page plays it at 2x, with the last frame as the poster:
#   ffmpeg -i rollback-demo.mp4 -filter:v "setpts=0.5*PTS" -r 30 -an -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 26 -movflags +faststart site/media/rollback-demo-2x.mp4
#   ffmpeg -sseof -0.6 -i rollback-demo.mp4 -frames:v 1 -q:v 4 site/media/rollback-demo-poster.jpg
export PS1='$ ' DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres REDIS_URL=redis://127.0.0.1:56379 WEBHOOK_SECRET=$(node -e 'import("hookgres").then((m) => console.log(m.generateSecret()))') BAT_THEME='Visual Studio Dark+'
psql() { docker exec -i hookgres-demo-pg psql -U postgres "$@"; }
reset() {
  docker exec hookgres-demo-redis redis-cli FLUSHALL >/dev/null
  psql -q -c "DROP SCHEMA IF EXISTS hookgres CASCADE; DROP TABLE IF EXISTS invoices, ledger; CREATE TABLE invoices (id text PRIMARY KEY, status text); INSERT INTO invoices VALUES ('in_123','open'),('in_124','open'); CREATE TABLE ledger (invoice_id text PRIMARY KEY); INSERT INTO ledger VALUES ('in_124');" >/dev/null 2>&1
}
reset
