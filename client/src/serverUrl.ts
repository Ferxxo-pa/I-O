/**
 * Where the strip sends API calls.
 * Empty means this page's own host, which is the central server when an
 * employee opens https://that-server/?join=CODE. Set VITE_IO_SERVER_URL
 * only when the strip is built on a different host.
 */
export function ioServerOrigin(): string {
  const raw = import.meta.env.VITE_IO_SERVER_URL;
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\/+$/, "");
}

export function apiUrl(path: string): string {
  const origin = ioServerOrigin();
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return origin ? `${origin}${suffix}` : suffix;
}
