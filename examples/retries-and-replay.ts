/**
 * Retries, the delivery log, and replay. The receiver fails the first two
 * attempts, so Hookgres retries until it succeeds; then we replay it.
 *
 *   docker compose up -d postgres && pnpm build && node examples/retries-and-replay.ts
 */
import { Hookgres } from "hookgres";
import pg from "pg";
import { databaseUrl, startReceiver } from "./receiver.ts";

const pool = new pg.Pool({ connectionString: databaseUrl });
const hookgres = new Hookgres({
  pool,
  schema: "hookgres_ex_retries",
  // Short delays for the demo. The default is 5s, 5m, 30m, 2h, 5h, 10h, 10h.
  retrySchedule: [500, 1_000],
});
await pool.query("DROP SCHEMA IF EXISTS hookgres_ex_retries CASCADE"); // a previous run may have crashed
await hookgres.migrate();

let secret = "";
const receiver = await startReceiver({
  secret: () => secret,
  respond: (_id, attempt) => (attempt <= 2 ? 503 : 204),
});
const endpoint = await hookgres.createEndpoint({
  tenantId: "acme",
  url: receiver.url,
});
secret = endpoint.secret;
hookgres.start();

const { message } = await hookgres.send({
  tenantId: "acme",
  eventType: "order.shipped",
  payload: { orderId: "ord_42" },
});
await receiver.waitFor(1);

const [delivery] = await hookgres.listDeliveries({ messageId: message.id });
if (!delivery) throw new Error("No delivery");
// The receiver has answered; give the worker a moment to record the result.
await waitForStatus(delivery.id, "succeeded");
for (const a of await hookgres.listAttempts(delivery.id)) {
  console.log(
    `attempt ${a.attemptNumber}: HTTP ${a.statusCode} in ${a.durationMs}ms`,
  );
}
const final = await hookgres.getDelivery(delivery.id);
console.log(
  `delivery ${final?.id} is ${final?.status} after ${final?.attemptCount} attempts`,
);
if (final?.status !== "succeeded" || final.attemptCount !== 3) {
  throw new Error("Expected success on the third attempt");
}

// A customer lost the event on their side: send it again.
if (!(await hookgres.replayDelivery(delivery.id))) {
  throw new Error("Replay refused");
}
await receiver.waitFor(2);
const [first, second] = receiver.received;
console.log("replayed with the same webhook-id:", first?.id === second?.id);
if (first?.id !== second?.id)
  throw new Error("Replay should keep the webhook-id");

await hookgres.stop();
await pool.query("DROP SCHEMA hookgres_ex_retries CASCADE");

async function waitForStatus(id: string, status: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await hookgres.getDelivery(id))?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Delivery ${id} never became ${status}`);
}
await pool.end();
await receiver.close();
