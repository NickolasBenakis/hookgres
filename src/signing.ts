import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HookgresValidationError } from "./errors.js";

/**
 * Signing follows the Standard Webhooks spec (https://www.standardwebhooks.com):
 * `webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`.
 * Receivers can verify with `verifyWebhook` below or any Standard Webhooks
 * library.
 */

export const SECRET_PREFIX = "whsec_";

/**
 * Returns a new `whsec_` secret with 24 random bytes. `createEndpoint` and
 * `rotateEndpointSecret` already generate one when you don't pass `secret`.
 *
 * @example
 * const secret = generateSecret(); // "whsec_..."
 */
export function generateSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString("base64");
}

/**
 * Checks a user-supplied secret is a Standard Webhooks secret: `whsec_` plus
 * strict base64 of 24 to 64 random bytes. Returns it unchanged; throws
 * otherwise.
 *
 * @example
 * const secret = assertSecret(input.secret); // throws if malformed
 */
export function assertSecret(secret: string): string {
  const raw = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : null;
  const bytes =
    raw !== null && raw.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(raw)
      ? Buffer.from(raw, "base64").length
      : 0;
  if (bytes < 24 || bytes > 64) {
    throw new HookgresValidationError(
      "Invalid webhook secret: expected whsec_ followed by base64 of 24-64 bytes. Omit `secret` to have one generated, or create one with generateSecret()",
    );
  }
  return secret;
}

function secretKey(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : secret;
  const key = Buffer.from(raw, "base64");
  if (key.length === 0) {
    throw new HookgresValidationError(
      "Invalid webhook secret: expected the endpoint's whsec_ secret, as returned by createEndpoint()",
    );
  }
  return key;
}

function hmac(
  secret: string,
  id: string,
  timestamp: number | string,
  body: string | Buffer,
): Buffer {
  return createHmac("sha256", secretKey(secret))
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest();
}

/**
 * Returns one `v1,<signature>` entry for the `webhook-signature` header.
 * Hookgres signs deliveries itself; use this in tests of your receiver.
 *
 * @example
 * const id = "msg_test";
 * const timestamp = Math.floor(Date.now() / 1000);
 * const body = JSON.stringify({ type: "invoice.paid", timestamp: new Date().toISOString(), data: {} });
 * const headers = {
 *   "webhook-id": id,
 *   "webhook-timestamp": String(timestamp),
 *   "webhook-signature": sign(secret, id, timestamp, body),
 * };
 */
export function sign(
  secret: string,
  id: string,
  timestamp: number,
  body: string | Buffer,
): string {
  return `v1,${hmac(secret, id, timestamp, body).toString("base64")}`;
}

/**
 * Thrown by `verifyWebhook` when a webhook is missing headers, too old, or not
 * signed with the secret. Respond with 400 or 401 and don't process it.
 *
 * @example
 * try {
 *   verifyWebhook({ secret, headers, body });
 * } catch (error) {
 *   if (error instanceof WebhookVerificationError) return new Response(null, { status: 401 });
 *   throw error;
 * }
 */
export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
}

/**
 * Request headers in any common shape: a `Headers` object (fetch, Next.js,
 * Hono), Node's `IncomingHttpHeaders` (Express, Fastify) or anything with
 * `get(name)`.
 */
export type HeaderBag =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

/** Options for `verifyWebhook`. */
export interface VerifyOptions {
  /** The endpoint's `whsec_` secret, or several (new and old) during a rotation. */
  secret: string | string[];
  /** The request headers, unchanged. */
  headers: HeaderBag;
  /**
   * The raw request body, exactly as received. Not parsed JSON: re-serialised
   * JSON won't match the signature.
   */
  body: string | Buffer;
  /** Maximum clock skew in seconds. Defaults to 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Override the clock (ms since epoch). For tests. */
  now?: number;
}

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (
      (headers as { get(n: string): string | null }).get(name) ?? undefined
    );
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * Verifies a webhook signed by Hookgres (or any Standard Webhooks sender) and
 * returns the parsed JSON body (a `WebhookEnvelope`: `{ type, timestamp,
 * data }`). Throws `WebhookVerificationError` otherwise.
 *
 * Pass the raw body, before any JSON parser runs. Webhooks can arrive more
 * than once: deduplicate on the `webhook-id` header.
 *
 * @example
 * // Express: read the raw body for this route
 * app.post("/webhooks", express.raw({ type: "application/json" }), (req, res) => {
 *   let event: WebhookEnvelope<{ id: string }>;
 *   try {
 *     event = verifyWebhook<WebhookEnvelope<{ id: string }>>({
 *       secret: process.env.WEBHOOK_SECRET!,
 *       headers: req.headers,
 *       body: req.body, // Buffer
 *     });
 *   } catch {
 *     return res.sendStatus(401);
 *   }
 *   // handle event.type / event.data; deduplicate on req.headers["webhook-id"]
 *   res.sendStatus(204);
 * });
 *
 * @see https://hookgres.dev/docs/guides/verifying
 */
export function verifyWebhook<T = unknown>(options: VerifyOptions): T {
  const { headers, body, toleranceSeconds = 300 } = options;
  // NaN (an unset env variable through Number()) would turn the replay check
  // off without a word, since no comparison with NaN is true.
  if (
    typeof toleranceSeconds !== "number" ||
    !Number.isFinite(toleranceSeconds) ||
    toleranceSeconds < 0
  ) {
    throw new TypeError(
      `verifyWebhook toleranceSeconds must be a non-negative number of seconds, got ${String(toleranceSeconds)}. Omit it to use 300 (5 minutes). See https://hookgres.dev/docs/guides/verifying`,
    );
  }
  if (typeof body !== "string" && !Buffer.isBuffer(body)) {
    throw new WebhookVerificationError(
      `Webhook body must be the raw request body (string or Buffer), not parsed JSON: read it before any JSON body parser, e.g. express.raw({ type: "application/json" }) or await request.text(). See https://hookgres.dev/docs/guides/verifying`,
    );
  }
  const id = readHeader(headers, "webhook-id");
  const timestampHeader = readHeader(headers, "webhook-timestamp");
  const signatureHeader = readHeader(headers, "webhook-signature");
  if (!id || !timestampHeader || !signatureHeader) {
    throw new WebhookVerificationError(
      "Missing required webhook headers: webhook-id, webhook-timestamp and webhook-signature. Pass the request's headers unchanged. See https://hookgres.dev/docs/guides/verifying",
    );
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) {
    throw new WebhookVerificationError("Invalid webhook-timestamp header");
  }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new WebhookVerificationError(
      "Webhook timestamp outside tolerance: the request is too old or the server clock is off. Check the clock, or raise toleranceSeconds. See https://hookgres.dev/docs/guides/verifying",
    );
  }

  const candidates = signatureHeader
    .split(" ")
    .map((part) => part.split(","))
    .filter(([version, sig]) => version === "v1" && sig)
    .map(([, sig]) => Buffer.from(sig as string, "base64"));

  const secrets = Array.isArray(options.secret)
    ? options.secret
    : [options.secret];
  for (const secret of secrets) {
    let expected: Buffer;
    try {
      // Sign the header exactly as sent, not a re-serialised number.
      expected = hmac(secret, id, timestampHeader, body);
    } catch {
      throw new WebhookVerificationError(
        "Invalid webhook secret: pass the endpoint's whsec_ secret",
      );
    }
    for (const candidate of candidates) {
      if (
        candidate.length === expected.length &&
        timingSafeEqual(candidate, expected)
      ) {
        try {
          return JSON.parse(body.toString()) as T;
        } catch {
          throw new WebhookVerificationError("Webhook body is not valid JSON");
        }
      }
    }
  }
  throw new WebhookVerificationError(
    "No matching webhook signature: check that the secret is this endpoint's current one (pass [new, old] during a rotation) and that body is the raw request body, byte for byte. See https://hookgres.dev/docs/guides/verifying",
  );
}
