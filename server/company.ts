import { randomInt, randomUUID } from "node:crypto";
import type { CompanyState } from "@shared/schema";

let company: CompanyState = {
  name: null,
  code: null,
  people: [],
};

let onChange: (() => void) | null = null;

export function setCompanyListener(fn: () => void) {
  onChange = fn;
}

function touch() {
  onChange?.();
}

export function getCompany(): CompanyState {
  return company;
}

export function hydrateCompany(next: CompanyState) {
  company = {
    name: next.name,
    code: next.code,
    people: next.people.map((person) => ({ ...person })),
  };
}

export function createCompany(name: string): CompanyState {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name the company");
  company = { ...company, name: trimmed, code: company.code ?? makeCode() };
  touch();
  return company;
}

export function joinCompany(code: string): CompanyState {
  const entered = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!entered) throw new Error("Enter the company code");
  if (!company.code || entered !== company.code) throw new Error("No company with that code");
  return company;
}

export function addPerson(name: string): CompanyState {
  if (!company.name) throw new Error("Create a company first");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name the person");
  company = {
    ...company,
    people: [
      ...company.people,
      {
        id: randomUUID(),
        name: trimmed,
        points: 0,
        madeCents: 0,
      },
    ],
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
