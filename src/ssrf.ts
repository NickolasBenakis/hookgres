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
  "::/128",
  "::1/128",
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
  addCidr(BLOCKED, cidr);
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

export type BlockPrivateAddressesOption = boolean | { allow: string[] };

export class AddressGuard {
  private readonly allowed = new BlockList();

  constructor(option: BlockPrivateAddressesOption) {
    if (typeof option !== "object") return;
    if (!Array.isArray(option.allow)) {
      throw new Error("blockPrivateAddresses.allow must be an array");
    }
    for (const entry of option.allow) {
      if (typeof entry !== "string" || !addCidr(this.allowed, entry)) {
        throw new Error(
          `Invalid blockPrivateAddresses.allow entry ${JSON.stringify(entry)}: use an IP address or CIDR, like "10.1.2.0/24" or "fd00::5"`,
        );
      }
    }
  }

  isBlocked(address: string): boolean {
    const ip = normalise(address);
    const family = isIP(ip);
    if (family === 4 && this.allowed.check(ip, "ipv4")) return false;
    if (family === 6) {
      if (this.allowed.check(ip, "ipv6")) return false;
      const embedded = embeddedIPv4(ip);
      if (embedded && this.allowed.check(embedded, "ipv4")) return false;
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
 */
export function guardedTransport(guard: AddressGuard): Transport {
  const agents = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({ keepAlive: true }),
  };
  const lookup = guard.lookup();
  return (url, { method, headers, body, signal }) =>
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

      const secure = target.protocol === "https:";
      const request = (secure ? https : http).request(
        target,
        {
          method,
          headers: { ...headers, "content-length": Buffer.byteLength(body) },
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

/** Adds `"10.0.0.0/8"` or `"fd00::5"` to a list; returns false if invalid. */
function addCidr(list: BlockList, cidr: string): boolean {
  const [address = "", prefix, extra] = cidr.split("/");
  const family = isIP(address);
  if (!family || address.includes("%") || extra !== undefined) return false;
  const max = family === 4 ? 32 : 128;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return false;
  const bits = prefix === undefined ? max : Number(prefix);
  if (bits > max) return false;
  list.addSubnet(address, bits, family === 4 ? "ipv4" : "ipv6");
  return true;
}

/**
 * The IPv4 address inside an IPv4-mapped (::ffff:0:0/96), IPv4-compatible
 * (::/96), NAT64 (64:ff9b::/96) or 6to4 (2002::/16) IPv6 address, or null.
 */
function embeddedIPv4(ipv6: string): string | null {
  const h = hextets(ipv6);
  const zeros = (from: number, to: number) =>
    h.slice(from, to).every((x) => x === 0);
  if (h[0] === 0x2002) return dotted(h[1], h[2]);
  if (zeros(0, 5) && (h[5] === 0 || h[5] === 0xffff)) return dotted(h[6], h[7]);
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
