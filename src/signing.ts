import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signing follows the Standard Webhooks spec (https://www.standardwebhooks.com):
 * `webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`.
 * Receivers can verify with `verifyWebhook` below or any Standard Webhooks
 * library.
 */

export const SECRET_PREFIX = "whsec_";

/** Returns a new `whsec_` secret with 24 random bytes. */
export function generateSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString("base64");
}

/**
 * Checks a user-supplied secret is a Standard Webhooks secret: `whsec_` plus
 * strict base64 of 24 to 64 random bytes. Returns it unchanged.
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
    throw new Error(
      "Invalid webhook secret: expected whsec_ followed by base64 of 24-64 bytes",
    );
  }
  return secret;
}

function secretKey(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : secret;
  const key = Buffer.from(raw, "base64");
  if (key.length === 0) throw new Error("Invalid webhook secret");
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

/** Returns one `v1,<signature>` entry for the `webhook-signature` header. */
export function sign(
  secret: string,
  id: string,
  timestamp: number,
  body: string | Buffer,
): string {
  return `v1,${hmac(secret, id, timestamp, body).toString("base64")}`;
}

/** Thrown by `verifyWebhook` when a webhook is missing headers, too old, or not signed with the secret. */
export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
}

export type HeaderBag =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

export interface VerifyOptions {
  /** One secret, or several during a rotation. */
  secret: string | string[];
  headers: HeaderBag;
  /** The raw request body, exactly as received. */
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
 * returns the parsed JSON body. Throws `WebhookVerificationError` otherwise.
 */
export function verifyWebhook<T = unknown>(options: VerifyOptions): T {
  const { headers, body, toleranceSeconds = 300 } = options;
  if (typeof body !== "string" && !Buffer.isBuffer(body)) {
    throw new WebhookVerificationError(
      "Webhook body must be the raw request body (string or Buffer), not parsed JSON",
    );
  }
  const id = readHeader(headers, "webhook-id");
  const timestampHeader = readHeader(headers, "webhook-timestamp");
  const signatureHeader = readHeader(headers, "webhook-signature");
  if (!id || !timestampHeader || !signatureHeader) {
    throw new WebhookVerificationError("Missing required webhook headers");
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) {
    throw new WebhookVerificationError("Invalid webhook-timestamp header");
  }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new WebhookVerificationError("Webhook timestamp outside tolerance");
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
      throw new WebhookVerificationError("Invalid webhook secret");
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
  throw new WebhookVerificationError("No matching webhook signature");
}
