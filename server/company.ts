import { randomUUID } from "node:crypto";
import type { CompanyState } from "@shared/schema";

let company: CompanyState = {
  name: null,
  people: [],
  integrations: [],
};

export function getCompany(): CompanyState {
  return company;
}

export function createCompany(name: string): CompanyState {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name the company");
  company = { ...company, name: trimmed };
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

function cleanHandle(value: string): string | null {
  const trimmed = value.trim().replace(/^@/, "");
  return trimmed ? trimmed : null;
}
