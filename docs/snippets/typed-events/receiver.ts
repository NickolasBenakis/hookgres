import { type InferEvents, verifyWebhook, type WebhookEvent } from "hookgres";
import type { schemas } from "./schemas.js";

// What Hookgres delivers: each schema's output. With an event map instead of
// schemas, use WebhookEvent<Events>.
type Events = InferEvents<typeof schemas>;

export async function POST(
  request: Request,
  secret: string,
): Promise<Response> {
  const event = verifyWebhook<WebhookEvent<Events>>({
    secret,
    headers: request.headers,
    body: await request.text(),
  });
  if (event.type === "invoice.paid") {
    // event.data is { invoiceId: string; amount: number }
    console.log(`Invoice ${event.data.invoiceId} paid: ${event.data.amount}`);
  }
  return new Response(null, { status: 204 });
}
