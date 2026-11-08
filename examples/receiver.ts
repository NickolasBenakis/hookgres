/**
 * A tiny webhook receiver shared by the examples: it verifies each request
 * with `verifyWebhook` and answers with whatever `respond` returns.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyWebhook, type WebhookEnvelope } from "hookgres";

export interface ReceivedWebhook {
  id: string;
  event: WebhookEnvelope;
}

export interface Receiver {
  url: string;
  received: ReceivedWebhook[];
  /** Resolves once `count` webhooks have been accepted (2xx). */
  waitFor(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startReceiver(options: {
  /** One secret, or several while a rotation is in progress. */
  secret: () => string | string[];
  /** HTTP status to answer with. Defaults to 204. */
  respond?: (webhookId: string, attempt: number) => number;
}): Promise<Receiver> {
  const received: ReceivedWebhook[] = [];
  const attempts = new Map<string, number>();
  const waiters: (() => void)[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let event: WebhookEnvelope;
      try {
        event = verifyWebhook<WebhookEnvelope>({
          secret: options.secret(),
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
      } catch (error) {
        res.writeHead(400).end((error as Error).message);
        return;
      }
      const id = String(req.headers["webhook-id"]);
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      const status = options.respond?.(id, attempt) ?? 204;
      if (status >= 200 && status < 300) {
        received.push({ id, event });
        for (const wake of waiters.splice(0)) wake();
      }
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/webhooks`,
    received,
    async waitFor(count, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(`Expected ${count} webhooks, got ${received.length}`);
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, left);
        });
      }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";
