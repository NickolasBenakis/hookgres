import type { StandardSchemaV1 } from "./types.js";

/**
 * Thrown when an argument or option you passed to Hookgres is invalid: an
 * endpoint URL that isn't http(s) or (with `blockPrivateAddresses`) points
 * to a private address, a bad `eventTypes` pattern or secret, a `send()`
 * input with a `*` event type or no payload, a payload that fails its
 * schema (see `issues`), or an out-of-range option.
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
  /**
   * For a payload that failed its event type's schema (`schemas` option):
   * the schema library's issues, each with a `message` and a `path`. Only
   * set in that case. Issues can quote the payload's values, so log them
   * like payloads and don't return them to API callers; `message` names
   * only the failing paths.
   */
  readonly issues?: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(
    message: string,
    options?: ErrorOptions & {
      issues?: ReadonlyArray<StandardSchemaV1.Issue>;
    },
  ) {
    super(message, options);
    if (options?.issues) this.issues = options.issues;
  }
}
