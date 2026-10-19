/**
 * Read data/io-state.json and print SQL for the hosted D1 book.
 *
 *   npm run import:cf -- data/io-state.json
 *   npx wrangler d1 execute io --remote --config worker/wrangler.toml --file=data/io-import.sql
 *
 * Square tokens are not in the JSON file. Pass --square-token and TOKEN_KEY
 * (the same 32-byte base64 wrangler secret) to seal the token into the SQL.
 * The plaintext token is not written into the SQL file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { rowsFromIoState, sqlString } from "../shared/cloud/importState.ts";
import { sha256Hex } from "../shared/cloud/hmac.ts";
import { importAesKey, keyFromBase64, sealSecret } from "../shared/cloud/secrets.ts";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--")) ?? "data/io-state.json";
const tokenFlag = args.indexOf("--square-token");
const squareToken = tokenFlag >= 0 ? args[tokenFlag + 1] : "";
const keyFlag = args.indexOf("--token-key");
const tokenKey = keyFlag >= 0 ? args[keyFlag + 1] : process.env.TOKEN_KEY ?? "";
const locationFlag = args.indexOf("--location");
const location = locationFlag >= 0 ? args[locationFlag + 1] : "";

const raw = JSON.parse(readFileSync(file, "utf8"));
const shop = rowsFromIoState(raw);
const companyId = shop.company.id;
const lines: string[] = [];

let tokenEnc = "";
if (squareToken) {
  if (!tokenKey) throw new Error("Pass --token-key or TOKEN_KEY to seal the Square token");
  const key = await importAesKey(keyFromBase64(tokenKey));
  tokenEnc = await sealSecret(key, squareToken);
}

const ownerHash = shop.company.ownerKey ? sha256Hex(shop.company.ownerKey) : "";
lines.push(
  `INSERT INTO companies (id, name, code, location_id, owner_key_hash, pin_hash, shop_json, fight_json, square_token_enc, created_at) VALUES (${[
    sqlString(companyId),
    shop.company.name ? sqlString(shop.company.name) : "NULL",
    shop.company.code ? sqlString(shop.company.code) : "NULL",
    sqlString(location || shop.company.locationId),
    ownerHash ? sqlString(ownerHash) : "NULL",
    shop.company.pinHash ? sqlString(shop.company.pinHash) : "NULL",
    sqlString(JSON.stringify(shop.company.shop ?? {})),
    shop.company.fight ? sqlString(JSON.stringify(shop.company.fight)) : "NULL",
    tokenEnc ? sqlString(tokenEnc) : "NULL",
    String(Date.now()),
  ].join(", ")});`,
);

for (const person of shop.people) {
  lines.push(
    `INSERT INTO people (company_id, id, name, points, made_cents, hourly_cents, status, consented_at, consent_revoked_at, consent_note, square_team_member_id, square_location_id) VALUES (${[
      sqlString(companyId),
      sqlString(person.id),
      sqlString(person.name),
      String(person.points),
      String(person.madeCents),
      String(person.hourlyCents),
      sqlString(person.status),
      person.consentedAt == null ? "NULL" : String(person.consentedAt),
      person.consentRevokedAt == null ? "NULL" : String(person.consentRevokedAt),
      person.consentNote ? sqlString(person.consentNote) : "NULL",
      person.squareTeamMemberId ? sqlString(person.squareTeamMemberId) : "NULL",
      person.squareLocationId ? sqlString(person.squareLocationId) : "NULL",
    ].join(", ")});`,
  );
}

for (const shift of shop.sessions) {
  lines.push(
    `INSERT INTO sessions (company_id, person_id, name, hourly_cents, clocked_in, clocked_in_at, hour_started_at, output_cents, timecard_id, hold_at, source, review, managed_by) VALUES (${[
      sqlString(companyId),
      sqlString(shift.personId),
      sqlString(shift.name),
      String(shift.hourlyCents || 2000),
      shift.clockedIn ? "1" : "0",
      shift.clockedInAt == null ? "NULL" : String(shift.clockedInAt),
      shift.hourSegmentStartedAt == null ? "NULL" : String(shift.hourSegmentStartedAt),
      String(shift.outputCents),
      shift.timecardId ? sqlString(shift.timecardId) : "NULL",
      shift.holdAt == null ? "NULL" : String(shift.holdAt),
      shift.source ? sqlString(shift.source) : "NULL",
      "NULL",
      "NULL",
    ].join(", ")});`,
  );
}

const out = args.includes("--stdout") ? "" : "data/io-import.sql";
const sql = lines.join("\n") + "\n";
if (out) {
  writeFileSync(out, sql);
  console.log(`Wrote ${out} for company ${companyId}. Owner key was hashed. Square token was ${tokenEnc ? "sealed" : "not included"}.`);
} else {
  process.stdout.write(sql);
}
