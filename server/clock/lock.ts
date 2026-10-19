const tails = new Map<string, Promise<void>>();

/**
 * One clock writer per person. A second desktop and a phone wait, then see the
 * shift the first writer already opened, so Square gets a single timecard.
 */
export function withPersonLock<T>(personId: string, fn: () => Promise<T>): Promise<T> {
  const key = personId || "_";
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, settled);
  void settled.finally(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  return run;
}
