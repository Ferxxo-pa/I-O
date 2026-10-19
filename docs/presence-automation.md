# Presence automation

The shop clock is the same one the I/O tap uses: `POST /api/clock/in` and `POST /api/clock/out` call `earnEngine.clockInPerson` and `earnEngine.clockOutPerson`. A phone arrive calls that clock-in. A phone leave calls that clock-out after the quiet grace. The source on the shift is `phone-geo` or `phone-wifi`. A tap is `manual`. If the person is already clocked in, another arrive does not start a second shift and does not replace a manual tap. A phone leave still uses the same clock-out after the quiet grace. Staff steps and the phone setup page are in `docs/presence-phone-automations.md`.

This page is the server side: the phone token, the checks on every automatic signal, and the optional Wi-Fi watcher and BLE stub. Square stays a dry run unless `SQUARE_PRESENCE_MIRROR=live` and `SQUARE_ACCESS_TOKEN` are both set. Nothing in this path sends an hourly rate or an amount.

A web page cannot geofence in the background. Do not build a browser punch for that. A native wrapper is optional and is not required for the shop to run.

## The team already on the board

There is no second roster. The company in `data/io-state.json` is the team. Its `id` is the team id. Each person in `company.people` (`BoardPerson` in `shared/schema.ts`, written by `server/company.ts`) is the one person a phone, a punch, the presence clock, and the money counter use. The id does not change when a phone is enrolled.

Iban's shop clock (PR #6) reads the same list: `getCompany().people`, or the Square pay roster when Square is connected. This branch does not add another person table, so that PR still maps by those ids.

When Square is connected, that pay roster is the list the owner picks from and the list the I/O tap clocks. Each picked member becomes a `BoardPerson` whose id is the Square team member id, with `squareTeamMemberId` and `squareLocationId` stored on the person and on the phone token. A token clocks only that member. Arrive and leave call `clockInPerson` / `clockOutPerson`, which open or close that member's Square timecard at their job, wage, and shop location. The wage is read from Square. Nothing in this path writes a wage setting. A deactivated member, or one not assigned to the shop location, is rejected and flagged. An open Square timecard is joined instead of opened again. Clock-out closes only the timecard stored for that same team member.

New fields on the member default so an older save still loads: `status` (`active` or `removed`), `consentedAt`, and `consentRevokedAt`. Removing someone keeps the row. New fields on the company are `shop` (fence, Wi-Fi name, open and close minutes). Empty shop fields keep the `PRESENCE_*` and `GEO_FENCE_*` environment values. `PATCH /api/company/shop` with the owner key writes them.

A device stores that company id. A token from a different company id is rejected. Punches written before the id existed have no team id and still count for this shop.

`GET /api/presence/me` (the phone's Bearer token) and `GET /api/presence/state/:personId` (owner key) return the counter: status, accrued seconds, and whole cents. `GET /api/presence/health/:personId` (owner key) adds the last signal time, the trigger, and whether the phone has been silent during shop hours. A silent enrolled phone is also written to the server log once per day.

## Consent

Automatic presence is opt-in. The owner records it, or the person does with their PIN or device token:

`POST /api/presence/consent` with `{ "personId", "consent": true }` or `"consent": false`.

Owner calls send `x-owner-key`. A person can only answer for themselves. `GET /api/presence/consent` is owner-only.

Without a yes, `POST /api/presence/phone`, `POST /api/presence/signal`, and `POST /api/presence/punch` return 403 `no_consent`. That refusal does not append a punch and does not store a location. Quiet leaves and the 7 PM auto-close of a day that is already open do not ask for consent again.

## Phone token

`POST /api/presence/phone/setup` (owner key) issues one device for one person on the roster and returns `inviteUrl` (`/join/:code`). It does not return the token. The employee opens that link on their phone. The page says who it is for, tells iPhone from Android, and reveals the token once. A second open is rejected. The token looks like `io_` plus 32 random bytes, base64url. The device file stores only `sha256$` of it. The invite file stores it sealed (`v1$`), not as plaintext. Revoke with `POST /api/presence/devices/:id/revoke`. List with `GET /api/presence/devices`. The list never includes the token.

`POST /api/presence/phone/ping` with the same Bearer token checks that the phone is enrolled. It does not clock anyone in.

The phone calls `POST /api/presence/phone` over HTTPS:

```http
Authorization: Bearer io_PASTE_THE_TOKEN_EZVEN_GIVES_YOU
Content-Type: application/json

{"event":"arrive","trigger":"geo"}
```

`event` is `arrive` or `leave`. `trigger` is `geo` or `wifi`. `ts` is optional. Omit it and the server clock is the event time. If `ts` is present it must be within `PRESENCE_PHONE_MAX_AGE_MS` (default 10 minutes) and not more than `PRESENCE_SIGNAL_MAX_FUTURE_MS` (default 15 seconds) ahead. When `ts` is inside that window, the arrive punch uses it, so a retry after a dead radio still clocks from the first signal. A `ts` outside the window is rejected and does not move the clock.

Shortcuts and MacroDroid do not send coordinates and cannot easily compute an HMAC. The operating-system trigger is the fence for this path. The token is the authenticator. It is bound to one person. Eight bad tokens from one IP lock that IP for 30 seconds.

The same token is also accepted as `x-device-token` on a manual punch and on the optional geofence signal below.

Server checks on every phone call:

- Rate limit, `PRESENCE_SIGNAL_RATE_PER_MIN` (default 60) per IP. Over the limit is HTTP 429.
- Dedupe. The same device, trigger, and event inside `PRESENCE_PHONE_DEDUPE_MS` (default 2 minutes) returns the first result with `duplicate: true` and does not write a second punch.
- Consent, as above.
- Collection window. Automatic signals count only from open minus `PRESENCE_COLLECT_MARGIN_MS` through close plus that margin. Defaults are 9:00–17:00 and a 2 hour margin, so 7:00–19:00 Chicago. Outside that the response is `outside_hours` and nothing is stored. A manual punch is not limited to this window.
- Stationary. A phone latch that stays on for `PRESENCE_STATIONARY_MS` (default 14 hours), or that is still on after the Chicago date changes, is flagged `stationary`, clocked out, and ignored until `POST /api/presence/devices/:id/review`.

An arrive latches that trigger until its leave. Any latched trigger keeps the day open. A location leave clears every latch for that phone, so an iPhone that can join Wi-Fi but has no "left the network" switch still clocks out from the Leave location automation. A Wi-Fi leave clears only the Wi-Fi latch. If the location latch is still on, a Wi-Fi flicker does not start a departure.

Departure is written when no source still holds and the last signal is at least `PRESENCE_SIGNAL_QUIET_MS` old (default 15 minutes). The leave time is the last signal, not the moment the grace ends. The existing 10 minute away rule then decides a short trip versus a break. iPhone location delays of a few minutes sit inside that 15 minute grace.

If a latch is still holding at `PRESENCE_AUTO_CLOSE` (default 19:00 Chicago), the day closes at that instant with `source: "auto_close"` and `flag: "auto_closed"`, and the phone latches are dropped so the next morning can arrive. Closing at the morning arrive would erase the shift. A manual punch with no signal watch is not auto-closed. The correction flow still covers a forgotten tap.

## Optional Wi-Fi watcher

A router webhook or a small poller can POST `POST /api/presence/signal`. This is optional. Phone automations do not need it. UniFi, Omada, and Eero were not verified here. Do not point a stock controller at this URL and expect it to speak this JSON. Put a translator or poller in front, and treat vendor menu paths as unchecked.

```http
POST /api/presence/signal
x-presence-signature: <hex hmac-sha256 of the raw body>
Content-Type: application/json

{
  "source": "wifi",
  "sourceId": "shop-ap",
  "event": "seen",
  "ts": 1710000000000,
  "id": "wifi-event-0001",
  "deviceId": "aa:bb:cc:dd:ee:ff"
}
```

`x-hub-signature-256` is accepted too (`sha256=` plus the hex, or the hex alone). The secret is `PRESENCE_WIFI_HMAC_SECRET`. `event` is `seen` or `not_seen` (also `enter` / `exit`). `id` is the idempotency key. `ts` must be within `PRESENCE_SIGNAL_MAX_AGE_MS` (default 2 minutes).

Hostnames are not identity. `hostname`, `host`, `name`, `clientName`, `dhcpName`, `dnsName`, and `ssid` are stripped and never matched to a person.

Before a sighting counts, the owner maps the device:

`POST /api/presence/wifi` with `{ "deviceId", "personId", "label", "kind" }`.

`kind` is `phone`, `pc`, `printer`, or `other`. Only `phone` can drive presence. Shop PCs stay on the shop Wi-Fi all day and must not count. A PC, a printer, `other`, or any unenrolled id returns 200 `ignored` (`not_phone` or `unenrolled`) and writes no punch. The raw id is not stored.

MAC addresses are normalized to `aa:bb:cc:dd:ee:ff` and stored as `hmac-sha256$` with `PRESENCE_DEVICE_HASH_PEPPER`. In production an empty pepper refuses the map, so a low-entropy MAC is not kept under a public hash. Development uses a fixed fallback pepper. Phones randomize their Wi-Fi address per network. For this watcher the phone must use one stable private address on the shop network: iPhone Settings, that network, Private Wi-Fi Address set to Fixed. On Android, turn off the per-network randomized MAC for the shop network. A hostname match is not trusted.

Watcher sightings are heartbeats, not latches. `seen` holds presence only while it is younger than the 15 minute quiet window. `not_seen`, or silence, starts the same departure rule.

A watcher device that is present across the overnight edge, or continuously longer than 14 hours, stops driving presence until `POST /api/presence/wifi/:id/review`.

## Optional BLE

Same endpoint, `"source": "ble"`, signed with `PRESENCE_BLE_HMAC_SECRET`. Map beacons with `POST /api/presence/beacons` and the same `kind` rule. Until `PRESENCE_BLE_ENABLED` is `1`, `true`, `on`, or `yes`, a signed BLE call returns `ble_stub` and writes nothing. Leave it off.

## Optional native wrapper

A future Capacitor or Expo app can POST `/api/presence/signal` with `"source": "geofence"`, header `x-device-token`, and a fresh fix:

```json
{
  "source": "geofence",
  "sourceId": "phone-gps",
  "event": "enter",
  "ts": 1710000000000,
  "id": "geo-event-0001",
  "lat": 30.2198,
  "lng": -97.7607,
  "accuracy": 12
}
```

The server still judges that fix against the 120 meter fence, 75 meter accuracy, and 30 second freshness. Background delivery has to be a real geofence API (iOS region monitoring, Android geofencing), not a page left open in Safari or Chrome. Phone Shortcuts remain the path the shop uses.

## Env

```text
IO_MODE=local-relay
LAN_BASE_URL=http://io.local:5000
RELAY_PUBLIC_URL=https://io-relay.your-subdomain.workers.dev
RELAY_SHOP_SECRET=
PUBLIC_BASE_URL=
PRESENCE_SIGNAL_QUIET_MS=900000
PRESENCE_AUTO_CLOSE=19:00
PRESENCE_SIGNAL_MAX_AGE_MS=120000
PRESENCE_SIGNAL_MAX_FUTURE_MS=15000
PRESENCE_SIGNAL_RATE_PER_MIN=60
PRESENCE_COLLECT_MARGIN_MS=7200000
PRESENCE_STATIONARY_MS=50400000
PRESENCE_OVERNIGHT_EDGE_MS=1800000
PRESENCE_PHONE_MAX_AGE_MS=600000
PRESENCE_PHONE_DEDUPE_MS=120000
PRESENCE_WIFI_HMAC_SECRET=
PRESENCE_BLE_HMAC_SECRET=
PRESENCE_BLE_ENABLED=
PRESENCE_DEVICE_HASH_PEPPER=
```

`PRESENCE_WIFI_HMAC_SECRET`, `PRESENCE_BLE_HMAC_SECRET`, `PRESENCE_DEVICE_HASH_PEPPER`, and device tokens stay on the server. The setup response is an invite link. The token is shown once, on that phone's `/join/:code` page. local-relay is the shop path in `docs/go-live.md`. `IO_MODE=public` keeps a single public URL and does not use the mailbox.
