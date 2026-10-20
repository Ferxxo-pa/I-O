export const IO_VERSION = "0.2.0";

export type ReleaseNote = {
  version: string;
  bullets: string[];
};

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.2.0",
    bullets: [
      "Phones post plain events. A cellular leave still clocks that person out.",
      "An NFC tag tap is a backup clock on the same path as the strip.",
      "The strip updates live from the shop computer and shows this notice.",
      "The shop computer can install a signed update overnight and rolls back if the health check fails.",
    ],
  },
  {
    version: "0.1.0",
    bullets: ["The shop clock runs on the strip. Phone arrive and leave use the same tap."],
  },
];

export function releaseNotes(): { version: string; notice: string; entries: ReleaseNote[] } {
  const newest = RELEASE_NOTES[0];
  return {
    version: IO_VERSION,
    notice: newest?.bullets[0] ?? "",
    entries: RELEASE_NOTES,
  };
}
