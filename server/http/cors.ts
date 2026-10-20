import type { Express } from "express";

const ALLOW_HEADERS = "authorization, content-type, x-desk-token, x-owner-key, x-person-id, x-shop-pin";
const ALLOW_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";

/** Unset or "*" allows any browser origin. A comma list allows only those origins. */
export function originAllowed(origin: string): boolean {
  const raw = process.env.IO_CORS_ORIGINS?.trim() ?? "";
  if (!raw || raw === "*") return true;
  return raw.split(",").some((entry) => entry.trim() === origin);
}

/** Employee computers call this server from their own browser. The shop PIN still gates the clock. */
export function installRemoteCors(app: Express) {
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && originAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
      res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
}
