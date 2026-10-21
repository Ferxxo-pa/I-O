import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [sumsPath, sigPath, keyPath] = process.argv.slice(2).filter((arg) => arg !== "--print-public");
const printPublic = process.argv.includes("--print-public");

if (!sumsPath || !sigPath || !keyPath) {
  console.error("Usage: node scripts/sign-checksum.mjs SHA256SUMS SHA256SUMS.sig signing-key.pem [--print-public]");
  process.exit(1);
}

const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
const body = readFileSync(sumsPath);
const signature = sign(null, body, privateKey);
const publicKey = createPublicKey(privateKey);
if (!verify(null, body, publicKey, signature)) {
  console.error("Signature did not verify");
  process.exit(1);
}
writeFileSync(sigPath, signature);
if (printPublic) {
  process.stdout.write(publicKey.export({ type: "spki", format: "pem" }));
}
