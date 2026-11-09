/**
 * Thrown when an argument or option you passed to Hookgres is invalid: an
 * endpoint URL that isn't http(s) or (with `blockPrivateAddresses`) points
 * to a private address, a bad `eventTypes` pattern or secret, a `send()`
 * input with a `*` event type or no payload, or an out-of-range option.
 * The message says how to fix it, so it is safe to show to whoever supplied
 * the value. Database and network errors are never wrapped in it.
 *
 * @example
 * try {
 *   await hookgres.createEndpoint({ tenantId, url, eventTypes });
 * } catch (error) {
 *   if (error instanceof HookgresValidationError) {
 *     return Response.json({ error: error.message }, { status: 400 });
 *   }
 *   throw error; // database errors become 500s
 * }
 */
export class HookgresValidationError extends Error {
  override name = "HookgresValidationError";
}
