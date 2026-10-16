# Shop clock

Geofenced clock in and out for EZ Designs, 403 E Ben White Blvd, Austin. The page is `/punch`. This MVP records punches. It does not yet move the I/O strip or the work streak.

## Employee

The employee enters the shop PIN, then picks their name. That is the same pair I/O already uses: the PIN goes in `sessionStorage` under `io.shop.pin` and is sent as `x-shop-pin`, and the person id stays in `io.who` / `x-person-id`. The owner key (`io.owner` / `x-owner-key`) is what opens the punch log. A wrong PIN locks after six tries. The PIN is stored as a scrypt hash, or read from `SHOP_PIN` until the owner sets one. It is never written into the client bundle.

Tapping clock in or clock out asks the browser for one fix: latitude, longitude, accuracy in meters, and the time the fix was taken. `POST /api/punch` is the only call that records a punch. The server decides. Square tokens stay in the server environment.

## What is recorded

Every attempt is appended to `data/punches.jsonl`. Lines are only added. A rejected attempt stays in the log and does not open or close a shift.

A punch is accepted only when all of these hold:

- The fix is not older than `GEO_FENCE_MAX_AGE_MS` (default 30 seconds) and not ahead of the server by more than `GEO_FENCE_MAX_FUTURE_MS` (default 15 seconds).
- Accuracy is a positive number of meters at or under `GEO_FENCE_MAX_ACCURACY_M` (default 75). Zero or missing accuracy is rejected.
- Distance from the shop is within `GEO_FENCE_RADIUS_M` (default 120). The default point is the shop building, 30.219778, -97.760707. The center is not sent to the browser.
- Clock in is refused when that person is already in. Clock out is refused when they are not in.

The owner opens **Log** on `/punch` and sees who, the punch, the time, the distance, and accepted or the rejection reason.

## Square

`SQUARE_LABOR_PUNCHES` defaults off. Off means the local append-only log, with a mock timecard id, and no Square keys are required.

With `SQUARE_LABOR_PUNCHES=1` and `SQUARE_ACCESS_TOKEN` set, an accepted clock in calls `POST /v2/labor/timecards` with location, team member, and start time. That body has no wage. An accepted clock out closes that timecard and, if Square already stored a wage, copies that wage back unchanged so the update does not clear it. This path does not call wage-setting and does not change what anyone is paid.

The strip's older clock uses a different Square helper that does send a wage. Do not point the shop clock at that helper.

Leave the flag on for a whole shift. A punch that started on the local log has no Square timecard to close.

## Later: I/O clock state

The strip reads `you.clockedIn` from the open shift on the book (`clockInPerson` / `clockOutPerson`). The shop clock does not call those today.

The later hook is narrow: only after this log accepts a punch, call `clockInPerson` on the way in and `clockOutPerson` on the way out, and store this punch's timecard id on that shift. A rejected punch must not call them. An outside, stale, or low-accuracy fix leaves the strip grey and does not start wage accrual.

When Square punches are on, that timecard id is the one created without a wage. The existing Square poll already treats an open timecard id as the shift, so the same card is not opened a second time.

## Later: the work streak

The work streak counts consecutive open shop days that have clock time. A day counts when someone has clock time that day. Today counts as soon as a person is clocked in, before an hour has printed. The day boundary is the shop's local day, `America/Chicago`.

Feed the streak from accepted punches, not from the raw GPS reading:

- An accepted clock in starts the shift. Elapsed time from that punch's `at` until clock out (or until now, while still in) is that person's clock time for the day. That duration is the `ms` the streak already treats as worked.
- An accepted clock out stops the timer. If the process restarts, rebuild the day's clock time from accepted `in` / `out` pairs in `punches.jsonl` instead of the live shift.
- A rejected punch adds no time. It must not mark today as worked and it must not add a streak day.
- One accepted clock in is enough for the day to count. More punches on the same day do not add extra streak days.
- A shop day with no accepted clock in still breaks the run, the same way a day with no clock time does now.

The streak reads clock time, not a rate. This punch path still must not write pay.
