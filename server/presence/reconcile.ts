import type { WatchPerson } from "./watch";

/**
 * A leave is ignored when the other trigger is still present and newer.
 * NFC is an explicit backup and always applies. A location leave is not
 * blocked by an older Wi-Fi latch, so a cellular leave can still clock out.
 */
export function signalFits(input: {
  event: "arrive" | "leave" | "tap";
  trigger: "geo" | "wifi" | "nfc";
  at: number;
  deviceId: string;
  watch: WatchPerson | null;
}): boolean {
  if (input.trigger === "nfc" || input.event === "tap") return true;
  if (input.event !== "leave") return true;
  const other = input.trigger === "geo" ? "wifi" : "geo";
  const source = input.watch?.sources[`phone:${input.deviceId}:${other}`];
  if (source?.present && source.at > input.at) return false;
  return true;
}
