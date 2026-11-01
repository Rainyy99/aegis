// Shared NEAR testnet plumbing for the AEGIS anchor tools.
//
// The signing key is read ONLY from this project's local credential
// file (.near-credentials/testnet/<account>.json, never committed).
// Everything here is testnet-only: the RPC URL defaults to the public
// NEAR testnet endpoint and the account defaults to aegis-gate.testnet.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as api from "near-api-js";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const RPC_URL = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
export const ACCOUNT_ID = process.env.NEAR_ACCOUNT_ID ?? "aegis-gate.testnet";
export const CONTRACT_ID = process.env.NEAR_CONTRACT_ID ?? ACCOUNT_ID;

export function loadKeyPair() {
  const file = join(ROOT, ".near-credentials", "testnet", `${ACCOUNT_ID}.json`);
  let cred;
  try {
    cred = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`cannot read credential file ${file}`);
  }
  if (!cred.private_key) throw new Error(`no private_key field in ${file}`);
  return api.KeyPair.fromString(cred.private_key);
}

export function getProvider() {
  return new api.JsonRpcProvider({ url: RPC_URL });
}

/** Read-only contract view call via the public RPC (no key needed). */
export async function viewCall(contractId, method, args = {}) {
  return getProvider().callFunction({ contractId, method, args });
}

export function getAccount() {
  return new api.Account(
    ACCOUNT_ID,
    getProvider(),
    new api.KeyPairSigner(loadKeyPair())
  );
}

/** Nanoseconds-since-epoch string -> ISO timestamp (millisecond precision). */
export function nsToIso(ns) {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}

export { api };
