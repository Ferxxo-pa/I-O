// The mailbox secret is chosen here and pasted into the shop .env and the
// Cloudflare worker secret. Phones do not get this value. They post with
// their own bearer token. Do not commit it. Do not log this output.
const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);
let hex = "";
for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
console.log("Shop .env RELAY_SHOP_SECRET");
console.log(hex);
console.log("");
console.log("Worker: npx wrangler secret put RELAY_SHOP_SECRET");
console.log("Optional Square forward: npx wrangler secret put RELAY_SQUARE_WEBHOOK_KEY");
console.log("and set RELAY_SQUARE_NOTIFICATION_URL to the Square notification URL.");
console.log("Do not put SQUARE_ACCESS_TOKEN on the worker.");
