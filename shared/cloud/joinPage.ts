import { qrSvg } from "./qr.ts";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function joinMissingHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Link not valid</title>
  <style>
    :root { --paper: #e7e7e9; --ink: #1d1d1f; --mute: #8e8e93; }
    body { margin: 0; min-height: 100%; background: var(--paper); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 28px 18px; }
    main { max-width: 420px; margin: 0 auto; background: rgba(255,255,255,0.46); border: 1px solid rgba(255,255,255,0.72); border-radius: 14px; padding: 22px 18px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { color: var(--mute); margin: 0; }
  </style>
</head>
<body><main><h1>This link is not valid</h1><p>Ask Ezven for a new one.</p></main></body>
</html>`;
}

export function joinPageHtml(input: {
  name: string;
  ssid: string;
  address: string;
  inviteUrl: string;
  opened: boolean;
  relayNote?: string;
}): string {
  const name = esc(input.name);
  const ssid = esc(input.ssid);
  const address = esc(input.address);
  const url = esc(input.inviteUrl);
  const lead = input.opened
    ? `This link was already opened. Ask Ezven for a new one.`
    : `Scan this on ${name}'s phone. The code stays sealed until that phone opens it.`;
  const fresh = input.opened
    ? ""
    : `${qrSvg(input.inviteUrl)}
      <p class="url">${url}</p>
      <ol>
        <li>One tap copies the shop geofence automation and the ${ssid} automation, or downloads them for MacroDroid.</li>
        <li>On iPhone, paste into Shortcuts. Apple will not import an unsigned automation. On Android, import the file in MacroDroid.</li>
        <li>Tap Test it. A check means the phone reached the shop.</li>
      </ol>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex">
  <title>Setting up for ${name}</title>
  <style>
    :root { --paper: #e7e7e9; --ink: #1d1d1f; --mute: #8e8e93; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--paper); color: var(--ink); }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-size: 16px;
      line-height: 1.35;
      padding: 28px 18px 48px;
    }
    main {
      max-width: 420px;
      margin: 0 auto;
      background: rgba(255, 255, 255, 0.46);
      border: 1px solid rgba(255, 255, 255, 0.72);
      border-radius: 14px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.06);
      padding: 22px 18px 18px;
    }
    h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 6px; }
    .meta, .hint, .url { color: var(--mute); }
    .meta { margin: 0 0 16px; font-size: 13px; }
    ol { margin: 0; padding-left: 22px; }
    li { margin: 0 0 14px; }
    button {
      font: inherit;
      color: var(--ink);
      background: #fff;
      border: 1px solid rgba(0, 0, 0, 0.08);
      border-radius: 10px;
      padding: 10px 14px;
      cursor: pointer;
    }
    button:active { transform: translateY(1px); }
    .hint { margin: 8px 0 0; font-size: 13px; }
    .url { font-size: 12px; word-break: break-all; margin: 8px 0 16px; }
    svg { width: 180px; height: 180px; display: block; margin: 4px 0 8px; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.7);
      border-radius: 10px;
      padding: 12px;
      margin: 8px 0 0;
    }
    .ok { font-weight: 600; margin: 8px 0 0; }
    .used { margin: 0 0 12px; }
  </style>
</head>
<body>
  <main>
    <h1>Setting up for ${name}</h1>
    <p class="meta">${ssid} · ${address}</p>
    ${input.relayNote ? `<p class="meta">${esc(input.relayNote)}</p>` : ""}
    <p class="used" id="used" hidden>This link was already opened. Ask Ezven for a new one.</p>
    <section id="desk">
      <p>${lead}</p>
      ${fresh}
    </section>
    <section id="phone" hidden>
      <ol>
        <li>
          <button type="button" id="act">Copy both automations</button>
          <p class="hint" id="act-hint"></p>
          <pre id="note"></pre>
        </li>
        <li id="step2"></li>
        <li>
          <button type="button" id="test">Test it</button>
          <p class="ok" id="result"></p>
        </li>
      </ol>
    </section>
  </main>
  <script>
    (function () {
      var path = location.pathname.replace(/\\/$/, "");
      var ua = navigator.userAgent || "";
      var kind = /Android/i.test(ua) ? "android" : /iPhone|iPad|iPod/i.test(ua) ? "iphone" : "desk";
      var desk = document.getElementById("desk");
      var phone = document.getElementById("phone");
      var used = document.getElementById("used");
      var store = "io-join:" + path;
      function showUsed(text) {
        desk.hidden = true;
        phone.hidden = true;
        used.hidden = false;
        if (text) used.textContent = text;
      }
      function fallbackCopy(text) {
        var area = document.getElementById("note");
        area.focus();
        area.select();
        try { document.execCommand("copy"); } catch (err) {}
      }
      function showPhone(data) {
        desk.hidden = true;
        phone.hidden = false;
        used.hidden = true;
        document.getElementById("note").textContent = data.iphone;
        var act = document.getElementById("act");
        var hint = document.getElementById("act-hint");
        var step2 = document.getElementById("step2");
        if (kind === "android") {
          act.textContent = "Download the automations";
          hint.textContent = "This downloads one file. Premiere and the shop geofence are already filled in.";
          step2.textContent = "Open MacroDroid and import ez-designs.macro.";
          act.onclick = function () {
            var blob = new Blob([JSON.stringify(data.macro, null, 2)], { type: "application/json" });
            var link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = "ez-designs.macro";
            link.click();
          };
        } else {
          act.textContent = "Copy both automations";
          hint.textContent = "This copies the geofence note and the Premiere note, then opens Shortcuts.";
          step2.textContent = "Paste them into Shortcuts. Apple will not import an unsigned automation.";
          act.onclick = function () {
            var text = data.iphone;
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
            } else {
              fallbackCopy(text);
            }
            location.href = "shortcuts://";
          };
        }
        document.getElementById("test").onclick = function () {
          var result = document.getElementById("result");
          result.textContent = "Checking…";
          fetch("/api/presence/phone/ping", {
            method: "POST",
            headers: { authorization: "Bearer " + data.token }
          }).then(function (res) {
            return res.json().then(function (body) { return { ok: res.ok, body: body }; });
          }).then(function (out) {
            result.textContent = out.ok && out.body && out.body.connected ? "✓ connected" : "Not connected yet";
          }).catch(function () {
            result.textContent = "Not connected yet";
          });
        };
      }
      if (kind === "desk") return;
      var cached = null;
      try { cached = JSON.parse(sessionStorage.getItem(store) || "null"); } catch (err) { cached = null; }
      if (cached && cached.token) {
        showPhone(cached);
        return;
      }
      fetch(path + "/open", { method: "POST" }).then(function (res) {
        if (res.status === 410) {
          showUsed();
          return null;
        }
        if (!res.ok) throw new Error("open");
        return res.json();
      }).then(function (data) {
        if (!data || !data.token) return;
        try { sessionStorage.setItem(store, JSON.stringify(data)); } catch (err) {}
        showPhone(data);
      }).catch(function () {
        showUsed("This link did not open. Ask Ezven for a new one.");
      });
    })();
  </script>
</body>
</html>`;
}
