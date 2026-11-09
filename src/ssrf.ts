import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

/** Addresses no webhook should reach: private, loopback, link-local, reserved. */
const BLOCKED = new BlockList();
for (const cidr of [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  // ::, ::1, and IPv4-compatible forms of 0.0.0.0/8 (not decoded below).
  "::/104",
  // Local-use NAT64 (RFC 8215). Where the IPv4 address sits depends on the
  // operator's prefix length, so block the whole range.
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
]) {
  addCidr(cidr, { ipv4: BLOCKED, ipv6: BLOCKED });
}

/**
 * Returns `true` if `address` is an IP address webhooks shouldn't reach:
 * private, loopback, link-local, multicast or reserved. IPv6 addresses that
 * embed an IPv4 address (`::ffff:127.0.0.1`, NAT64, 6to4) are judged by that
 * IPv4 address. Accepts bracketed IPv6 (`[::1]`, as in `URL#hostname`) and
 * zone ids. Returns `false` for strings that aren't IP addresses.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = normalise(address);
  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, "ipv4");
  if (family !== 6) return false;
  if (BLOCKED.check(ip, "ipv6")) return true;
  const embedded = embeddedIPv4(ip);
  return embedded !== null && BLOCKED.check(embedded, "ipv4");
}

/**
 * Ports fetch refuses to connect to (the WHATWG fetch "bad port" list), so
 * webhooks can't be aimed at SMTP, IRC and similar services.
 */
const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

function isBadPort(url: URL): boolean {
  return url.port !== "" && BAD_PORTS.has(Number(url.port));
}

export type BlockPrivateAddressesOption = boolean | { allow: string[] };

export class AddressGuard {
  // Separate lists: Node matches IPv4 addresses against IPv6 rules as
  // ::ffff:a.b.c.d, so an IPv6 entry like "::/0" would allow every IPv4.
  private readonly allow4 = new BlockList();
  private readonly allow6 = new BlockList();

  constructor(option: BlockPrivateAddressesOption) {
    if (typeof option !== "object") return;
    if (!Array.isArray(option.allow)) {
      throw new Error("blockPrivateAddresses.allow must be an array");
    }
    for (const entry of option.allow) {
      if (
        typeof entry !== "string" ||
        !addCidr(entry, { ipv4: this.allow4, ipv6: this.allow6 })
      ) {
        throw new Error(
          `Invalid blockPrivateAddresses.allow entry ${JSON.stringify(entry)}: use an IP address or CIDR, like "10.1.2.0/24" or "fd00::5"`,
        );
      }
    }
  }

  /** IPv4 and IPv6 forms that embed IPv4 use IPv4 entries, the rest IPv6. */
  isBlocked(address: string): boolean {
    const ip = normalise(address);
    const family = isIP(ip);
    const embedded = family === 6 ? embeddedIPv4(ip) : null;
    if (family === 4 && this.allow4.check(ip, "ipv4")) return false;
    if (embedded && this.allow4.check(embedded, "ipv4")) return false;
    if (family === 6 && !embedded && this.allow6.check(ip, "ipv6")) {
      return false;
    }
    return isPrivateAddress(ip);
  }

  /** Create/update check: no DNS, only IP literals and `localhost` names. */
  assertEndpointUrl(url: URL): void {
    const host = url.hostname.replace(/\.$/, "");
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      this.isBlocked(host)
    ) {
      throw new Error(
        `Endpoint URL points to a private address: ${url.href} (blockPrivateAddresses is on)`,
      );
    }
    if (isBadPort(url)) {
      throw new Error(
        `Endpoint URL uses a blocked port: ${url.href} (blockPrivateAddresses is on)`,
      );
    }
  }

  /**
   * A `lookup` for `http.request` that resolves every address of a host and
   * fails if any of them is blocked. The socket then connects to one of the
   * checked addresses, so a second DNS answer can't swap in another one.
   */
  lookup(resolve: AllLookup = dnsLookup): LookupFunction {
    return (hostname, options, callback) => {
      resolve(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, "");
        const blocked = addresses.find((a) => this.isBlocked(a.address));
        if (blocked) return callback(blockedError(blocked.address), "");
        const [first] = addresses;
        if (!first)
          return callback(new Error(`No address for ${hostname}`), "");
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      });
    };
  }
}

type AllLookup = (
  hostname: string,
  options: { all: true },
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

export interface TransportRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  redirect: "manual";
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  body: ReadableStream<Uint8Array> | null;
}

/** The part of `fetch` that delivery uses. */
export type Transport = (
  url: string,
  init: TransportRequest,
) => Promise<TransportResponse>;

/**
 * Sends requests with `node:http`/`node:https`, refusing blocked addresses
 * both for IP literals and for every address a hostname resolves to.
 * Redirects are not followed, like `fetch` with `redirect: "manual"`.
 * `tls` exists for tests (a self-signed receiver).
 */
export function guardedTransport(
  guard: AddressGuard,
  tls: { ca?: string } = {},
): { send: Transport; close(): void } {
  assertNoEnvProxy();
  // Like undici, close idle keep-alive sockets after 4s, before receivers'
  // own idle timeouts reset them. The agent only destroys free sockets on
  // timeout; requests in flight are bounded by the AbortSignal.
  const agents = {
    http: new http.Agent({ keepAlive: true, timeout: 4000 }),
    https: new https.Agent({ keepAlive: true, timeout: 4000, ...tls }),
  };
  const lookup = guard.lookup();
  const send: Transport = (url, { method, headers, body, signal }) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const target = new URL(url);
      // fetch refuses these; node:http would send them as Authorization.
      if (target.username || target.password) {
        throw new Error("Endpoint URL must not contain credentials");
      }
      // Node skips `lookup` for IP literals, so check them here.
      const host = normalise(target.hostname);
      if (isIP(host) && guard.isBlocked(host)) throw blockedError(host);
      if (isBadPort(target)) throw new Error(`Blocked port ${target.port}`);

      const secure = target.protocol === "https:";
      const request = (secure ? https : http).request(
        target,
        {
          method,
          headers: {
            accept: "*/*",
            "accept-encoding": "identity",
            ...headers,
            "content-length": Buffer.byteLength(body),
          },
          agent: secure ? agents.https : agents.http,
          lookup,
        },
        (response) =>
          resolve({
            status: response.statusCode ?? 0,
            body: Readable.toWeb(response),
          }),
      );
      const abort = () => request.destroy(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      request.once("close", () => signal.removeEventListener("abort", abort));
      request.on("error", reject);
      request.end(body);
    });
  return {
    send,
    close() {
      agents.http.destroy();
      agents.https.destroy();
    },
  };
}

/**
 * Node can route its own HTTP clients through HTTP(S)_PROXY. These agents
 * would bypass that proxy, and behind a proxy the guard belongs there.
 */
function assertNoEnvProxy(): void {
  const env = process.env;
  const flag = env.NODE_USE_ENV_PROXY;
  const enabled =
    (flag !== undefined && !["", "0", "false"].includes(flag)) ||
    process.execArgv.includes("--use-env-proxy");
  const proxy = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].find(
    (name) => env[name],
  );
  if (enabled && proxy) {
    throw new Error(
      `blockPrivateAddresses can't be used while Node routes requests through ${proxy} (NODE_USE_ENV_PROXY). Block private addresses in the proxy instead, e.g. with Smokescreen, or unset ${proxy}`,
    );
  }
}

function blockedError(address: string): Error {
  return new Error(`Blocked private address ${address}`);
}

/** Drops IPv6 brackets and zone ids: `[fe80::1%eth0]` → `fe80::1`. */
function normalise(address: string): string {
  const ip = address.startsWith("[") ? address.slice(1, -1) : address;
  const zone = ip.indexOf("%");
  return zone === -1 ? ip : ip.slice(0, zone);
}

/** Adds `"10.0.0.0/8"` or `"fd00::5"` to its family's list; false if invalid. */
function addCidr(
  cidr: string,
  lists: { ipv4: BlockList; ipv6: BlockList },
): boolean {
  const [address = "", prefix, extra] = cidr.split("/");
  const family = isIP(address);
  if (!family || address.includes("%") || extra !== undefined) return false;
  const max = family === 4 ? 32 : 128;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return false;
  const bits = prefix === undefined ? max : Number(prefix);
  if (bits > max) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  lists[type].addSubnet(address, bits, type);
  return true;
}

/**
 * The IPv4 address inside an IPv4-mapped (::ffff:0:0/96), IPv4-compatible
 * (::/96, from 1.0.0.0), NAT64 (64:ff9b::/96) or 6to4 (2002::/16) IPv6 address, or null.
 */
function embeddedIPv4(ipv6: string): string | null {
  const h = hextets(ipv6);
  const zeros = (from: number, to: number) =>
    h.slice(from, to).every((x) => x === 0);
  if (h[0] === 0x2002) return dotted(h[1], h[2]);
  if (zeros(0, 5) && h[5] === 0xffff) return dotted(h[6], h[7]);
  // IPv4-compatible, except :: and ::1, which are IPv6 addresses in their
  // own right (and blocked as such).
  if (zeros(0, 6) && (h[6] ?? 0) >= 0x100) return dotted(h[6], h[7]);
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) {
    return dotted(h[6], h[7]);
  }
  return null;
}

function dotted(high = 0, low = 0): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** The eight 16-bit groups of a valid IPv6 address. */
function hextets(ipv6: string): number[] {
  let text = ipv6.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".", lastColon)) {
    const [a = 0, b = 0, c = 0, d = 0] = text
      .slice(lastColon + 1)
      .split(".")
      .map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (part: string) =>
    part ? part.split(":").map((x) => Number.parseInt(x, 16)) : [];
  const start = parse(head);
  if (tail === undefined) return start;
  const end = parse(tail);
  return [...start, ...Array(8 - start.length - end.length).fill(0), ...end];
}
