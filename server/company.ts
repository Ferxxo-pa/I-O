import { randomUUID } from "node:crypto";
import type { CompanyState } from "@shared/schema";

let company: CompanyState = {
  name: null,
  code: null,
  people: [],
  integrations: [],
};

export function getCompany(): CompanyState {
  return company;
}

export function createCompany(name: string): CompanyState {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name the company");
  company = { ...company, name: trimmed, code: company.code ?? makeCode() };
  return company;
}

export function joinCompany(code: string): CompanyState {
  const entered = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!entered) throw new Error("Enter the company code");
  if (!company.code || entered !== company.code) throw new Error("No company with that code");
  return company;
}

export function addPerson(name: string, telegram: string): CompanyState {
  if (!company.name) throw new Error("Create a company first");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name the person");
  const handle = cleanHandle(telegram);
  company = {
    ...company,
    people: [
      ...company.people,
      {
        id: randomUUID(),
        name: trimmed,
        telegram: handle,
        points: 0,
        madeCents: 0,
      },
    ],
  };
  return company;
}

export function connectIntegration(
  kind: "telegram" | "custom",
  account: string,
  label?: string,
): CompanyState {
  const handle = cleanHandle(account);
  if (!handle) throw new Error("Enter an account");
  if (kind === "telegram") {
    company = {
      ...company,
      integrations: [
        ...company.integrations.filter((item) => item.kind !== "telegram"),
        { id: randomUUID(), kind, label: "Telegram", account: handle },
      ],
    };
    return company;
  }
  const name = (label ?? handle).trim();
  if (!name) throw new Error("Name the integration");
  company = {
    ...company,
    integrations: [
      ...company.integrations,
      { id: randomUUID(), kind: "custom", label: name, account: handle },
    ],
  };
  return company;
}

function makeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function cleanHandle(value: string): string | null {
  const trimmed = value.trim().replace(/^@/, "");
  return trimmed ? trimmed : null;
}
