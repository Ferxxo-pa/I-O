/** Where the shop process may listen, and which source addresses may connect. */

function normalizeIp(ip: string): string {
  let value = ip.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  return value;
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

function isRfc1918(ip: string): boolean {
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}

function isLocalIpv6(ip: string): boolean {
  return ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:");
}

/** Loopback, RFC1918, IPv6 ULA, or link-local. Never a public address. */
export function isShopSource(ip: string): boolean {
  const host = normalizeIp(ip);
  if (!host) return false;
  return isLoopback(host) || isRfc1918(host) || isLocalIpv6(host);
}

/**
 * local-relay binds a LAN address. 0.0.0.0 and a public address become the
 * first RFC1918 NIC, or 127.0.0.1 when this computer has none.
 * public mode binds loopback unless HOST is already a specific address.
 */
export function listenHost(
  envHost: string | undefined,
  mode: "local-relay" | "public",
  lan: string | null,
): string {
  const host = envHost?.trim() || "";
  if (mode === "public") {
    if (!host || host === "0.0.0.0" || host === "::" || host === "::0") return "127.0.0.1";
    return host;
  }
  if (isLoopback(host)) return host === "localhost" ? "127.0.0.1" : host;
  if (host && host !== "0.0.0.0" && host !== "::" && host !== "::0" && isShopSource(host)) return host;
  if (lan && isShopSource(lan) && !isLoopback(lan)) return lan;
  return "127.0.0.1";
}
