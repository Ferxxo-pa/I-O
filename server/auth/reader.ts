import type { Request } from "express";
import { assertShopPin } from "./pin";
import { companyView } from "../company";
import { fightBook } from "../fight/book";
import { ioMode } from "../mode";

/** True when this process is meant to be reached from the public internet. */
export function publicExposure(): boolean {
  return Boolean(process.env.PUBLIC_BASE_URL?.trim());
}

/** local-relay and a public URL both keep the clock behind a PIN or the owner key. */
export function shopLocked(): boolean {
  return publicExposure() || ioMode() === "local-relay";
}

/**
 * Clock, wages, and the presence board.
 * Open only in public mode with no PUBLIC_BASE_URL (tests and a tunnel that is not up yet).
 * Otherwise the shop PIN or the owner key is required.
 */
export function assertPublicReader(req: Request): void {
  if (!shopLocked()) return;
  const ownerKey = req.header("x-owner-key")?.trim() ?? "";
  if (ownerKey && companyView(ownerKey).owner) return;
  const ip = req.ip || req.socket.remoteAddress || "local";
  assertShopPin(req.header("x-shop-pin"), ip, fightBook.pinSet(), (pin) => fightBook.verify(pin));
}
