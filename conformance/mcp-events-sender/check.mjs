#!/usr/bin/env node
// Sender-side conformance and failure checks for MCP Events webhook delivery
// (SEP-3415, draft). Points a fault-injecting receiver at an MCP server and
// checks what the server does: signatures, headers, retries, 410/413,
// redirects, endpoint verification, secret rotation, unsubscribe, restarts.
//
//   node check.mjs tls --dir .mcp-check
//   NODE_EXTRA_CA_CERTS=.mcp-check/cert.pem <start your server>
//   node check.mjs --server http://localhost:3001/mcp --event incident.created \
//     --trigger "curl -s -X POST localhost:3001/emit" --tls-dir .mcp-check \
//     --auth-env MCP_TOKEN
//
// See README.md for every option and check.
import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join, resolve } from "node:path";
import { Webhook } from "standardwebhooks";

const EXTENSION = "io.modelcontextprotocol/events";
const PROTOCOL_VERSION = "2026-07-28";
const CODES = {
  InvalidParams: -32602,
  NotFound: -32023,
  Forbidden: -32024,
  CallbackEndpointError: -32027,
};

// ---------------------------------------------------------------- options

const argv = process.argv.slice(2);
if (argv[0] === "tls") {
  const dir = resolve(option("dir", ".mcp-check"));
  ensureTls(dir);
  console.log(`Certificate: ${join(dir, "cert.pem")}`);
  console.log(
    `Start your server with NODE_EXTRA_CA_CERTS=${join(dir, "cert.pem")}`,
  );
  process.exit(0);
}

const config = {
  server: option("server"),
  event: option("event"),
  arguments: JSON.parse(option("arguments", "{}")),
  trigger: option("trigger"),
  restart: option("restart"),
  authEnv: option("auth-env"),
  host: option("host", "127.0.0.1"),
  port: Number(option("port", "0")),
  tlsDir: option("tls-dir"),
  insecureHttp: argv.includes("--insecure-http"),
  retryWaitMs: Number(option("retry-wait", "120")) * 1000,
  deliveryWaitMs: Number(option("delivery-wait", "20")) * 1000,
  json: argv.includes("--json"),
  expectHandshake: argv.includes("--expect-handshake"),
};
for (const required of ["server", "event", "trigger"]) {
  if (!config[required]) usage(`--${required} is required`);
}
if (!config.insecureHttp && !config.tlsDir) {
  usage("pass --tls-dir (see `check.mjs tls`), or --insecure-http");
}

function option(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}
function usage(message) {
  console.error(
    `${message}\n\nUsage: node check.mjs --server <mcp url> --event <name> --trigger <command> (--tls-dir <dir> | --insecure-http) [--arguments <json>] [--auth-env <VAR>] [--restart <command>] [--retry-wait <s>] [--delivery-wait <s>] [--expect-handshake] [--json]`,
  );
  process.exit(2);
}

function ensureTls(dir) {
  mkdirSync(dir, { recursive: true });
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  if (!existsSync(cert) || !existsSync(key)) {
    execSync(
      `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -addext "basicConstraints=critical,CA:TRUE" -keyout "${key}" -out "${cert}"`,
      { stdio: "ignore" },
    );
  }
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

// --------------------------------------------------------------- receiver

/**
 * Each check gets its own callback path. A path's behaviour decides the
 * response to each delivery (n counts deliveries, not challenges):
 * a status code, "hang", or { status, headers }.
 */
const paths = new Map();
const requests = [];

function handler(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const path = req.url ?? "/";
    const state = paths.get(path) ?? {
      behaviour: () => 404,
      echo: false,
      n: 0,
    };
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    const record = {
      path,
      at: Date.now(),
      headers: req.headers,
      body,
      parsed,
      method: req.method,
    };
    requests.push(record);
    if (parsed?.type === "verification") {
      record.kind = "verification";
      if (!state.echo) {
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ challenge: parsed.challenge }));
      return;
    }
    record.kind = parsed?.type ? "control" : "event";
    state.n++;
    const outcome = state.behaviour(state.n, record);
    record.outcome = outcome;
    if (outcome === "hang") return;
    if (typeof outcome === "object") {
      res.writeHead(outcome.status, outcome.headers).end();
      return;
    }
    res.writeHead(outcome).end();
  });
}

const tls = config.tlsDir ? ensureTls(resolve(config.tlsDir)) : null;
const server = tls
  ? https.createServer(tls, handler)
  : http.createServer(handler);
await new Promise((r) => server.listen(config.port, "127.0.0.1", r));
const base = `${tls ? "https" : "http"}://${config.host}:${server.address().port}`;

function route(name, { behaviour = () => 200, echo = true } = {}) {
  const path = `/hooks/${name}-${randomBytes(4).toString("hex")}`;
  paths.set(path, { behaviour, echo, n: 0 });
  return { path, url: base + path };
}
const at = (path, kind = "event") =>
  requests.filter((r) => r.path === path && r.kind === kind);

// ------------------------------------------------------------- MCP client

let session = null;
let rpcId = 0;
const authHeader = () => {
  if (!config.authEnv) return {};
  const value = process.env[config.authEnv];
  if (!value) throw new Error(`${config.authEnv} is not set`);
  return { authorization: value.includes(" ") ? value : `Bearer ${value}` };
};

async function rpc(method, params, { auth = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
    ...(params?.name ? { "mcp-name": params.name } : {}),
    ...(session ? { "mcp-session-id": session } : {}),
    ...(auth ? authHeader() : {}),
  };
  const id = ++rpcId;
  const response = await fetch(config.server, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  session = response.headers.get("mcp-session-id") ?? session;
  const text = await response.text();
  let message = null;
  if (
    (response.headers.get("content-type") ?? "").includes("text/event-stream")
  ) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const data = JSON.parse(line.slice(5));
        if (data.id === id) message = data;
      } catch {}
    }
  } else {
    try {
      message = JSON.parse(text);
    } catch {}
  }
  return {
    httpStatus: response.status,
    result: message?.result,
    error: message?.error,
  };
}

function subscribeParams(url, secret, extra = {}) {
  return {
    name: config.event,
    arguments: config.arguments,
    delivery: { mode: "webhook", url, secret },
    cursor: null,
    ttlMs: 600_000,
    ...extra,
  };
}

const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

// ---------------------------------------------------------------- helpers

let triggers = 0;
/**
 * Runs the trigger command without blocking: the receiver lives in this
 * process, and a server may deliver before the trigger returns.
 */
function trigger() {
  triggers++;
  return runCommand(config.trigger, {
    MCP_CHECK_EVENT: config.event,
    MCP_CHECK_SEQ: String(triggers),
  });
}

function runCommand(command, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`exit ${code}`)),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

function verifies(secret, record) {
  try {
    new Webhook(secret).verify(record.body, {
      "webhook-id": record.headers["webhook-id"],
      "webhook-timestamp": record.headers["webhook-timestamp"],
      "webhook-signature": record.headers["webhook-signature"],
    });
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- checks

const results = [];
function report(id, level, title, outcome, detail = "") {
  results.push({ id, level, title, outcome, detail });
  if (!config.json) {
    const mark = { pass: "PASS", fail: "FAIL", skip: "SKIP", info: "INFO" }[
      outcome
    ];
    console.log(
      `${mark}  [${level}] ${id} ${title}${detail ? ` (${detail})` : ""}`,
    );
  }
}
const check = (id, level, title, ok, detail) =>
  report(id, level, title, ok ? "pass" : "fail", ok ? "" : detail);

// Measured from the retry check, to know how long "no retry" must be watched.
let firstRetryDelayMs = null;

async function discovery() {
  let response = await rpc("server/discover", {});
  if (!response.result) {
    response = await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { extensions: { [EXTENSION]: {} } },
      clientInfo: { name: "mcp-events-sender-check", version: "0.1.0" },
    });
  }
  const capabilities = response.result?.capabilities;
  check(
    "discovery.extension",
    "MUST",
    "advertises io.modelcontextprotocol/events",
    Boolean(capabilities?.extensions?.[EXTENSION]),
    `capabilities: ${JSON.stringify(capabilities ?? response.error ?? response.httpStatus)}`,
  );

  const list = await rpc("events/list", {});
  const type = list.result?.events?.find((e) => e.name === config.event);
  check(
    "list.webhook",
    "MUST",
    `events/list offers ${config.event} with webhook delivery`,
    type?.delivery?.includes("webhook"),
    JSON.stringify(type ?? list.error ?? list.result),
  );
  check(
    "list.resultType",
    "MUST",
    'results carry resultType "complete"',
    list.result?.resultType === "complete",
    JSON.stringify(list.result?.resultType),
  );
}

async function subscribeValidation() {
  const { url } = route("validation");
  const bad = await rpc(
    "events/subscribe",
    subscribeParams(url, "whsec_dG9vc2hvcnQ="),
  );
  check(
    "subscribe.secret",
    "MUST",
    "rejects a malformed whsec_ secret with InvalidParams",
    bad.error?.code === CODES.InvalidParams,
    JSON.stringify(bad.error ?? bad.result),
  );

  if (config.insecureHttp) {
    report(
      "subscribe.https",
      "MUST",
      "rejects a non-https callback URL",
      "skip",
      "--insecure-http",
    );
  } else {
    const plain = await rpc(
      "events/subscribe",
      subscribeParams(url.replace(/^https:/, "http:"), newSecret()),
    );
    check(
      "subscribe.https",
      "MUST",
      "rejects a non-https callback URL with InvalidParams",
      plain.error?.code === CODES.InvalidParams,
      JSON.stringify(plain.error ?? plain.result),
    );
  }

  if (config.authEnv) {
    const anonymous = await rpc(
      "events/subscribe",
      subscribeParams(url, newSecret()),
      { auth: false },
    );
    const rejected =
      anonymous.error?.code === CODES.Forbidden ||
      [401, 403].includes(anonymous.httpStatus);
    check(
      "subscribe.auth",
      "MUST",
      "rejects an unauthenticated subscribe",
      rejected,
      JSON.stringify(
        anonymous.error ?? anonymous.result ?? anonymous.httpStatus,
      ),
    );
  } else {
    report(
      "subscribe.auth",
      "MUST",
      "rejects an unauthenticated subscribe",
      "skip",
      "no --auth-env",
    );
  }

  const unknown = await rpc("events/subscribe", {
    ...subscribeParams(url, newSecret()),
    name: "mcp-check.no-such-event",
  });
  check(
    "subscribe.unknown",
    "MUST",
    "rejects an unknown event name with NotFound",
    unknown.error?.code === CODES.NotFound,
    JSON.stringify(unknown.error ?? unknown.result),
  );
}

async function verification() {
  const silent = route("unverified", { echo: false });
  const failed = await rpc(
    "events/subscribe",
    subscribeParams(silent.url, newSecret()),
  );
  const challenges = at(silent.path, "verification");
  const noHandshake = challenges.length === 0 && failed.result;
  if (noHandshake && !config.expectHandshake) {
    // An allowlist, out-of-band or well-known verification is also allowed,
    // and can't be told apart from no verification from the outside.
    report(
      "verify.before-delivery",
      "MUST",
      "confirms the endpoint before delivering",
      "info",
      "no challenge was sent: allowlist or out-of-band verification? Pass --expect-handshake to require one",
    );
    return;
  }
  check(
    "verify.before-delivery",
    "MUST",
    "refuses to activate an endpoint that doesn't echo the challenge",
    failed.error?.code === CODES.CallbackEndpointError &&
      failed.error?.data?.reason === "challenge_failed",
    JSON.stringify(failed.error ?? failed.result),
  );
  if (failed.result) {
    await trigger();
    await sleep(config.deliveryWaitMs / 2);
    check(
      "verify.no-delivery",
      "MUST",
      "sends no events to an unverified endpoint",
      at(silent.path).length === 0,
      `${at(silent.path).length} delivered`,
    );
  }
  const challenge = challenges[0];
  if (challenge) {
    check(
      "verify.headers",
      "MUST",
      "signs the challenge and sets X-MCP-Subscription-Id",
      Boolean(
        challenge.headers["webhook-signature"] &&
          challenge.headers["x-mcp-subscription-id"],
      ),
      JSON.stringify(challenge.headers),
    );
  }
}

async function delivery() {
  const secret = newSecret();
  const r = route("delivery");
  const sub = await rpc("events/subscribe", subscribeParams(r.url, secret));
  if (!sub.result) {
    report(
      "deliver.subscribe",
      "MUST",
      "subscribes a verified endpoint",
      "fail",
      JSON.stringify(sub.error ?? sub.httpStatus),
    );
    return null;
  }
  check(
    "deliver.subscribe",
    "MUST",
    "subscribes and returns id and refreshBefore",
    typeof sub.result.id === "string" &&
      "refreshBefore" in sub.result &&
      sub.result.resultType === "complete",
    JSON.stringify(sub.result),
  );
  const verificationRecord = at(r.path, "verification")[0];
  if (verificationRecord) {
    check(
      "verify.signature",
      "MUST",
      "signs the verification challenge with the client's secret",
      verifies(secret, verificationRecord),
      "signature did not verify",
    );
    check(
      "verify.id-format",
      "MUST",
      "verification webhook-id has the form msg_verification_<random>",
      /^msg_verification_[A-Za-z0-9_-]+$/.test(
        verificationRecord.headers["webhook-id"] ?? "",
      ),
      verificationRecord.headers["webhook-id"],
    );
  }

  await trigger();
  const arrived = await waitFor(
    () => at(r.path).length > 0,
    config.deliveryWaitMs,
  );
  if (!arrived) {
    report(
      "deliver.arrives",
      "MUST",
      "delivers a triggered event",
      "fail",
      `nothing within ${config.deliveryWaitMs / 1000}s`,
    );
    return { sub, secret, route: r };
  }
  const record = at(r.path)[0];
  const h = record.headers;
  check(
    "deliver.signature",
    "MUST",
    "signature verifies with the standardwebhooks library",
    verifies(secret, record),
    "signature did not verify",
  );
  check(
    "deliver.headers",
    "MUST",
    "sends webhook-id, webhook-timestamp, webhook-signature and X-MCP-Subscription-Id",
    Boolean(
      h["webhook-id"] &&
        h["webhook-timestamp"] &&
        h["webhook-signature"] &&
        h["x-mcp-subscription-id"],
    ),
    JSON.stringify(h),
  );
  check(
    "deliver.subscription-id",
    "MUST",
    "X-MCP-Subscription-Id equals the subscribe id",
    h["x-mcp-subscription-id"] === sub.result.id,
    `${h["x-mcp-subscription-id"]} vs ${sub.result.id}`,
  );
  check(
    "deliver.method",
    "MUST",
    "POST with application/json",
    record.method === "POST" &&
      (h["content-type"] ?? "").startsWith("application/json"),
    `${record.method} ${h["content-type"]}`,
  );
  const age = Math.abs(Date.now() / 1000 - Number(h["webhook-timestamp"]));
  check(
    "deliver.timestamp",
    "MUST",
    "webhook-timestamp is the current Unix time in seconds",
    age < 300,
    `${Math.round(age)}s off`,
  );
  const body = record.parsed ?? {};
  const shapeOk =
    typeof body.eventId === "string" &&
    body.name === config.event &&
    !Number.isNaN(Date.parse(body.timestamp)) &&
    typeof body.data === "object" &&
    body.data !== null &&
    (body.cursor === undefined ||
      body.cursor === null ||
      typeof body.cursor === "string");
  check(
    "deliver.body",
    "MUST",
    "body is an EventOccurrence {eventId, name, timestamp, data, cursor?}",
    shapeOk,
    record.body.slice(0, 200),
  );
  const id = h["webhook-id"] ?? "";
  check(
    "deliver.id-charset",
    "MUST",
    "webhook-id uses only letters, digits, _ and -",
    /^[A-Za-z0-9_-]+$/.test(id),
    id,
  );
  check(
    "deliver.id-not-event",
    "MUST",
    "webhook-id is not derived from eventId",
    // A short eventId can appear in a random id by chance, so only a long
    // one counts as "derived".
    typeof body.eventId !== "string" ||
      (id !== body.eventId &&
        (body.eventId.length < 8 || !id.includes(body.eventId))),
    `${id} contains ${body.eventId}`,
  );
  return { sub, secret, route: r };
}

async function retries() {
  const secret = newSecret();
  const r = route("retry", { behaviour: (n) => (n === 1 ? 503 : 200) });
  const sub = await rpc("events/subscribe", subscribeParams(r.url, secret));
  if (!sub.result)
    return report(
      "retry.5xx",
      "MUST",
      "retries a 5xx",
      "skip",
      "subscribe failed",
    );
  await trigger();
  const retried = await waitFor(
    () => at(r.path).length >= 2,
    config.deliveryWaitMs + config.retryWaitMs,
  );
  if (!retried) {
    return report(
      "retry.5xx",
      "SHOULD",
      "retries a 5xx with backoff",
      "fail",
      `${at(r.path).length} attempt(s) within ${(config.deliveryWaitMs + config.retryWaitMs) / 1000}s`,
    );
  }
  const [first, second] = at(r.path);
  firstRetryDelayMs = second.at - first.at;
  report(
    "retry.5xx",
    "SHOULD",
    "retries a 5xx with backoff",
    "pass",
    `first retry after ${Math.round(firstRetryDelayMs / 1000)}s`,
  );
  check(
    "retry.same-id",
    "MUST",
    "keeps webhook-id across retries",
    first.headers["webhook-id"] === second.headers["webhook-id"],
    `${first.headers["webhook-id"]} then ${second.headers["webhook-id"]}`,
  );
  check(
    "retry.fresh-signature",
    "MUST",
    "regenerates timestamp and signature on each retry",
    verifies(secret, second) &&
      (second.headers["webhook-timestamp"] !==
        first.headers["webhook-timestamp"] ||
        firstRetryDelayMs < 1000),
    "stale timestamp or bad signature on the retry",
  );
}

async function finalStatuses() {
  const watchMs = Math.max(
    10_000,
    2 * (firstRetryDelayMs ?? config.retryWaitMs / 2),
  );
  for (const status of [410, 413]) {
    const r = route(`status-${status}`, {
      behaviour: (n) => (n === 1 ? status : 200),
    });
    const sub = await rpc(
      "events/subscribe",
      subscribeParams(r.url, newSecret()),
    );
    if (!sub.result) {
      report(
        `final.${status}`,
        "MUST",
        `treats ${status} as non-retryable`,
        "skip",
        "subscribe failed",
      );
      continue;
    }
    await trigger();
    const arrived = await waitFor(
      () => at(r.path).length > 0,
      config.deliveryWaitMs,
    );
    if (!arrived) {
      report(
        `final.${status}`,
        "MUST",
        `treats ${status} as non-retryable`,
        "skip",
        "no delivery",
      );
      continue;
    }
    await sleep(watchMs);
    const ids = at(r.path).map((x) => x.headers["webhook-id"]);
    const retried = ids.filter((x) => x === ids[0]).length > 1;
    check(
      `final.${status}`,
      "MUST",
      `does not retry a ${status}`,
      !retried,
      `retried within ${Math.round(watchMs / 1000)}s`,
    );
    if (status === 410) {
      const before = at(r.path).length;
      await trigger();
      const next = await waitFor(
        () => at(r.path).length > before,
        config.deliveryWaitMs,
      );
      check(
        "final.410-subscription",
        "MUST",
        "a 410 doesn't end the subscription",
        next,
        "no delivery after the 410",
      );
    }
  }
}

async function redirects() {
  const target = route("redirect-target");
  const r = route("redirect", {
    behaviour: () => ({ status: 307, headers: { location: target.url } }),
  });
  const sub = await rpc(
    "events/subscribe",
    subscribeParams(r.url, newSecret()),
  );
  if (!sub.result)
    return report(
      "redirect",
      "MUST",
      "does not follow redirects",
      "skip",
      "subscribe failed",
    );
  await trigger();
  await waitFor(() => at(r.path).length > 0, config.deliveryWaitMs);
  await sleep(3000);
  if (at(r.path).length === 0)
    return report(
      "redirect",
      "MUST",
      "does not follow redirects",
      "skip",
      "no delivery",
    );
  check(
    "redirect",
    "MUST",
    "does not follow redirects",
    at(target.path).length === 0 &&
      at(target.path, "verification").length === 0,
    `${at(target.path).length} request(s) reached the redirect target`,
  );
}

async function rotation(state) {
  if (!state?.sub?.result)
    return report(
      "rotate.new-secret",
      "MUST",
      "uses a secret rotated on refresh",
      "skip",
      "no subscription",
    );
  const next = newSecret();
  const refresh = await rpc(
    "events/subscribe",
    subscribeParams(state.route.url, next),
  );
  check(
    "refresh.same-id",
    "MUST",
    "refresh keeps the subscription id",
    refresh.result?.id === state.sub.result.id,
    JSON.stringify(refresh.result ?? refresh.error),
  );
  check(
    "refresh.refreshBefore",
    "MUST",
    "refresh returns refreshBefore",
    refresh.result && "refreshBefore" in refresh.result,
    JSON.stringify(refresh.result),
  );
  const status = refresh.result?.deliveryStatus;
  if (status) {
    const categories = [
      null,
      "connection_refused",
      "timeout",
      "tls_error",
      "http_4xx",
      "http_5xx",
      "challenge_failed",
    ];
    check(
      "refresh.deliveryStatus",
      "MUST",
      "deliveryStatus.lastError is a category, not raw text",
      categories.includes(status.lastError ?? null),
      JSON.stringify(status),
    );
  } else {
    report(
      "refresh.deliveryStatus",
      "MAY",
      "returns deliveryStatus on refresh",
      "info",
      "not returned",
    );
  }
  const before = at(state.route.path).length;
  await trigger();
  if (
    !(await waitFor(
      () => at(state.route.path).length > before,
      config.deliveryWaitMs,
    ))
  ) {
    return report(
      "rotate.new-secret",
      "MUST",
      "uses a secret rotated on refresh",
      "fail",
      "no delivery after refresh",
    );
  }
  const record = at(state.route.path)[before];
  check(
    "rotate.new-secret",
    "MUST",
    "signs with the new secret after a refresh",
    verifies(next, record),
    "new secret did not verify",
  );
  check(
    "rotate.dual-sign",
    "SHOULD",
    "also signs with the old secret during a grace window",
    verifies(state.secret, record),
    "old secret did not verify",
  );
}

async function unsubscribe(state) {
  if (!state?.sub?.result)
    return report(
      "unsubscribe.stops",
      "MUST",
      "stops deliveries after unsubscribe",
      "skip",
      "no subscription",
    );
  const params = {
    name: config.event,
    arguments: config.arguments,
    delivery: { url: state.route.url },
  };
  const done = await rpc("events/unsubscribe", params);
  check(
    "unsubscribe.ok",
    "MUST",
    "unsubscribe succeeds",
    Boolean(done.result),
    JSON.stringify(done.error ?? done.httpStatus),
  );
  const before = at(state.route.path).length;
  await trigger();
  await sleep(config.deliveryWaitMs / 2);
  check(
    "unsubscribe.stops",
    "MUST",
    "stops deliveries after unsubscribe",
    at(state.route.path).length === before,
    `${at(state.route.path).length - before} delivered after unsubscribe`,
  );
  const again = await rpc("events/unsubscribe", params);
  check(
    "unsubscribe.unknown",
    "MUST",
    "unsubscribing an unknown subscription returns NotFound",
    again.error?.code === CODES.NotFound,
    JSON.stringify(again.error ?? again.result),
  );
}

async function restart() {
  if (!config.restart) {
    return report(
      "durable.restart",
      "INFO",
      "delivers an event queued before a restart",
      "skip",
      "no --restart",
    );
  }
  let up = false;
  const r = route("restart", { behaviour: () => (up ? 200 : 503) });
  const sub = await rpc(
    "events/subscribe",
    subscribeParams(r.url, newSecret()),
  );
  if (!sub.result)
    return report(
      "durable.restart",
      "INFO",
      "delivers an event queued before a restart",
      "skip",
      "subscribe failed",
    );
  await trigger();
  await waitFor(() => at(r.path).length > 0, config.deliveryWaitMs);
  await runCommand(config.restart);
  up = true;
  session = null;
  const delivered = await waitFor(
    () => at(r.path).some((x) => x.outcome === 200),
    config.retryWaitMs + config.deliveryWaitMs,
  );
  // Emit-only event types may be lost across restarts (SEP-3415, Ordering and
  // Delivery Guarantees), so this is informational, not a failure.
  report(
    "durable.restart",
    "INFO",
    "delivers an event queued before a restart",
    delivered ? "pass" : "info",
    delivered ? "" : "lost across the restart (allowed for emit-only types)",
  );
}

// -------------------------------------------------------------------- run

try {
  await discovery();
  await subscribeValidation();
  await verification();
  const state = await delivery();
  await retries();
  await finalStatuses();
  await redirects();
  await rotation(state);
  await unsubscribe(state);
  await restart();
} catch (error) {
  report("harness", "MUST", "check run completed", "fail", error.message);
} finally {
  server.closeAllConnections?.();
  server.close();
}

const failedMust = results.filter(
  (r) => r.outcome === "fail" && r.level === "MUST",
);
const failedShould = results.filter(
  (r) => r.outcome === "fail" && r.level === "SHOULD",
);
if (config.json) {
  console.log(
    JSON.stringify(
      { server: config.server, event: config.event, results },
      null,
      2,
    ),
  );
} else {
  const passed = results.filter((r) => r.outcome === "pass").length;
  console.log(
    `\n${passed} passed, ${failedMust.length} MUST and ${failedShould.length} SHOULD failed, ${results.filter((r) => r.outcome === "skip").length} skipped`,
  );
}
process.exit(failedMust.length ? 1 : 0);
