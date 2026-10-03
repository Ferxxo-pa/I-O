import { randomUUID } from "node:crypto";
import { barSplit, businessDate, signedMoney, type BarSplit, type BookFlash } from "@shared/book";
import { mirrorSignedUpdate } from "./telegram";

type Entry = {
  sourceId: string;
  /** Signed effect on the balance. Positive is plus, negative is minus. */
  contributionCents: number;
  businessDate: string;
  at: number;
};

/**
 * One shared daily book.
 * The same source id replaces its previous amount, so fees and refunds land once.
 */
export class CompanyBook {
  private entries = new Map<string, Entry>();
  private flashes: BookFlash[] = [];

  record(input: {
    sourceId: string;
    contributionCents: number;
    at?: number;
    category?: string;
  }): BookFlash | null {
    const sourceId = input.sourceId.trim();
    if (!sourceId) return null;
    if (isInvestment(input.category)) return null;
    if (!Number.isInteger(input.contributionCents)) return null;

    const at = input.at ?? Date.now();
    const previous = this.entries.get(sourceId);
    const nextContribution = input.contributionCents;
    if (previous && previous.contributionCents === nextContribution && previous.at === at) return null;

    const delta = nextContribution - (previous?.contributionCents ?? 0);
    if (nextContribution === 0) this.entries.delete(sourceId);
    else {
      this.entries.set(sourceId, {
        sourceId,
        contributionCents: nextContribution,
        businessDate: businessDate(at),
        at,
      });
    }
    if (delta === 0) return null;

    const flash = { id: randomUUID(), label: signedMoney(delta) };
    this.flashes = [flash, ...this.flashes].slice(0, 8);
    void mirrorSignedUpdate(flash.label);
    return flash;
  }

  view(now = Date.now()): BarSplit & { flashes: BookFlash[] } {
    const day = businessDate(now);
    let plus = 0;
    let minus = 0;
    for (const entry of Array.from(this.entries.values())) {
      if (entry.businessDate !== day) continue;
      if (entry.contributionCents > 0) plus += entry.contributionCents;
      else minus += -entry.contributionCents;
    }
    return { ...barSplit(plus, minus), flashes: this.flashes };
  }
}

export function isInvestment(category: string | undefined): boolean {
  return typeof category === "string" && /invest/i.test(category.trim());
}

export const companyBook = new CompanyBook();
