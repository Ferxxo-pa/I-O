import type { Request } from "express";
import { assertShopPin } from "./pin";
import { companyView } from "../company";
import { fightBook } from "../fight/book";

/** True when this process is meant to be reached from the public internet. */
export function publicExposure(): boolean {
  return Boolean(process.env.PUBLIC_BASE_URL?.trim());
}

/**
 * Clock, wages, and the presence board. Open on localhost.
 * On a public URL, the shop PIN or the owner key is required.
 */
export function assertPublicReader(req: Request): void {
  if (!publicExposure()) return;
  const ownerKey = req.header("x-owner-key")?.trim() ?? "";
  if (ownerKey && companyView(ownerKey).owner) return;
  const ip = req.ip || req.socket.remoteAddress || "local";
  assertShopPin(req.header("x-shop-pin"), ip, fightBook.pinSet(), (pin) => fightBook.verify(pin));
}
