// Prints the shop seal key. It stays in the shop .env and in each phone's
// one-time setup note. Do not put it on Cloudflare. Do not commit it.
const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);
let bin = "";
for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
const key = btoa(bin);
console.log("Shop .env RELAY_SEAL_KEY");
console.log("The mailbox never sees this. Each phone gets its own derived key on the one-time setup page.");
console.log(key);
console.log("");
console.log("Worker secret is only RELAY_SHOP_SECRET (npx wrangler secret put RELAY_SHOP_SECRET).");
console.log("Do not log this output.");
