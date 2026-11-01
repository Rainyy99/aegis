#!/usr/bin/env node
// AEGIS anchor helper — record and read report anchors on NEAR testnet.
//
// The AEGIS runner (../aegis/aegis.mjs) emits a JSON report with a
// deterministic SHA-256 `reportHash`. Anchoring records that hash, the
// overall verdict, and the agent identity in the registry contract, so
// anyone can later re-run the same inputs, recompute the hash, and
// check it against the chain without trusting the reporting machine.
// An anchor proves a report with that hash existed at that time —
// it does NOT prove the verdict is correct.
//
// Usage:
//   node anchor.mjs record <reportHash> <verdict> <agentId>
//   node anchor.mjs get <reportHash>
//   node anchor.mjs count
//
// Env overrides: NEAR_CONTRACT_ID (default: aegis-gate.testnet),
// NEAR_ACCOUNT_ID (signer, default: aegis-gate.testnet), NEAR_RPC_URL.

import {
  CONTRACT_ID,
  ACCOUNT_ID,
  getAccount,
  viewCall,
  nsToIso,
  api,
} from "./lib.mjs";

const [cmd, ...rest] = process.argv.slice(2);

function printAnchor(a) {
  if (a === null || a === undefined) {
    console.log("no anchor found for that report hash");
    return;
  }
  console.log(JSON.stringify(a, null, 2));
  if (a.timestamp_ns) console.log(`anchored at (UTC): ${nsToIso(a.timestamp_ns)}`);
}

if (cmd === "record") {
  const [reportHash, verdict, agentId] = rest;
  if (!reportHash || !verdict || !agentId) {
    console.error("usage: node anchor.mjs record <reportHash> <verdict> <agentId>");
    process.exit(1);
  }
  const account = getAccount();
  const outcome = await account.callFunctionRaw({
    contractId: CONTRACT_ID,
    methodName: "record_anchor",
    args: { report_hash: reportHash, verdict, agent_id: agentId },
    gas: api.teraToGas(30),
    deposit: "0",
  });
  console.log(`signer: ${ACCOUNT_ID}`);
  console.log(`contract: ${CONTRACT_ID}`);
  console.log(`tx: ${outcome.transaction.hash}`);
  console.log(`final status: ${JSON.stringify(outcome.final_execution_status)}`);
  const stored = await viewCall(CONTRACT_ID, "get_anchor", {
    report_hash: reportHash,
  });
  console.log("stored anchor (read back via view):");
  printAnchor(stored);
} else if (cmd === "get") {
  const [reportHash] = rest;
  if (!reportHash) {
    console.error("usage: node anchor.mjs get <reportHash>");
    process.exit(1);
  }
  const stored = await viewCall(CONTRACT_ID, "get_anchor", {
    report_hash: reportHash,
  });
  printAnchor(stored);
} else if (cmd === "count") {
  const count = await viewCall(CONTRACT_ID, "anchor_count");
  console.log(`anchor_count: ${count}`);
} else {
  console.error(
    "usage:\n  node anchor.mjs record <reportHash> <verdict> <agentId>\n  node anchor.mjs get <reportHash>\n  node anchor.mjs count"
  );
  process.exit(1);
}
