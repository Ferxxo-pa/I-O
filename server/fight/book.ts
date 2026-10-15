import {
  DEFAULT_FIGHT_SETTINGS,
  SHOP_ZONE,
  buildFightView,
  fightSettingsSchema,
  isOpenKey,
  openDaysInMonth,
  openDaysStrictlyBetween,
  potCents,
  startOfZonedDay,
  zonedParts,
  type FightSettings,
  type FightView,
} from "@shared/fight";
import {
  DEFAULT_LEVEL_RULES,
  advanceLevel,
  applyWeekStreak,
  levelRulesSchema,
  buildWeekPips,
  mondayOf,
  sameScope,
  scopeKey,
  summarizeWeek,
  type DayPot,
  type LevelRules,
  type LevelStep,
  type OpsView,
  type ShopScope,
} from "@shared/ops";
import {
  closeWeek,
  depositCushion,
  netOfSale,
  splitSale,
  countOpenDays,
  summarizeWeekBar,
  weekBarTarget,
  weekMonday,
  type CushionLot,
  type WeekSale,
  type WeekView,
} from "@shared/week";
import { hashPin, verifyPin } from "../auth/pin";
import { currentScope } from "../company";

export type FightHour = { personId: string; name: string; ms: number };

export type ClosedDay = ShopScope & {
  date: string;
  collectedCents: number;
  wageCents: number;
  breakEvenCents: number;
  potCents: number;
  payoutPotCents: number;
  cleared: boolean;
  hours: FightHour[];
};

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
  level: number;
  consecutiveClears: number;
  levelNotedDate: string | null;
  levelRules: LevelRules;
  history: LevelStep[];
  days: ClosedDay[];
  resolvedWeeks: string[];
  lastResolvedWeek: string | null;
  lastWeekScope: string | null;
  weekStreak: number;
  webhookSeenAt: number | null;
  weekStart: string | null;
  ownAppliedCents: number;
  weeksCovered: number;
  cushion: CushionLot[];
  weekSaleIds: string[];
};

export type FightSync = {
  now: number;
  lifetimeCollected: number;
  lifetimeSettled: number;
  saleCents?: number;
  weekSale?: WeekSale;
  accrualSince: (since: number) => number;
  liveHoursSince: (since: number) => FightHour[];
};

type LiveDay = {
  now: number;
  date: string;
  collected: number;
  wages: number;
  hours: FightHour[];
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
    level: 0,
    consecutiveClears: 0,
    levelNotedDate: null,
    levelRules: {
      clearsInARow: DEFAULT_LEVEL_RULES.clearsInARow,
      table: DEFAULT_LEVEL_RULES.table.map((row) => ({ ...row })),
    },
    history: [],
    days: [],
    resolvedWeeks: [],
    lastResolvedWeek: null,
    lastWeekScope: null,
    weekStreak: 0,
    webhookSeenAt: null,
    weekStart: null,
    ownAppliedCents: 0,
    weeksCovered: 0,
    cushion: [],
    weekSaleIds: [],
  };
}

export class FightBook {
  private data: FightPersist = blank();
  private listener: (() => void) | null = null;
  private silent = false;
  private live: LiveDay | null = null;

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

  updateLevelRules(rules: LevelRules) {
    const parsed = levelRulesSchema.parse(rules);
    this.data.levelRules = {
      clearsInARow: parsed.clearsInARow,
      table: [...parsed.table].sort((a, b) => a.level - b.level).map((row) => ({ ...row })),
    };
    this.touch();
  }

  signals(): { pinSet: boolean; rentEntered: boolean; webhookSeen: boolean } {
    return {
      pinSet: this.pinSet(),
      rentEntered: this.data.settings.rentEntered,
      webhookSeen: Boolean(this.data.webhookSeenAt),
    };
  }

  scopeHint(): ShopScope | null {
    const row = this.data.days[0] ?? this.data.history[0];
    if (!row) return null;
    return { companyId: row.companyId, locationId: row.locationId };
  }

  markWebhook(at: number) {
    this.data.webhookSeenAt = at;
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
      level: this.data.level,
      consecutiveClears: this.data.consecutiveClears,
      levelNotedDate: this.data.levelNotedDate,
      levelRules: {
        clearsInARow: this.data.levelRules.clearsInARow,
        table: this.data.levelRules.table.map((row) => ({ ...row })),
      },
      history: this.data.history.map((row) => ({ ...row })),
      days: this.data.days.map((row) => ({ ...row, hours: row.hours.map((hour) => ({ ...hour })) })),
      resolvedWeeks: this.data.resolvedWeeks.slice(),
      lastResolvedWeek: this.data.lastResolvedWeek,
      lastWeekScope: this.data.lastWeekScope,
      weekStreak: this.data.weekStreak,
      webhookSeenAt: this.data.webhookSeenAt,
      weekStart: this.data.weekStart,
      ownAppliedCents: this.data.ownAppliedCents,
      weeksCovered: this.data.weeksCovered,
      cushion: this.data.cushion.map((lot) => ({ ...lot })),
      weekSaleIds: this.data.weekSaleIds.slice(),
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
      const rules = levelRulesSchema.safeParse(next.levelRules);
      this.data = {
        ...blank(),
        ...next,
        settings: settings.success
          ? { ...settings.data, openWeekdays: [...settings.data.openWeekdays] }
          : blank().settings,
        levelRules: rules.success
          ? { clearsInARow: rules.data.clearsInARow, table: rules.data.table.map((row) => ({ ...row })) }
          : blank().levelRules,
        level: next.level ?? 0,
        consecutiveClears: next.consecutiveClears ?? 0,
        levelNotedDate: next.levelNotedDate ?? null,
        weekStreak: next.weekStreak ?? 0,
        lastResolvedWeek: next.lastResolvedWeek ?? null,
        lastWeekScope: next.lastWeekScope ?? null,
        webhookSeenAt: next.webhookSeenAt ?? null,
        weekStart: next.weekStart ?? null,
        ownAppliedCents: next.ownAppliedCents ?? 0,
        weeksCovered: next.weeksCovered ?? 0,
        cushion: (next.cushion ?? []).map((lot) => ({ ...lot })),
        weekSaleIds: next.weekSaleIds?.slice() ?? [],
        sales: next.sales?.slice() ?? [],
        hours: (next.hours ?? []).map((row) => ({ ...row })),
        history: (next.history ?? []).map((row) => ({ ...row })),
        days: (next.days ?? []).map((row) => ({ ...row, hours: row.hours.map((hour) => ({ ...hour })) })),
        resolvedWeeks: next.resolvedWeeks?.slice() ?? [],
      };
    } finally {
      this.silent = false;
    }
  }

  /** Dev reset. Keeps the PIN, the settings, the streak, and levels. The caller persists. */
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
    if (input.weekSale) this.applyWeekSale(input.weekSale, input.now);
    else this.rollWeekTo(weekMonday(zonedParts(input.now, SHOP_ZONE).key));
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
    return this.compose(today, collected, wages, input.liveHoursSince(midnight), input.now);
  }

  opsView(): OpsView {
    const scope = currentScope();
    const today = this.live?.date ?? zonedParts(Date.now(), SHOP_ZONE).key;
    const monday = mondayOf(today);
    const days = this.weekDays(monday, scope);
    const summary = summarizeWeek(
      monday,
      days.map(toDayPot),
      this.data.settings,
    );
    const liveTarget = this.live ? this.target(this.live.date, this.live.wages) : 0;
    const todayCleared = Boolean(this.live && liveTarget > 0 && this.live.collected >= liveTarget);
    const pips = buildWeekPips({
      today,
      openWeekdays: this.data.settings.openWeekdays,
      clearedDates: days.filter((day) => day.cleared).map((day) => day.date),
      todayCleared,
    });
    return {
      scope,
      level: this.data.level,
      consecutiveClears: this.data.consecutiveClears,
      rules: {
        clearsInARow: this.data.levelRules.clearsInARow,
        table: this.data.levelRules.table.map((row) => ({ ...row })),
      },
      history: this.data.history
        .filter((row) => sameScope(row, scope))
        .slice(-8)
        .map((row) => ({
          at: row.at,
          date: row.date,
          fromLevel: row.fromLevel,
          toLevel: row.toLevel,
          reason: row.reason,
        })),
      weekStreak: this.data.weekStreak,
      week: {
        weekStart: summary.weekStart,
        collectedCents: summary.collectedCents,
        breakEvenCents: summary.breakEvenCents,
        cleared: summary.cleared,
      },
      crew: [],
      pips,
    };
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

  private noteClear(date: string, cleared: boolean) {
    if (this.data.levelNotedDate === date) return;
    this.data.levelNotedDate = date;
    const next = advanceLevel({
      level: this.data.level,
      consecutive: this.data.consecutiveClears,
      rules: this.data.levelRules,
      cleared,
    });
    if (next.event) {
      const scope = currentScope();
      this.data.history.push({
        at: Date.now(),
        date,
        fromLevel: next.event.from,
        toLevel: next.event.to,
        reason: next.event.reason,
        companyId: scope.companyId,
        locationId: scope.locationId,
      });
      if (this.data.history.length > 200) this.data.history.splice(0, this.data.history.length - 200);
    }
    this.data.level = next.level;
    this.data.consecutiveClears = next.consecutive;
  }

  private considerClear(today: string, collected: number, wages: number): boolean {
    if (this.data.todayCounted) return false;
    if (!isOpenKey(today, this.data.settings.openWeekdays)) return false;
    const target = this.target(today, wages);
    if (target <= 0 || collected < target) return false;
    this.data.streak += 1;
    this.data.todayCounted = true;
    this.data.lastResolvedDate = today;
    this.noteClear(today, true);
    return true;
  }

  private applyClosedDay(date: string, collected: number, wages: number): boolean {
    if (!isOpenKey(date, this.data.settings.openWeekdays)) return false;
    if (this.data.lastResolvedDate === date) return false;
    const target = this.target(date, wages);
    const cleared = target > 0 && collected >= target;
    if (cleared) this.data.streak += 1;
    else this.data.streak = Math.max(0, this.data.streak - 1);
    this.data.lastResolvedDate = date;
    this.noteClear(date, cleared);
    return true;
  }

  private archiveDay(date: string, collected: number, wages: number) {
    if (!isOpenKey(date, this.data.settings.openWeekdays)) return;
    const scope = currentScope();
    if (this.data.days.some((day) => day.date === date && sameScope(day, scope))) return;
    const target = this.target(date, wages);
    const cleared = target > 0 && collected >= target;
    const pot = cleared ? potCents(collected, target, this.data.settings.potBps) : 0;
    this.data.days.push({
      ...scope,
      date,
      collectedCents: collected,
      wageCents: wages,
      breakEvenCents: target,
      potCents: pot,
      payoutPotCents: pot,
      cleared,
      hours: this.data.hours.map((row) => ({ ...row })),
    });
    if (this.data.days.length > 400) this.data.days.splice(0, this.data.days.length - 400);
  }

  private weekDays(monday: string, scope: ShopScope): ClosedDay[] {
    const saved = this.data.days.filter((day) => sameScope(day, scope) && mondayOf(day.date) === monday);
    if (!this.live || !isOpenKey(this.live.date, this.data.settings.openWeekdays)) return saved;
    if (mondayOf(this.live.date) !== monday) return saved;
    if (saved.some((day) => day.date === this.live?.date)) return saved;
    const target = this.target(this.live.date, this.live.wages);
    const cleared = target > 0 && this.live.collected >= target;
    const pot = cleared ? potCents(this.live.collected, target, this.data.settings.potBps) : 0;
    return [
      ...saved,
      {
        ...scope,
        date: this.live.date,
        collectedCents: this.live.collected,
        wageCents: this.live.wages,
        breakEvenCents: target,
        potCents: pot,
        payoutPotCents: pot,
        cleared,
        hours: this.live.hours.map((row) => ({ ...row })),
      },
    ];
  }

  private finishWeek(monday: string, days: ClosedDay[], scope: ShopScope) {
    const key = `${scopeKey(scope)}|${monday}`;
    if (this.data.resolvedWeeks.includes(key)) return;
    if (this.data.lastWeekScope === scopeKey(scope) && this.data.lastResolvedWeek) {
      let cursor = addWeek(this.data.lastResolvedWeek);
      while (cursor < monday) {
        this.data.weekStreak = applyWeekStreak(this.data.weekStreak, false);
        cursor = addWeek(cursor);
      }
    }
    const summary = summarizeWeek(monday, days.map(toDayPot), this.data.settings);
    this.data.weekStreak = applyWeekStreak(this.data.weekStreak, summary.cleared);
    this.data.lastWeekScope = scopeKey(scope);
    this.data.lastResolvedWeek = monday;
    this.data.resolvedWeeks.push(key);
    if (this.data.resolvedWeeks.length > 200) this.data.resolvedWeeks.splice(0, this.data.resolvedWeeks.length - 200);
  }

  private resolvePastWeeks(today: string) {
    const current = mondayOf(today);
    const scope = currentScope();
    const grouped = new Map<string, ClosedDay[]>();
    for (const day of this.data.days) {
      if (!sameScope(day, scope)) continue;
      const monday = mondayOf(day.date);
      if (monday >= current) continue;
      const list = grouped.get(monday) ?? [];
      list.push(day);
      grouped.set(monday, list);
    }
    for (const monday of Array.from(grouped.keys()).sort()) {
      this.finishWeek(monday, grouped.get(monday) ?? [], scope);
    }
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
    this.archiveDay(this.data.anchorDate, collected, wages);
    const missed = openDaysStrictlyBetween(
      this.data.anchorDate,
      today,
      this.data.settings.openWeekdays,
      SHOP_ZONE,
    );
    for (let i = 0; i < missed; i++) this.data.streak = Math.max(0, this.data.streak - 1);
    if (missed > 0) this.data.consecutiveClears = 0;
    this.data.anchorDate = today;
    this.data.collectedAnchor = Math.max(0, lifetimeCollected);
    this.data.wageAnchor = Math.max(0, lifetimeSettled);
    this.data.sales = [];
    this.data.hours = [];
    this.data.todayCounted = false;
    this.resolvePastWeeks(today);
    return true;
  }

  private compose(date: string, collected: number, wages: number, live: FightHour[], now: number): FightView {
    const [year, month] = date.split("-").map(Number);
    const hours = mergeHours(this.data.hours, live);
    this.live = { now, date, collected, wages, hours };
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
      week: this.weekView(date),
    });
  }

  private weekTarget(monday: string): number {
    const [year, month] = monday.split("-").map(Number);
    return weekBarTarget({
      weeklyTargetCents: this.data.settings.weeklyTargetCents,
      materialsBps: this.data.settings.materialsBps,
      feeBps: this.data.settings.feeBps,
      rentMonthlyCents: this.data.settings.rentMonthlyCents,
      rentEntered: this.data.settings.rentEntered,
      weekOpenDays: countOpenDays(monday, this.data.settings.openWeekdays),
      monthOpenDays: openDaysInMonth(year, month, this.data.settings.openWeekdays, SHOP_ZONE),
    });
  }

  private weekView(today: string): WeekView {
    const monday = weekMonday(today);
    const [year, month] = monday.split("-").map(Number);
    return summarizeWeekBar({
      today,
      ownCents: this.data.ownAppliedCents,
      lots: this.data.cushion,
      weeksCovered: this.data.weeksCovered,
      weeklyTargetCents: this.data.settings.weeklyTargetCents,
      materialsBps: this.data.settings.materialsBps,
      feeBps: this.data.settings.feeBps,
      rentMonthlyCents: this.data.settings.rentMonthlyCents,
      rentEntered: this.data.settings.rentEntered,
      openWeekdays: this.data.settings.openWeekdays,
      monthOpenDays: openDaysInMonth(year, month, this.data.settings.openWeekdays, SHOP_ZONE),
    });
  }

  private rollWeekTo(monday: string) {
    if (!this.data.weekStart) {
      this.data.weekStart = monday;
      return;
    }
    while (this.data.weekStart < monday) {
      const closed = closeWeek({
        weekStart: this.data.weekStart,
        ownCents: this.data.ownAppliedCents,
        lots: this.data.cushion,
        targetCents: this.weekTarget(this.data.weekStart),
        weeksCovered: this.data.weeksCovered,
      });
      this.data.cushion = closed.lots;
      this.data.weeksCovered = closed.weeksCovered;
      this.data.ownAppliedCents = 0;
      this.data.weekStart = closed.weekStart;
    }
  }

  private applyWeekSale(sale: WeekSale, nowMs: number) {
    if (!sale.id || this.data.weekSaleIds.includes(sale.id)) return;
    this.data.weekSaleIds.push(sale.id);
    if (this.data.weekSaleIds.length > 500) this.data.weekSaleIds.splice(0, this.data.weekSaleIds.length - 500);
    const payMonday = weekMonday(zonedParts(sale.paidAt, SHOP_ZONE).key);
    const todayMonday = weekMonday(zonedParts(nowMs, SHOP_ZONE).key);
    const bucket = payMonday > todayMonday ? todayMonday : payMonday;
    this.rollWeekTo(bucket);
    const net = netOfSale(
      sale.grossCents,
      sale.materialsCents,
      this.data.settings.materialsBps,
      this.data.settings.feeBps,
    );
    const split = splitSale(net);
    if (this.data.weekStart === bucket) {
      this.data.ownAppliedCents += split.barCents;
      this.data.cushion = depositCushion(this.data.cushion, split.bankCents, bucket);
    } else {
      this.data.cushion = depositCushion(this.data.cushion, split.bankCents, payMonday);
    }
    this.rollWeekTo(todayMonday);
  }
}

function addWeek(monday: string): string {
  return mondayOf(addDaysFrom(monday, 7));
}

function addDaysFrom(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function toDayPot(day: ClosedDay): DayPot {
  return {
    date: day.date,
    collectedCents: day.collectedCents,
    wageCents: day.wageCents,
    potCents: day.potCents,
    payoutPotCents: day.payoutPotCents,
    hours: day.hours.map((row) => ({ id: row.personId, name: row.name, ms: row.ms })),
  };
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
