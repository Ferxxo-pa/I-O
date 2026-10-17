# Presence clock

Phones send arrive and leave punches. The I/O server keeps one append-only record per attempt, decides the day from those records, and can mirror an accepted day to Square Labor. Square stays the source of truth for hours. This server never sends an hourly rate.

The shop is EZ Designs, 403 E Ben White Blvd, Austin. Hours are about 9–5 and people do not work off site. The day rules are not a hard 9–5 gate.

## Punch record

`POST /api/presence/punch`

```json
{ "type": "arrive", "ts": 1710000000000, "lat": 30.22, "lng": -97.76, "accuracy": 12, "source": "phone" }
```

Iban's geolocation client can send the same call with `action: "in" | "out"` and `fix: { lat, lng, accuracyM, capturedAt }`. `in` is arrive, `out` is leave. `source` should be `iban` or `phone`.

Identity is that person's PIN, header `x-person-pin` (or `pin` in the body). The PIN is checked with scrypt and is not written into the log or the response. A body or `x-person-id` that names someone else is stored as a rejected punch (`wrong_person`, HTTP 403) and does not move their day. Six bad PINs lock that IP for 30 seconds.

Every attempt is appended to `data/presence-punches.jsonl`. Lines are only added. A rejected line stays in the file and is ignored by the day, the streak, the week bar, and Square.

A punch is accepted only when all of these hold:

- The fix is not older than 30 seconds and not more than 15 seconds ahead of the server.
- Accuracy is above 0 and at most 75 meters.
- The point is within 120 meters of the shop building. The center is not sent to the browser.
- The shop day is not already closed.

`ts` on the stored record is the server time. The phone's timestamp is only the fix time used for the freshness check, so a phone cannot backdate a punch.

The owner (Ezven, the company owner key) reads the full log at `GET /api/presence/log`, including coordinates. `GET /api/presence` is the board the shop computer uses: names, green or gray, the day streak, and the week. It has no coordinates, no PINs, and no Square ids.

## Day rules

Timezone is `America/Chicago`.

- The first accepted arrival of the local day clocks them in. The usual window is 6:00–12:00. Earlier is marked early, later is marked late, and both still clock in.
- A leave starts a break only after they have been away for 10 minutes. A return before that ignores the trip: they stay clocked in, and that gap counts as worked.
- Once the absence is a break, none of it counts as worked, including the first 10 minutes. A leave from 11:00 through 2:00 is lunch. Any other leave is a short break. Coming back ends the break.
- If they leave and do not come back by the cutoff, the day closes at their last leave. The cutoff is the earlier of 7:00 PM and 2 hours after the normal 5:00 PM close. With the defaults those are the same time.
- A leave after the cutoff closes the day at that leave. An arrival after the cutoff still opens the day when they have not already been in.
- A later punch on a closed day is rejected with `day_closed`.

Worked time is what the shop-computer counter follows. It is not pay. Square computes hours.

These windows are env settings: `PRESENCE_ARRIVE_START`, `PRESENCE_ARRIVE_END`, `PRESENCE_LUNCH_START`, `PRESENCE_LUNCH_END`, `PRESENCE_MIN_AWAY_MS`, `PRESENCE_OPEN`, `PRESENCE_CLOSE`, `PRESENCE_DAY_CLOSE`, `PRESENCE_CLOSE_GRACE_MS`.

## I'm here, and a forgotten clock-out

`POST /api/presence/here` is the one-tap fallback. With a fresh accurate fix it is a normal arrive (`source: "here"`). Without a fix it is accepted only when the request carries `x-desk-token` matching `PRESENCE_DESK_TOKEN` on the server. That token stays on the shop computer. A remote "I'm here" with no fix is logged as `desk_required` and changes nothing.

`POST /api/presence/corrections` with `{ "leaveTs": <ms> }` asks to close today at that time. It does not change the day. Ezven approves with the owner key:

- `POST /api/presence/corrections/:id/approve`
- `POST /api/presence/corrections/:id/deny`

Approval appends one leave with `source: "correction"` and `closesDay: true`. Denial appends nothing to the punch log. The correction log itself is append-only.

## I/O

Green means clocked in (including a trip that has not yet become a break). Gray means out, on break, or day closed. The dots sit above the strip. The flame is consecutive open shop days that have an accepted arrival. The unit is days, not hours. Today with nobody in yet does not break the run. A missed open day does. Saturday and Sunday are skipped unless they are listed in `PRESENCE_OPEN_WEEKDAYS`.

The week bar under the flame is those same days, Monday through Sunday. The green and red money bar is still Square sales.

When an arrival is accepted, that person's counter starts on the shop computer. The server pushes `GET /api/presence/stream` and the strip also polls `/api/state`. A break or a closed day stops the counter at the leave time. Time after the leave is not accrued. This path does not open the older wage-writing timecard helper.

## Square

Accepted punches can be mirrored with each person's own `teamMemberId`, `jobId`, and break type ids (`PUT /api/presence/square`, owner only). A body that contains a wage, an amount, or an hourly rate is rejected.

`SQUARE_PRESENCE_MIRROR` defaults to dry run. Dry run appends the planned Labor calls to `data/presence-square-dry.jsonl` and does not call Square. Set it to `live` only when `SQUARE_ACCESS_TOKEN` is set on the server. The token is never sent to the browser.

The live sequence, ported from the Labor flow in `Ferxxo-pa/square-autoclock` `clock.py`, is:

1. Open a timecard with location, team member, start time, and `job_id` when one is configured. No hourly rate.
2. On a real break, add that person's lunch or short break type. The break is unpaid.
3. On return, set the break's end.
4. When the day closes, set the timecard's end to the last leave and close it.

On an update, a wage object Square already stored is copied back unchanged so the update does not clear it. This server does not build an hourly rate and does not call wage-setting. If Square is down, the punch still stands locally and the mirror retries later.

The `square-autoclock` repository was not readable from this environment (GitHub returned 404). The sequence above is that script's clock-in, break, and clock-out flow against the current Labor timecard API. Confirm it against the script before turning `live` on.
