import {
  DEFAULT_FIGHT_SETTINGS,
  SHOP_ZONE,
  buildFightView,
  fightSettingsSchema,
  isOpenKey,
  openDaysInMonth,
  openDaysStrictlyBetween,
  startOfZonedDay,
  zonedParts,
  type FightSettings,
  type FightView,
  type HourShare,
} from "@shared/fight";
import { hashPin, verifyPin } from "../auth/pin";

export type FightHour = { personId: string; name: string; ms: number };

export type FightPersist = {
  settings: FightSettings;
  pinHash: string | null;
  streak: number;
  lastResolvedDate: string | null;
  todayCounted: boolean;
  anchorDate: string | null;
  collectedAnchor: number;
  wageAnchor: number;
  sales: number[];
  hours: FightHour[];
};

export type FightSync = {
  now: number;
  lifetimeCollected: number;
  lifetimeSettled: number;
  saleCents?: number;
  accrualSince: (since: number) => number;
  liveHoursSince: (since: number) => FightHour[];
};

function blank(): FightPersist {
  return {
    settings: { ...DEFAULT_FIGHT_SETTINGS, openWeekdays: [...DEFAULT_FIGHT_SETTINGS.openWeekdays] },
    pinHash: null,
    streak: 0,
    lastResolvedDate: null,
    todayCounted: false,
    anchorDate: null,
    collectedAnchor: 0,
    wageAnchor: 0,
    sales: [],
    hours: [],
  };
}

export class FightBook {
  private data: FightPersist = blank();
  private listener: (() => void) | null = null;
  private silent = false;

  setListener(fn: () => void) {
    this.listener = fn;
  }

  private touch() {
    if (!this.silent) this.listener?.();
  }

  pinSet(): boolean {
    return Boolean(this.data.pinHash);
  }

  verify(pin: string): boolean {
    return this.data.pinHash ? verifyPin(pin, this.data.pinHash) : false;
  }

  setPin(pin: string) {
    this.data.pinHash = hashPin(pin);
    this.touch();
  }

  updateSettings(settings: FightSettings) {
    const parsed = fightSettingsSchema.parse(settings);
    this.data.settings = {
      ...parsed,
      openWeekdays: [...parsed.openWeekdays].sort((a, b) => a - b),
    };
    this.touch();
  }

  toPersist(): FightPersist {
    return {
      settings: { ...this.data.settings, openWeekdays: [...this.data.settings.openWeekdays] },
      pinHash: this.data.pinHash,
      streak: this.data.streak,
      lastResolvedDate: this.data.lastResolvedDate,
      todayCounted: this.data.todayCounted,
      anchorDate: this.data.anchorDate,
      collectedAnchor: this.data.collectedAnchor,
      wageAnchor: this.data.wageAnchor,
      sales: this.data.sales.slice(),
      hours: this.data.hours.map((row) => ({ ...row })),
    };
  }

  hydrate(next: FightPersist | null | undefined) {
    this.silent = true;
    try {
      if (!next) {
        this.data = blank();
        return;
      }
      const settings = fightSettingsSchema.safeParse(next.settings);
      this.data = {
        ...blank(),
        ...next,
        settings: settings.success
          ? { ...settings.data, openWeekdays: [...settings.data.openWeekdays] }
          : blank().settings,
        sales: next.sales?.slice() ?? [],
        hours: (next.hours ?? []).map((row) => ({ ...row })),
      };
    } finally {
      this.silent = false;
    }
  }

  /** Dev reset. Keeps the PIN, the settings, and the streak. The caller persists. */
  resetDay() {
    this.data.anchorDate = null;
    this.data.collectedAnchor = 0;
    this.data.wageAnchor = 0;
    this.data.sales = [];
    this.data.hours = [];
    this.data.todayCounted = false;
  }

  addHours(
    personId: string,
    name: string,
    ms: number,
    ctx: { now: number; lifetimeCollected: number; lifetimeSettled: number },
  ) {
    if (!personId || ms <= 0) return;
    this.roll(ctx.now, ctx.lifetimeCollected, ctx.lifetimeSettled);
    const safeName = name.trim().slice(0, 80) || "Team";
    const safeId = personId.slice(0, 80);
    const row = this.data.hours.find((hour) => hour.personId === safeId);
    if (row) {
      row.ms += ms;
      row.name = safeName;
    } else {
      this.data.hours.push({ personId: safeId, name: safeName, ms });
    }
    this.touch();
  }

  sync(input: FightSync): FightView {
    const sale = input.saleCents && input.saleCents > 0 ? Math.round(input.saleCents) : 0;
    const baselineCollected = input.lifetimeCollected - sale;
    const rolled = this.roll(input.now, baselineCollected, input.lifetimeSettled);
    if (sale > 0) this.data.sales.push(sale);
    if (this.data.sales.length > 500) this.data.sales.splice(0, this.data.sales.length - 500);

    const today = zonedParts(input.now, SHOP_ZONE).key;
    const midnight = startOfZonedDay(input.now, SHOP_ZONE);
    const collected = Math.max(0, input.lifetimeCollected - this.data.collectedAnchor);
    const wages =
      Math.max(0, input.lifetimeSettled - this.data.wageAnchor) +
      Math.max(0, input.accrualSince(midnight));
    const clearedNow = this.considerClear(today, collected, wages);
    if (rolled || sale > 0 || clearedNow) this.touch();
    return this.compose(today, collected, wages, input.liveHoursSince(midnight));
  }

  private target(date: string, wages: number): number {
    const [year, month] = date.split("-").map(Number);
    const openDays = openDaysInMonth(year, month, this.data.settings.openWeekdays, SHOP_ZONE);
    return buildFightView({
      date,
      pinSet: this.pinSet(),
      collectedCents: 0,
      wageCents: wages,
      sales: [],
      hours: [],
      streak: this.data.streak,
      settings: this.data.settings,
      openDays,
    }).breakEvenCents;
  }

  private considerClear(today: string, collected: number, wages: number): boolean {
    if (this.data.todayCounted) return false;
    if (!isOpenKey(today, this.data.settings.openWeekdays)) return false;
    const target = this.target(today, wages);
    if (target <= 0 || collected < target) return false;
    this.data.streak += 1;
    this.data.todayCounted = true;
    this.data.lastResolvedDate = today;
    return true;
  }

  private applyClosedDay(date: string, collected: number, wages: number): boolean {
    if (!isOpenKey(date, this.data.settings.openWeekdays)) return false;
    if (this.data.lastResolvedDate === date) return false;
    const target = this.target(date, wages);
    if (target > 0 && collected >= target) this.data.streak += 1;
    else this.data.streak = Math.max(0, this.data.streak - 1);
    this.data.lastResolvedDate = date;
    return true;
  }

  private roll(now: number, lifetimeCollected: number, lifetimeSettled: number): boolean {
    const today = zonedParts(now, SHOP_ZONE).key;
    let changed = false;
    if (
      this.data.anchorDate &&
      (lifetimeCollected < this.data.collectedAnchor || lifetimeSettled < this.data.wageAnchor)
    ) {
      this.data.collectedAnchor = Math.max(0, lifetimeCollected);
      this.data.wageAnchor = Math.max(0, lifetimeSettled);
      this.data.sales = [];
      this.data.hours = [];
      this.data.todayCounted = false;
      changed = true;
    }
    if (!this.data.anchorDate) {
      this.data.anchorDate = today;
      this.data.collectedAnchor = Math.max(0, lifetimeCollected);
      this.data.wageAnchor = Math.max(0, lifetimeSettled);
      return true;
    }
    if (this.data.anchorDate === today) return changed;
    const collected = Math.max(0, lifetimeCollected - this.data.collectedAnchor);
    const wages = Math.max(0, lifetimeSettled - this.data.wageAnchor);
    this.applyClosedDay(this.data.anchorDate, collected, wages);
    const missed = openDaysStrictlyBetween(
      this.data.anchorDate,
      today,
      this.data.settings.openWeekdays,
      SHOP_ZONE,
    );
    for (let i = 0; i < missed; i++) this.data.streak = Math.max(0, this.data.streak - 1);
    this.data.anchorDate = today;
    this.data.collectedAnchor = Math.max(0, lifetimeCollected);
    this.data.wageAnchor = Math.max(0, lifetimeSettled);
    this.data.sales = [];
    this.data.hours = [];
    this.data.todayCounted = false;
    return true;
  }

  private compose(date: string, collected: number, wages: number, live: FightHour[]): FightView {
    const [year, month] = date.split("-").map(Number);
    const hours = mergeHours(this.data.hours, live);
    return buildFightView({
      date,
      pinSet: this.pinSet(),
      collectedCents: collected,
      wageCents: wages,
      sales: this.data.sales,
      hours: hours.map((row) => ({ id: row.personId, name: row.name, ms: row.ms })),
      streak: this.data.streak,
      settings: this.data.settings,
      openDays: openDaysInMonth(year, month, this.data.settings.openWeekdays, SHOP_ZONE),
    });
  }
}

function mergeHours(saved: FightHour[], live: FightHour[]): FightHour[] {
  const map = new Map<string, FightHour>();
  for (const row of saved) map.set(row.personId, { ...row });
  for (const row of live) {
    const prev = map.get(row.personId);
    if (prev) {
      prev.ms += row.ms;
      if (row.name) prev.name = row.name;
    } else {
      map.set(row.personId, { ...row });
    }
  }
  return Array.from(map.values());
}

export const fightBook = new FightBook();
