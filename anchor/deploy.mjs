// Deploy build/contract.wasm to the deployer account (the account IS
// the contract account: aegis-gate.testnet) and verify the deployment:
// the on-chain code hash must equal base58(sha256(wasm)), and the
// anchor_count view must answer.
//
// Usage: node deploy.mjs

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT, ACCOUNT_ID, getAccount, getProvider, viewCall, api } from "./lib.mjs";

const wasmPath = join(ROOT, "build", "contract.wasm");
const wasm = readFileSync(wasmPath);
const localCodeHash = api.baseEncode(createHash("sha256").update(wasm).digest());
console.log(`wasm: ${wasmPath} (${wasm.length} bytes)`);
console.log(`local code hash (base58 sha256): ${localCodeHash}`);

const account = getAccount();
console.log(`deploying to ${ACCOUNT_ID} ...`);
const outcome = await account.deployContract(new Uint8Array(wasm));
console.log(`deploy tx: ${outcome.transaction.hash}`);
console.log(`final status: ${JSON.stringify(outcome.final_execution_status)}`);

const provider = getProvider();
const view = await provider.viewAccount({ accountId: ACCOUNT_ID });
console.log(`on-chain code_hash: ${view.code_hash}`);
if (view.code_hash !== localCodeHash) {
  throw new Error("code hash mismatch between local wasm and chain");
}
console.log("code hash verified on-chain ✓");

const count = await viewCall(ACCOUNT_ID, "anchor_count");
console.log(`anchor_count view answers: ${count}`);
