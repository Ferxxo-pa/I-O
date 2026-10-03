/** America/Chicago business day, YYYY-MM-DD. */
export function businessDate(at: number, timeZone = "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/** Signed dollars. Whole amounts drop the cents. Minus uses −. */
export function signedMoney(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = abs / 100;
  const text = Number.isInteger(dollars)
    ? dollars.toLocaleString("en-US")
    : dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (cents > 0) return `+$${text}`;
  if (cents < 0) return `−$${text}`;
  return `$${text}`;
}

export type BookFlash = { id: string; label: string };

export type BarSplit = {
  plusCents: number;
  minusCents: number;
  balanceCents: number;
  green: number;
  red: number;
  tie: boolean;
  neutral: boolean;
};

/** Green is plus ÷ combined. Red is the rest. Zero on both sides stays neutral. */
export function barSplit(plusCents: number, minusCents: number): BarSplit {
  const plus = Math.max(0, Math.round(plusCents));
  const minus = Math.max(0, Math.round(minusCents));
  const combined = plus + minus;
  const balanceCents = plus - minus;
  if (combined === 0) {
    return { plusCents: 0, minusCents: 0, balanceCents: 0, green: 0, red: 0, tie: false, neutral: true };
  }
  const green = (plus / combined) * 100;
  return {
    plusCents: plus,
    minusCents: minus,
    balanceCents,
    green,
    red: 100 - green,
    tie: plus === minus,
    neutral: false,
  };
}
