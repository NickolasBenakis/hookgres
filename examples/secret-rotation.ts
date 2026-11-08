/**
 * Rotating an endpoint's secret without dropping webhooks. During the grace
 * period every webhook carries two signatures, so receivers that still have
 * the old secret keep verifying.
 *
 *   docker compose up -d postgres && pnpm build && node examples/secret-rotation.ts
 */
import { Hookgres } from "hookgres";
import pg from "pg";
import { databaseUrl, startReceiver } from "./receiver.ts";

const pool = new pg.Pool({ connectionString: databaseUrl });
const hookgres = new Hookgres({ pool, schema: "hookgres_ex_rotation" });
await hookgres.migrate();

// The receiver still has only the old secret.
let receiverSecret = "";
const receiver = await startReceiver({ secret: () => receiverSecret });
const endpoint = await hookgres.createEndpoint({
  tenantId: "acme",
  url: receiver.url,
});
receiverSecret = endpoint.secret;
hookgres.start();

const rotated = await hookgres.rotateEndpointSecret(endpoint.id, {
  graceMs: 24 * 60 * 60 * 1000, // the old secret also signs for 24 hours
});
if (!rotated) throw new Error("Endpoint not found");
console.log(
  `rotated ${endpoint.secret.slice(0, 12)}… → ${rotated.secret.slice(0, 12)}…`,
);

await hookgres.send({ tenantId: "acme", eventType: "ping", payload: {} });
await receiver.waitFor(1);
console.log("old secret still verifies during the grace period");

// The customer updates their config; accepting both is fine meanwhile.
receiverSecret = rotated.secret;
await hookgres.send({ tenantId: "acme", eventType: "ping", payload: {} });
await receiver.waitFor(2);
console.log("new secret verifies too");

await hookgres.stop();
await pool.query("DROP SCHEMA hookgres_ex_rotation CASCADE");
await pool.end();
await receiver.close();
