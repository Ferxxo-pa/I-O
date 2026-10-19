/**
 * Turn data/io-state.json into rows the hosted book can load.
 * The Square access token is not in that file. Pass it separately so it can be sealed.
 */

export type ImportedShop = {
  company: {
    id: string;
    name: string | null;
    code: string | null;
    locationId: string;
    shop: unknown;
    fight: unknown;
    pinHash: string | null;
    ownerKey: string | null;
  };
  people: Array<{
    id: string;
    name: string;
    points: number;
    madeCents: number;
    hourlyCents: number;
    status: string;
    consentedAt: number | null;
    consentRevokedAt: number | null;
    consentNote: string | null;
    squareTeamMemberId: string | null;
    squareLocationId: string | null;
  }>;
  sessions: Array<{
    personId: string;
    name: string;
    hourlyCents: number;
    clockedIn: boolean;
    clockedInAt: number | null;
    hourSegmentStartedAt: number | null;
    outputCents: number;
    timecardId: string | null;
    holdAt: number | null;
    source: string | null;
  }>;
};

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function rowsFromIoState(raw: unknown): ImportedShop {
  const file = obj(raw);
  const company = obj(file.company);
  const fight = obj(file.fight);
  const peopleRaw = Array.isArray(company.people) ? company.people : [];
  const shifts = Array.isArray(file.shifts) ? file.shifts : [];
  const id = typeof company.id === "string" && company.id ? company.id : "shop";
  const locationId = typeof company.locationId === "string" && company.locationId ? company.locationId : "local";
  return {
    company: {
      id,
      name: typeof company.name === "string" ? company.name : null,
      code: typeof company.code === "string" ? company.code : null,
      locationId,
      shop: company.shop ?? {},
      fight: file.fight ?? null,
      pinHash: typeof fight.pinHash === "string" ? fight.pinHash : null,
      ownerKey: typeof file.ownerKey === "string" ? file.ownerKey : null,
    },
    people: peopleRaw.map((entry) => {
      const person = obj(entry);
      return {
        id: String(person.id ?? ""),
        name: String(person.name ?? ""),
        points: Number(person.points ?? 0) || 0,
        madeCents: Number(person.madeCents ?? 0) || 0,
        hourlyCents: Number(person.hourlyCents ?? 2000) || 2000,
        status: person.status === "removed" ? "removed" : "active",
        consentedAt: typeof person.consentedAt === "number" ? person.consentedAt : null,
        consentRevokedAt: typeof person.consentRevokedAt === "number" ? person.consentRevokedAt : null,
        consentNote: typeof person.consentNote === "string" ? person.consentNote : null,
        squareTeamMemberId: typeof person.squareTeamMemberId === "string" ? person.squareTeamMemberId : null,
        squareLocationId: typeof person.squareLocationId === "string" ? person.squareLocationId : null,
      };
    }).filter((person) => person.id && person.name),
    sessions: shifts.map((entry) => {
      const shift = obj(entry);
      return {
        personId: String(shift.personId ?? ""),
        name: String(shift.name ?? ""),
        hourlyCents: Number(shift.hourlyCents ?? 0) || 0,
        clockedIn: Boolean(shift.clockedIn),
        clockedInAt: typeof shift.clockedInAt === "number" ? shift.clockedInAt : null,
        hourSegmentStartedAt: typeof shift.hourSegmentStartedAt === "number" ? shift.hourSegmentStartedAt : null,
        outputCents: Number(shift.outputCents ?? 0) || 0,
        timecardId: typeof shift.timecardId === "string" ? shift.timecardId : null,
        holdAt: typeof shift.holdAt === "number" ? shift.holdAt : null,
        source: typeof shift.source === "string" ? shift.source : null,
      };
    }).filter((shift) => shift.personId),
  };
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
