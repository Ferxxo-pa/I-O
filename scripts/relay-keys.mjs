// Prints a shop seal keypair. The public JWK goes to the Cloudflare worker.
// The private JWK stays in the shop computer's .env. Do not commit either.
const pair = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
console.log("Worker secret RELAY_SEAL_PUBLIC_JWK (npx wrangler secret put RELAY_SEAL_PUBLIC_JWK):");
console.log(JSON.stringify(publicJwk));
console.log("");
console.log("Shop .env RELAY_SEAL_PRIVATE_JWK (this computer only):");
console.log(JSON.stringify(privateJwk));
