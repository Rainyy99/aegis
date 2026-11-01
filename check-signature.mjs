#!/usr/bin/env node
/**
 * AEGIS — Gate 3 prototype (SCAFFOLD): EIP-712 signature-payload decoder.
 *
 * Question: what exactly is being signed, and who authored the payload?
 *
 * Implements the structural part of Musa's off-chain signature SOP
 * addendum (27 Oct 2026) as pure, auditable checks on a typed-data object:
 *   1. Decode the typed data first; read domain name, chainId,
 *      verifyingContract.
 *   2. verifyingContract must not be a held token/NFT, a router, or
 *      Permit2; primaryType must not be Permit / PermitSingle / PermitBatch;
 *      no field named spender / value / amount anywhere in the message.
 *   3. The domain must be scoped to that single project.
 *   4. The final transaction is still built and simulated separately
 *      (to / value / resulting allowance) — that step lives outside this
 *      scaffold and outside this gate.
 *
 * STATUS: scaffold, prepared 31 Oct 2026 for the in-window build
 * (1–7 Nov 2026). The structural checks below are real, but the gate is
 * NOT complete: domain scoping and verifyingContract classification still
 * need caller-supplied context (see TODOs), so this file's output is NOT
 * a verdict to sign on. One failed check = stop and report the payload.
 *
 * Usage (scaffold):
 *   node check-signature.mjs <typed-data-json-file>
 *
 * No external dependencies — plain Node.js (>= 18).
 * Read-only: reads one local JSON file, signs nothing, sends nothing.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Primary types that are always rejected (SOP addendum): any Permit shape
// lets a signature move funds, which is exactly what Gate 3 must catch.
const FORBIDDEN_PRIMARY_TYPES = new Set(["Permit", "PermitSingle", "PermitBatch"]);

// Field names that must not appear anywhere in the message payload.
const FORBIDDEN_FIELDS = new Set(["spender", "value", "amount"]);

// TODO(build): the verifyingContract classification list cannot be a
// hardcoded constant — it depends on the user's own holdings and on known
// routers / Permit2 deployments per chain. The build must take them as
// explicit input (held token/NFT addresses, router addresses, Permit2
// address for the chain) and reject a verifyingContract that matches any.
const KNOWN_DENYLIST_NOTE =
  "verifyingContract classification needs caller-supplied context: " +
  "held token/NFT addresses, router addresses, Permit2 address (chain-specific).";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Collect every field name appearing anywhere inside a message object,
// including nested structs and arrays, so a forbidden field cannot hide
// one level down.
function collectFieldNames(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectFieldNames(item, out);
  } else if (isPlainObject(value)) {
    for (const [key, val] of Object.entries(value)) {
      out.add(key);
      collectFieldNames(val, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gate 3 interface
// ---------------------------------------------------------------------------

/**
 * Decode and structurally check one EIP-712 typed-data payload.
 *
 * @param {object} typedData - the EIP-712 object ({ domain, primaryType,
 *   message, types }). Read from a file by the CLI; passed directly by
 *   library callers.
 * @returns {object} scaffold report: { gate3, domain, primaryType,
 *   forbiddenFieldsFound, failures, todos }.
 *   gate3 is "SCAFFOLD" until the build implements domain scoping and
 *   verifyingContract classification — never ALLOW on its own. Any entry
 *   in `failures` means: stop, do not sign, report the payload.
 */
export function checkSignature(typedData) {
  if (!isPlainObject(typedData)) {
    throw new Error("typedData must be an EIP-712 object");
  }
  const domain = isPlainObject(typedData.domain) ? typedData.domain : {};
  const primaryType = typedData.primaryType ?? null;
  const message = isPlainObject(typedData.message) ? typedData.message : {};

  const failures = [];

  // SOP check 1: domain fields must be present and readable.
  if (!domain.name) failures.push("domain.name is missing — cannot scope the payload to a project.");
  if (domain.chainId === undefined || domain.chainId === null) {
    failures.push("domain.chainId is missing — cannot confirm the payload is for the expected chain.");
  }
  if (!domain.verifyingContract) {
    failures.push("domain.verifyingContract is missing — cannot confirm what contract the signature authorises.");
  }

  // SOP check 2: primaryType must never be a Permit shape.
  if (primaryType && FORBIDDEN_PRIMARY_TYPES.has(primaryType)) {
    failures.push(`primaryType "${primaryType}" is a Permit shape — rejected by the signature SOP.`);
  }

  // SOP check 3: no spender / value / amount field anywhere in the message.
  const fieldNames = collectFieldNames(message);
  const forbiddenFieldsFound = [...FORBIDDEN_FIELDS].filter((f) => fieldNames.has(f));
  for (const f of forbiddenFieldsFound) {
    failures.push(`message contains forbidden field "${f}" — rejected by the signature SOP.`);
  }

  return {
    tool: "aegis-check-signature",
    version: "0.1.0-scaffold",
    gate3: "SCAFFOLD",
    domain: {
      name: domain.name ?? null,
      chainId: domain.chainId ?? null,
      verifyingContract: domain.verifyingContract ?? null,
    },
    primaryType,
    forbiddenFieldsFound,
    failures,
    todos: [
      `TODO(build): verifyingContract classification — ${KNOWN_DENYLIST_NOTE}`,
      "TODO(build): domain scoping — confirm domain.name belongs to the single project under check (per-project registry), and that no second project's domain is mixed in.",
      "TODO(build): chainId match — confirm domain.chainId equals the chain of the action being authorised, not just that it is present.",
      "TODO(build): types-shape audit — confirm the declared EIP-712 types match the message fields (a mismatch means the payload is not what it claims to be).",
      "TODO(build): payload provenance — a payload authored at runtime by a counterparty's server fails by construction (Gate 4 input); wire that signal in.",
      "TODO(build): add tests — clean payload, Permit payload, spender/value/amount payloads, missing-domain payload, server-authored payload.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Main (CLI scaffold)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

function main() {
  const [, , fileArg] = process.argv;
  if (!fileArg) {
    fail("Usage: node check-signature.mjs <typed-data-json-file>");
  }
  let typedData;
  try {
    typedData = JSON.parse(readFileSync(fileArg, "utf8"));
  } catch (err) {
    fail(`Cannot read typed-data JSON from ${fileArg}: ${err.message}`);
  }
  let report;
  try {
    report = checkSignature(typedData);
  } catch (err) {
    fail(err.message);
  }
  console.log(JSON.stringify(report, null, 2));
}

// Run as CLI only when executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
