# Phone automations

This is the way the shop clock runs with no app to install from us and no extra hardware. You set it up once on your own phone. After that, arriving at the shop or joining the shop Wi-Fi clocks you in. Leaving the shop or leaving that Wi-Fi clocks you out. You do not tap anything on a work day.

The shop is EZ Designs, 403 E Ben White Blvd, Austin.

Ezven hands you a note from the shop computer. It has a web address, one header line, and four short messages. Copy them exactly. The long code after `Bearer` is a password for your phone. It is shown once. If you lose it, ask Ezven for a new note.

Use these placeholders until you paste the real note. The address must start with `https://` when the shop is on the real server.

```text
URL
https://shop.example/api/presence/phone

Header
Authorization: Bearer io_PASTE_THE_TOKEN_EZVEN_GIVES_YOU

Arrive at the shop (location)
{"event":"arrive","trigger":"geo"}

Leave the shop (location)
{"event":"leave","trigger":"geo"}

Joined the shop Wi-Fi
{"event":"arrive","trigger":"wifi"}

Left the shop Wi-Fi
{"event":"leave","trigger":"wifi"}
```

Every automation is a POST. Send the header every time. Do not add your name, a wage, or the Wi-Fi password. The shop Wi-Fi name is the one Ezven gives you. It is not written here.

iPhone location automations can wait a few minutes after you actually arrive or leave. That is why you set up both the Wi-Fi triggers and the location triggers. A short flicker, such as the Wi-Fi dropping for a moment or the location trigger firing twice, does not clock you out. The shop waits 15 minutes of being gone before it writes the leave. Coming back inside that 15 minutes cancels the trip.

The automatic clock listens from 7:00 AM to 7:00 PM Chicago time. Outside that window the phone is ignored. If you are still clocked in at 7:00 PM, the day closes then. A phone that stays at the shop for more than 14 hours, or that is still "here" after midnight, stops counting until Ezven reviews it. Do not leave your phone on the bench overnight.

## iPhone (Shortcuts)

Shortcuts is already on the phone. You will make four Personal Automations. Each one uses Get Contents of URL, runs immediately, and does not ask first.

### 1. Arrive at the shop

1. Open Shortcuts.
2. Tap the Automation tab.
3. Tap the plus button, then Create Personal Automation.
4. Tap Arrive.
5. Tap Choose and search `403 E Ben White Blvd, Austin`. Pick the shop.
6. Tap Next, then Add Action. Search for Get Contents of URL and tap it.
7. Tap the URL field and paste:

   `https://shop.example/api/presence/phone`

8. Tap Show More.
9. Set Method to POST.
10. Under Headers, tap Add.
    - Key: `Authorization`
    - Text: `Bearer io_PASTE_THE_TOKEN_EZVEN_GIVES_YOU`

    The word `Bearer`, one space, then the code. No quotes.
11. Set Request Body to JSON.
12. Add two fields. Type is Text for both.
    - Key `event`, text `arrive`
    - Key `trigger`, text `geo`
13. Tap Done.
14. Turn off Ask Before Running and confirm Don't Ask. If you see Run Immediately, turn that on.
15. Tap Done.

### 2. Leave the shop

Same steps, with these differences:

- The trigger is Leave, at the same shop address.
- The JSON fields are `event` = `leave` and `trigger` = `geo`.

This Leave automation is the clock-out.

### 3. Joined the shop Wi-Fi

1. New Personal Automation. Tap Wi-Fi.
2. Choose the shop Wi-Fi name Ezven gives you. This automation is for joining that network.
3. Same Get Contents of URL action, same URL, same header, Method POST, Request Body JSON.
4. JSON fields: `event` = `arrive`, `trigger` = `wifi`.
5. Run Immediately. Ask Before Running stays off.

### 4. Left the shop Wi-Fi

If that Wi-Fi screen has a leaves switch (or a second choice for leaving the network), make one more automation:

- Trigger: leaves the same shop network.
- JSON fields: `event` = `leave`, `trigger` = `wifi`.
- Same URL, header, POST, and Run Immediately.

The leave-network control was not checked on a phone while this was written. If the screen has no leave switch, skip this fourth automation. The Location Leave automation from step 2 is the clock-out. A location leave also clears the Wi-Fi "I'm here" mark, so joining the shop Wi-Fi does not keep you clocked in after you have left the building.

## Android (MacroDroid)

Install MacroDroid from the Play Store. The free tier is what we use. How many macros that free tier allows was not rechecked here. If it will not save another macro, use Automate below, or ask Ezven.

Allow location all the time, including in the background, when Android asks. Without that, the geofence does not fire after you lock the phone.

Make four macros. Each one has one trigger and one HTTP Request action.

| Macro | Trigger | Body |
| --- | --- | --- |
| Arrive | Geofence, enter, `403 E Ben White Blvd, Austin` | `{"event":"arrive","trigger":"geo"}` |
| Leave | Geofence, exit, same place | `{"event":"leave","trigger":"geo"}` |
| Wi-Fi on | Wi-Fi SSID connected, the shop name Ezven gives you | `{"event":"arrive","trigger":"wifi"}` |
| Wi-Fi off | Wi-Fi SSID disconnected, that same name | `{"event":"leave","trigger":"wifi"}` |

The trigger names in the current MacroDroid free tier were not rechecked. Pick the geofence enter/exit triggers and the Wi-Fi SSID connect/disconnect triggers.

On the HTTP Request action, set every field like this:

- Method: `POST`
- URL: `https://shop.example/api/presence/phone`
- Content type: `application/json`
- Header name: `Authorization`
- Header value: `Bearer io_PASTE_THE_TOKEN_EZVEN_GIVES_YOU`
- Body: the JSON line from the table for that macro

Save each macro with no extra constraint.

## Android (Automate)

Use Automate, by LlamaLab, only if MacroDroid will not install the macros. The block names were not rechecked against the current app. Use the blocks that mean "entered a location", "exited a location", "Wi-Fi connected to an SSID", "Wi-Fi disconnected from an SSID", and "HTTP request".

Each flow is one trigger, then one HTTP request:

- Method `POST`
- URL `https://shop.example/api/presence/phone`
- Header `Authorization: Bearer io_PASTE_THE_TOKEN_EZVEN_GIVES_YOU`
- Content type `application/json`
- Body one of the four JSON lines in the note

Give the location blocks the shop address, 403 E Ben White Blvd, Austin. Give the Wi-Fi blocks the shop network name Ezven gives you.

## How to test

1. At the shop, join the shop Wi-Fi, or walk up to the building with location on.
2. Wait two or three minutes. An iPhone location automation can lag.
3. Ask Ezven to look at the shop board. Your dot should be green. You should not have tapped a punch.
4. Walk out, or leave the shop Wi-Fi. Wait about 15 minutes. The dot should go gray.
5. Walk out and straight back in. You should stay green. The 15 minutes covers that flap.
6. If nothing happens, open the automation and check the URL, the word `Bearer`, the JSON quotes, and that Run Immediately is on. A wrong token does nothing useful. Ask Ezven to revoke it and print a new note.

Do not text the token to the group chat. Do not put it on a shop PC. The shop computers and printers never count as someone being at work.

## Ezven prepares the note

There is no setup screen. From the owner key, record that person's yes, then ask for a snippet. `PERSON_ID` is their id on the company.

```bash
curl -s -X POST https://shop.example/api/presence/consent \
  -H "content-type: application/json" \
  -H "x-owner-key: OWNER_KEY" \
  -d '{"personId":"PERSON_ID","consent":true}'

curl -s -X POST https://shop.example/api/presence/phone/setup \
  -H "content-type: application/json" \
  -H "x-owner-key: OWNER_KEY" \
  -d '{"personId":"PERSON_ID","label":"Ada phone"}'
```

The setup response is `{ personId, deviceId, token, url, snippet }`. Hand the person the `snippet` text. The server stores only a hash of the token. A later call cannot show the same token again. Calling setup again issues a second phone token. The old one keeps working until you revoke it:

```bash
curl -s -X POST https://shop.example/api/presence/devices/DEVICE_ID/revoke \
  -H "x-owner-key: OWNER_KEY"
```

Set `PRESENCE_PUBLIC_URL` to the public `https://` origin so `url` in that response is the address the phone should call. More of the server rules are in `docs/presence-automation.md`.
