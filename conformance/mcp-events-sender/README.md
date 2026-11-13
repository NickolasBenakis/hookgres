# MCP Events sender checks

Sender-side conformance and failure checks for MCP Events webhook delivery
([SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415),
draft). It runs a receiver that misbehaves on purpose and checks what your
MCP server does about it. It works with any server and any language: it
speaks JSON-RPC over HTTP and triggers events with a command you give it.

Receiver-side checks already exist in
[evdock](https://github.com/loveaihq/evdock). This covers the other side:
whether a server signs, retries, gives up and verifies the way the SEP says.

## Run it

Needs Node 22+, `openssl`, and `npm install standardwebhooks` next to
`check.mjs`. (Inside the Hookgres repo it's already installed.)

```sh
# 1. A self-signed certificate for the receiver (callback URLs must be https).
node check.mjs tls --dir .mcp-check

# 2. Start your server so it trusts that certificate and allows deliveries to
#    127.0.0.1 (an SSRF allowlist entry for testing).
NODE_EXTRA_CA_CERTS=.mcp-check/cert.pem <start your server>

# 3. Run the checks.
MCP_TOKEN=... node check.mjs \
  --server https://localhost:3001/mcp \
  --event incident.created \
  --trigger "curl -s -X POST localhost:3001/test/emit" \
  --tls-dir .mcp-check \
  --auth-env MCP_TOKEN
```

| Option                          |                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `--server`                      | The MCP endpoint (Streamable HTTP, JSON or SSE responses).                                    |
| `--event`                       | An event type that offers webhook delivery.                                                   |
| `--trigger`                     | A shell command that makes the server emit one such event. Gets `MCP_CHECK_SEQ`.              |
| `--arguments`                   | Subscription arguments as JSON, so triggered events match. Default `{}`.                      |
| `--auth-env`                    | Name of the variable holding the bearer token (or a full `Authorization` value).              |
| `--tls-dir` / `--insecure-http` | The receiver's certificate, or plain http for servers in a test mode (skips the https check). |
| `--restart`                     | A command that restarts the server and returns once it's up. Enables the restart check.       |
| `--retry-wait`                  | Seconds to wait for a retry. Default 120. Servers with long first backoffs need more.         |
| `--delivery-wait`               | Seconds to wait for a delivery. Default 20.                                                   |
| `--expect-handshake`            | Require the `verification` challenge, not an allowlist.                                       |
| `--json`                        | Machine-readable results.                                                                     |

It exits with 1 if a MUST check fails.

## What it checks

| Check                                                                                             | Level         | SEP-3415                                |
| ------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------- |
| Advertises `io.modelcontextprotocol/events`; `events/list` offers webhook                         | MUST          | Capability Negotiation, Listing         |
| Rejects a malformed `whsec_` secret, a non-https URL, an unknown event, an unauthenticated caller | MUST          | Subscribing, Subscription identity      |
| Refuses an endpoint that doesn't echo the challenge; sends it nothing                             | MUST          | Endpoint verification                   |
| Signs the challenge; `msg_verification_` id                                                       | MUST          | Endpoint verification, Non-event bodies |
| Signature verifies with the `standardwebhooks` library                                            | MUST          | Signature scheme                        |
| `webhook-*` headers and `X-MCP-Subscription-Id` equal to the subscribe id                         | MUST          | Webhook event delivery                  |
| Body is an `EventOccurrence`                                                                      | MUST          | Event Occurrences                       |
| `webhook-id` charset, and not derived from `eventId` (8+ characters of it inside the id)          | MUST          | Signature scheme                        |
| Retries a 5xx with the same `webhook-id` and a fresh timestamp and signature                      | SHOULD / MUST | Delivery model                          |
| Doesn't retry `410` or `413`; a `410` doesn't end the subscription                                | MUST          | Delivery model, Delivery profile        |
| Doesn't follow redirects                                                                          | MUST          | SSRF prevention                         |
| Refresh keeps the id, returns `refreshBefore`; `lastError` is a category                          | MUST          | Subscription identity, Delivery status  |
| Signs with a secret rotated on refresh; dual-signs with the old one                               | MUST / SHOULD | Secret rotation                         |
| Unsubscribe stops deliveries; unknown subscription is `NotFound`                                  | MUST          | Unsubscribing                           |
| Delivers an event queued before a crash and restart                                               | INFO          | Ordering and Delivery Guarantees        |

The restart check is informational: the SEP allows emit-only event types to
lose events across restarts.

## Not checked yet

DNS-rebinding defence, private-address blocking (the receiver itself is on
127.0.0.1), timeouts and hanging endpoints, suspension and `deliveryStatus`
after sustained failures, cursor watermarks and replay, `gap` and
`terminated` envelopes, and abandoning events after the retry window.

## Try it on the example server

`example-server.mjs` has two modes, `hookgres/mcp-events` and a naive
in-memory sender with the usual mistakes:

```sh
pnpm build
DATABASE_URL=postgres://... ./run-example.sh   # 36 passed
./run-example.sh --broken                      # 10 MUST and 1 SHOULD failed
```
