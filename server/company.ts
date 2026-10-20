import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { DEFAULT_SHOP, type BoardPerson, type CompanyState, type ShopConfig } from "@shared/schema";
import { squareConfigured } from "./square/client";

let company: CompanyState = {
  name: null,
  code: null,
  people: [],
  id: null,
  locationId: null,
  shop: { ...DEFAULT_SHOP },
};

let ownerKey: string | null = null;
let onChange: (() => void) | null = null;

export type CompanyView = CompanyState & {
  owner: boolean;
  square: boolean;
  ownerKey?: string;
};

export function setCompanyListener(fn: () => void) {
  onChange = fn;
}

function touch() {
  onChange?.();
}

export function getCompany(): CompanyState {
  return company;
}

export function getOwnerKey(): string | null {
  return ownerKey;
}

export function hydrateCompany(next: CompanyState, key: string | null = null) {
  company = {
    name: next.name,
    code: next.code,
    people: next.people.map((person) => ({ ...person })),
    id: next.id ?? null,
    locationId: next.locationId ?? null,
    shop: { ...DEFAULT_SHOP, ...next.shop },
  };
  ownerKey = key;
}

/** One company id and one location id for every record this process writes. */
export function ensureScope(
  locationFromEnv: string | null,
  hint: { companyId: string; locationId: string } | null,
): { companyId: string; locationId: string } {
  const companyId = company.id || hint?.companyId || randomUUID();
  const fromEnv = locationFromEnv?.trim() || "";
  const locationId = company.locationId || fromEnv || hint?.locationId || "local";
  const changed = company.id !== companyId || company.locationId !== locationId;
  if (changed) {
    company = { ...company, id: companyId, locationId };
    touch();
  }
  return { companyId, locationId };
}

export function currentScope(): { companyId: string; locationId: string } {
  return {
    companyId: company.id || "shop",
    locationId: company.locationId || process.env.SQUARE_LOCATION_ID?.trim() || "local",
  };
}

/** Public company, plus whether this browser is the owner. The key is returned only when it is first created. */
export function companyView(presented: string | null): CompanyView {
  let minted: string | undefined;
  if (company.name && !ownerKey) {
    ownerKey = makeOwnerKey();
    minted = ownerKey;
    touch();
  }
  const owner = Boolean(minted || (ownerKey && presented === ownerKey));
  return {
    name: company.name,
    code: company.code,
    id: company.id,
    locationId: company.locationId,
    shop: { ...DEFAULT_SHOP, ...company.shop },
    people: company.people.map((person) => ({ ...person })),
    owner,
    square: squareConfigured(),
    ...(minted ? { ownerKey: minted } : {}),
  };
}

export function createCompany(name: string, presented: string | null = null): CompanyView {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name the company");
  if (ownerKey && presented !== ownerKey) throw new Error("Only the owner can change that");
  const minted = !ownerKey;
  if (!ownerKey) ownerKey = makeOwnerKey();
  company = {
    ...company,
    name: trimmed,
    code: company.code ?? makeCode(),
    id: company.id ?? randomUUID(),
  };
  touch();
  const view = companyView(ownerKey);
  return minted ? { ...view, ownerKey } : view;
}

export function joinCompany(code: string, presented: string | null = null): CompanyView {
  const entered = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!entered) throw new Error("Enter the company code");
  if (!company.code || entered !== company.code) throw new Error("No company with that code");
  return companyView(presented);
}

export function addPerson(name: string, hourlyCents: number, id: string = randomUUID()): CompanyState {
  if (!company.name) throw new Error("Create a company first");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name the person");
  if (!Number.isInteger(hourlyCents) || hourlyCents <= 0) throw new Error("Enter an hourly rate");
  if (company.people.some((person) => person.id === id)) throw new Error("That person is already on this business");
  company = {
    ...company,
    people: [
      ...company.people,
      {
        id,
        name: trimmed,
        points: 0,
        madeCents: 0,
        hourlyCents,
        status: "active",
        consentedAt: null,
        consentRevokedAt: null,
        consentNote: null,
        squareTeamMemberId: null,
        squareLocationId: null,
      },
    ],
  };
  touch();
  return company;
}

/** Mirror a presence yes/no onto the member. The person id does not change. */
export function setPersonConsent(id: string, consent: boolean, now: number, note?: string | null): CompanyState {
  const person = company.people.find((entry) => entry.id === id);
  if (!person) throw new Error("That person is not on this business");
  company = {
    ...company,
    people: company.people.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            consentedAt: consent ? now : entry.consentedAt,
            consentRevokedAt: consent ? null : now,
            consentNote: consent && note !== undefined ? note : (entry.consentNote ?? null),
          }
        : entry,
    ),
  };
  touch();
  return company;
}

/** One board person for one Square team member. The board id is the Square team member id, same as the tap clock. */
export function linkSquarePerson(input: {
  teamMemberId: string;
  locationId: string;
  name: string;
  hourlyCents: number;
}): BoardPerson {
  const teamMemberId = input.teamMemberId.trim();
  const existing = company.people.find(
    (person) => person.id === teamMemberId || person.squareTeamMemberId === teamMemberId,
  );
  if (!existing) addPerson(input.name, input.hourlyCents, teamMemberId);
  const id = existing?.id ?? teamMemberId;
  company = {
    ...company,
    people: company.people.map((person) =>
      person.id === id
        ? {
            ...person,
            name: input.name.trim() || person.name,
            hourlyCents: input.hourlyCents,
            status: "active",
            squareTeamMemberId: teamMemberId,
            squareLocationId: input.locationId,
          }
        : person,
    ),
  };
  touch();
  const linked = company.people.find((person) => person.id === id);
  if (!linked) throw new Error("That person is not on this business");
  return linked;
}

export function setPersonStatus(id: string, status: "active" | "removed"): CompanyState {
  if (!company.people.some((person) => person.id === id)) throw new Error("That person is not on this business");
  company = {
    ...company,
    people: company.people.map((person) => (person.id === id ? { ...person, status } : person)),
  };
  touch();
  return company;
}

export function setShopConfig(patch: Partial<ShopConfig>): CompanyState {
  company = { ...company, shop: { ...DEFAULT_SHOP, ...company.shop, ...patch } };
  touch();
  return company;
}

export function setPersonRate(id: string, hourlyCents: number): CompanyState {
  if (!Number.isInteger(hourlyCents) || hourlyCents <= 0) throw new Error("Enter an hourly rate");
  if (!company.people.some((person) => person.id === id)) throw new Error("That person is not in the company");
  company = {
    ...company,
    people: company.people.map((person) => (person.id === id ? { ...person, hourlyCents } : person)),
  };
  touch();
  return company;
}

function makeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[randomInt(alphabet.length)];
  return code;
}

function makeOwnerKey(): string {
  return randomBytes(24).toString("hex");
}
