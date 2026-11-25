/**
 * The server only listens on 127.0.0.1, but any website open in the user's browser can still
 * send requests to it. These checks stop that:
 * - Host must be localhost/127.0.0.1 (blocks DNS rebinding, where evil.com resolves to 127.0.0.1).
 * - Requests that change things must not come from another origin (browsers always send Origin on those).
 * - JSON bodies must be sent as application/json, which a cross-site form or no-cors fetch cannot do
 *   without a CORS preflight that this server never approves.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostname(hostHeader: string): string {
  // "[::1]:4321" -> "[::1]", "localhost:4321" -> "localhost"
  return hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
}

export function isLocalHost(hostHeader: string | undefined): boolean {
  return Boolean(hostHeader) && LOCAL_HOSTS.has(hostname(hostHeader!.toLowerCase()));
}

export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (curl, the website's server) send no Origin
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && isLocalHost(url.host);
  } catch {
    return false; // includes "null" (sandboxed iframes, file://)
  }
}

export interface RequestFacts {
  readonly method: string;
  readonly host?: string;
  readonly origin?: string;
}

/** Returns a reason to refuse the request, or undefined if it's allowed. */
export function rejectReason({ method, host, origin }: RequestFacts): string | undefined {
  if (!isLocalHost(host)) return "Unknown host.";
  if (method !== "GET" && method !== "HEAD" && !isLocalOrigin(origin)) return "Cross-site request refused.";
  return undefined;
}

export function isJsonContentType(contentType: string | undefined): boolean {
  return /^application\/json\s*(;|$)/i.test(contentType ?? "");
}
