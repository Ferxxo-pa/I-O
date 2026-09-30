# I/O

**Input vs Output.** A tiny trading-terminal strip that gamifies work.

```
I/O ●  TIME 00:12  │  +$20.00  │  NEXT 00:08
```

- **TIME** — how long you have been clocked in · white
- **+$** — money printed · green
- **NEXT** — time until the next $20 print
- Clock in → hour prints `+$20` → dopamine

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5000 — click the strip to clock in/out.

Demo hour = 10s. Real hour:

```bash
curl -X PATCH localhost:5000/api/config \
  -H 'content-type: application/json' \
  -d '{"hourDurationMs":3600000}'
```

## Push to your empty GitHub repo

```bash
# from this folder
git init -b main
git add -A
git commit -m "Initial commit: I/O trading-terminal work HUD"
git remote add origin https://github.com/Ferxxo-pa/I-O.git
git push -u origin main
```

Independent of CastAloud. Square Labor Timecards later via `server/clock/adapters.ts`.
