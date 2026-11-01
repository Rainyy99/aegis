#!/usr/bin/env node
/**
 * AEGIS — Gate 3: EIP-712 signature-payload gate.
 *
 * Question: what exactly is being signed, and who authored the payload?
 *
 * Implements Musa's off-chain signature SOP addendum (27 Oct 2026) as
 * pure, auditable structural checks on a typed-data object:
 *   1. Decode the typed data first; read domain name, chainId,
 *      verifyingContract.
 *   2. verifyingContract must not be a held token/NFT, a router, or
 *      Permit2; primaryType must not be Permit / PermitSingle /
 *      PermitBatch; no field named spender / value / amount anywhere in
 *      the message (or in the declared types — a forbidden field cannot
 *      hide by being declared but left empty).
 *   3. The domain must be scoped to that single project (checked against
 *      a caller-supplied project domain name when one is given).
 *   4. The final transaction is still built and simulated separately
 *      (to / value / resulting allowance) — that step lives outside this
 *      gate and is NOT replaced by an ALLOW here.
 * One failed hard check = BLOCK: stop, do not sign, report the payload
 * (the full payload is echoed in the report for exactly that reason).
 *
 * Verdict rules (v1.0.0, built 1 Nov 2026):
 *   BLOCK — a hard check fails: missing/unreadable domain name, chainId
 *           or verifyingContract; missing primaryType; a Permit-shaped
 *           primaryType; a forbidden field in the message or types;
 *           verifyingContract is Permit2 (built-in, chain-independent);
 *           verifyingContract appears in the caller-supplied denylist
 *           (held token/NFT contracts, routers) passed via --context /
 *           --deny.
 *   WARN  — no hard failure, but: domain.chainId differs from the
 *           expected chain supplied by the caller; domain.name is not
 *           scoped to the supplied project name; the declared types do
 *           not match the message fields (the payload may not be what it
 *           claims to be); no types table was supplied at all; or the
 *           verifyingContract is the zero address.
 *   ALLOW — no hard failure and no warning.
 * Checks that need caller context (expected chain, project name,
 * denylist) are only as strong as that context: when a piece of context
 * is not supplied, the corresponding check is recorded as not performed
 * in the report — never silently assumed to pass.
 *
 * This gate is STRUCTURAL: it does not verify any signature, recover a
 * signer, or prove the verifyingContract is really the project's. It
 * answers "is this payload shaped like something the SOP allows to be
 * signed at all", nothing more. See AUDIT.md.
 *
 * Usage:
 *   node check-signature.mjs <typed-data-json-file> [--context ctx.json]
 *   node check-signature.mjs - [--expected-chain 56]
 *                            [--project-domain "Nonce Free Mint"]
 *                            [--deny 0xabc...,0xdef...]
 *   (file "-" — or no file argument with piped stdin — reads stdin)
 *
 * Context JSON shape:
 *   { "projectDomainName": "Example Project", "expectedChainId": 56,
 *     "heldContracts": ["0x..."], "routers": ["0x..."],
 *     "deniedContracts": ["0x..."] }
 * Command-line flags override the context file.
 *
 * No external dependencies — plain Node.js (>= 18).
 * Read-only: reads one local JSON file or stdin; signs nothing, sends
 * nothing.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Primary types that are always rejected (SOP addendum): any Permit shape
// lets a signature move funds, which is exactly what Gate 3 must catch.
const FORBIDDEN_PRIMARY_TYPES = new Set(["Permit", "PermitSingle", "PermitBatch"]);

// Field names that must not appear anywhere in the message payload or in
// the declared EIP-712 types. Compared case-insensitively: renaming the
// field "Spender" does not launder it.
const FORBIDDEN_FIELDS = new Set(["spender", "value", "amount"]);

// Permit2 (Uniswap's universal approval contract) is the same address on
// every EVM chain. A signature whose verifyingContract is Permit2 is an
// approval grant by construction — built-in BLOCK, no context needed.
const PERMIT2_ADDRESS = "0x000000000022d473030f116ddee9f6b43ac78ba3";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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

const normAddr = (a) => (typeof a === "string" ? a.toLowerCase() : a);

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

// Field names declared in the EIP-712 types table (all structs).
function collectTypeFieldNames(types) {
  const out = new Set();
  if (!isPlainObject(types)) return out;
  for (const fields of Object.values(types)) {
    if (!Array.isArray(fields)) continue;
    for (const f of fields) {
      if (isPlainObject(f) && typeof f.name === "string") out.add(f.name);
    }
  }
  return out;
}

function findForbidden(fieldNames) {
  const hits = [];
  for (const name of fieldNames) {
    if (FORBIDDEN_FIELDS.has(name.toLowerCase())) hits.push(name);
  }
  return [...new Set(hits)].sort();
}

// ---------------------------------------------------------------------------
// Gate 3 interface
// ---------------------------------------------------------------------------

/**
 * Decode and structurally check one EIP-712 typed-data payload.
 *
 * @param {object} typedData - the EIP-712 object ({ domain, primaryType,
 *   message, types }). Read from a file/stdin by the CLI; passed directly
 *   by library callers.
 * @param {object} [context] - caller-supplied classification context:
 *   { projectDomainName, expectedChainId, heldContracts, routers,
 *     deniedContracts }. Anything not supplied is reported as not checked.
 * @returns {object} report with verdict.gate3 in { ALLOW, WARN, BLOCK },
 *   the decoded domain/primaryType, every failure and warning named, and
 *   the full payload echoed back (one failed check = stop and report the
 *   payload).
 */
export function checkSignature(typedData, context = {}) {
  if (!isPlainObject(typedData)) {
    throw new Error("typedData must be an EIP-712 object");
  }
  const domain = isPlainObject(typedData.domain) ? typedData.domain : {};
  const primaryType = typedData.primaryType ?? null;
  const message = isPlainObject(typedData.message) ? typedData.message : {};
  const types = isPlainObject(typedData.types) ? typedData.types : null;

  const failures = []; // -> BLOCK
  const warnings = []; // -> WARN
  const checksPerformed = [];
  const checksSkipped = [];

  // --- SOP check 1: domain fields must be present and readable -------------
  if (!domain.name) {
    failures.push("domain.name is missing — cannot scope the payload to a project.");
  }
  if (domain.chainId === undefined || domain.chainId === null) {
    failures.push("domain.chainId is missing — cannot confirm the payload is for the expected chain.");
  }
  if (!domain.verifyingContract) {
    failures.push("domain.verifyingContract is missing — cannot confirm what contract the signature authorises.");
  } else if (!ADDRESS_RE.test(domain.verifyingContract)) {
    failures.push(
      `domain.verifyingContract "${domain.verifyingContract}" is not a valid address — cannot classify it.`
    );
  }
  checksPerformed.push("domain fields present and readable");

  // --- SOP check 2a: primaryType must never be a Permit shape --------------
  if (!primaryType) {
    failures.push("primaryType is missing — this is not a decodable EIP-712 payload.");
  } else if (FORBIDDEN_PRIMARY_TYPES.has(primaryType)) {
    failures.push(`primaryType "${primaryType}" is a Permit shape — rejected by the signature SOP.`);
  }
  checksPerformed.push("primaryType is not a Permit shape");

  // --- SOP check 2b: no spender / value / amount anywhere ------------------
  const messageFields = collectFieldNames(message);
  const typeFields = collectTypeFieldNames(types);
  const forbiddenFieldsFound = [
    ...new Set([...findForbidden(messageFields), ...findForbidden(typeFields)]),
  ].sort();
  for (const f of forbiddenFieldsFound) {
    failures.push(
      `forbidden field "${f}" present in the payload (message or declared types) — rejected by the signature SOP.`
    );
  }
  checksPerformed.push("no spender/value/amount field in message or types");

  // --- SOP check 2c: verifyingContract classification ----------------------
  let verifyingContractClass = "unclassified";
  const vc = normAddr(domain.verifyingContract);
  if (vc && ADDRESS_RE.test(domain.verifyingContract)) {
    if (vc === PERMIT2_ADDRESS) {
      verifyingContractClass = "permit2";
      failures.push(
        "domain.verifyingContract is Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3) — " +
          "a signature for Permit2 is an approval grant; rejected by the signature SOP."
      );
    } else {
      const classes = [
        ["heldContracts", "held token/NFT contract"],
        ["routers", "known router"],
        ["deniedContracts", "caller-denied contract"],
      ];
      for (const [key, label] of classes) {
        const list = Array.isArray(context[key]) ? context[key].map(normAddr) : [];
        if (list.includes(vc)) {
          verifyingContractClass = key;
          failures.push(
            `domain.verifyingContract is a ${label} supplied by the caller — ` +
              "the SOP forbids signing payloads that authorise contracts the user holds assets in or routes funds through."
          );
          break;
        }
      }
      if (vc === ZERO_ADDRESS) {
        warnings.push(
          "domain.verifyingContract is the zero address — the payload authorises nothing identifiable; treat with suspicion."
        );
      }
    }
    checksPerformed.push("verifyingContract classified (Permit2 built-in; held/router lists from caller context)");
  }

  // --- SOP check 3a: chainId matches the expected chain --------------------
  const expectedChainId = context.expectedChainId ?? null;
  if (expectedChainId !== null && expectedChainId !== undefined) {
    checksPerformed.push("chainId matches expected chain");
    const actual = Number(domain.chainId);
    if (!Number.isInteger(actual) || actual !== Number(expectedChainId)) {
      warnings.push(
        `domain.chainId is ${domain.chainId} but the action being authorised is on chain ${expectedChainId} — chainId mismatch.`
      );
    }
  } else {
    checksSkipped.push("chainId match (no expected chain supplied by caller)");
  }

  // --- SOP check 3b: domain scoped to the single project -------------------
  const projectDomainName = context.projectDomainName ?? null;
  if (projectDomainName) {
    checksPerformed.push("domain scoped to the project");
    const dn = typeof domain.name === "string" ? domain.name.toLowerCase() : "";
    const pn = String(projectDomainName).toLowerCase();
    if (dn !== pn && !dn.includes(pn)) {
      warnings.push(
        `domain.name "${domain.name}" is not scoped to the project under check ("${projectDomainName}") — ` +
          "the payload may belong to a different project than the one being reviewed."
      );
    }
  } else {
    checksSkipped.push("domain scoping (no project domain name supplied by caller)");
  }

  // --- Types-shape audit: declared types vs actual message fields ----------
  if (types === null) {
    warnings.push(
      "No EIP-712 types table supplied — the payload cannot be fully decoded; what a wallet would sign cannot be confirmed from this input alone."
    );
  } else if (primaryType && Array.isArray(types[primaryType])) {
    checksPerformed.push("declared types match message fields");
    const declared = types[primaryType]
      .filter((f) => isPlainObject(f) && typeof f.name === "string")
      .map((f) => f.name);
    const actualTopLevel = Object.keys(message);
    const undeclared = actualTopLevel.filter((k) => !declared.includes(k));
    const missing = declared.filter((k) => !(k in message));
    if (undeclared.length > 0 || missing.length > 0) {
      const parts = [];
      if (undeclared.length > 0) parts.push(`message fields not declared in types: ${undeclared.join(", ")}`);
      if (missing.length > 0) parts.push(`declared fields absent from message: ${missing.join(", ")}`);
      warnings.push(
        `Types/message mismatch for primaryType "${primaryType}" (${parts.join("; ")}) — ` +
          "the payload is not exactly what its declared shape claims."
      );
    }
  } else if (primaryType) {
    warnings.push(
      `types table has no entry for primaryType "${primaryType}" — the payload's shape cannot be audited.`
    );
  }

  let gate3 = "ALLOW";
  if (failures.length > 0) gate3 = "BLOCK";
  else if (warnings.length > 0) gate3 = "WARN";

  const reasons = [...failures, ...warnings];
  if (gate3 === "ALLOW") {
    reasons.push(
      "Payload decodes cleanly: domain present, no Permit shape, no " +
        "spender/value/amount field, verifyingContract not Permit2 and " +
        "not on the caller's denylist, and every supplied context check " +
        "(chain, project scope, types shape) passed."
    );
  }

  return {
    tool: "aegis-check-signature",
    version: "1.0.0",
    checkedAt: new Date().toISOString(),
    decoded: {
      domain: {
        name: domain.name ?? null,
        version: domain.version ?? null,
        chainId: domain.chainId ?? null,
        verifyingContract: domain.verifyingContract ?? null,
      },
      primaryType,
      messageFields: [...messageFields].sort(),
      verifyingContractClass,
    },
    forbiddenFieldsFound,
    checks: { performed: checksPerformed, skipped: checksSkipped },
    failures,
    warnings,
    verdict: { gate3, reasons },
    // The full payload is echoed so a BLOCK can be reported verbatim,
    // per the SOP: one failed check = stop and report the payload.
    payload: typedData,
    disclaimer:
      "Gate 3 screening signal only — structural, not cryptographic. " +
      "This gate does not verify any signature or prove the " +
      "verifyingContract is really the project's, and an ALLOW never " +
      "replaces building and simulating the final transaction separately.",
  };
}

// ---------------------------------------------------------------------------
// Main (CLI)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

function loadContext(contextFile, flags) {
  const context = {};
  if (contextFile) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(contextFile, "utf8"));
    } catch (err) {
      fail(`Cannot read context JSON from ${contextFile}: ${err.message}`);
    }
    if (!isPlainObject(parsed)) fail(`Context file ${contextFile} must contain a JSON object`);
    Object.assign(context, parsed);
  }
  if (flags.expectedChain !== undefined) context.expectedChainId = Number(flags.expectedChain);
  if (flags.projectDomain !== undefined) context.projectDomainName = flags.projectDomain;
  if (flags.deny !== undefined) {
    const extra = flags.deny.split(",").map((s) => s.trim()).filter(Boolean);
    context.deniedContracts = [...(context.deniedContracts ?? []), ...extra];
  }
  return context;
}

// Read stdin as a stream, not readFileSync(0): under a spawned pipe the
// fd can be non-blocking and the sync read never returns. The stream
// iteration works for terminal, file, and pipe stdin alike.
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const positional = [];
  const flags = {};
  let contextFile = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--context") contextFile = args[++i] ?? fail("--context requires a file path");
    else if (a === "--expected-chain") flags.expectedChain = args[++i] ?? fail("--expected-chain requires a chain id");
    else if (a === "--project-domain") flags.projectDomain = args[++i] ?? fail("--project-domain requires a name");
    else if (a === "--deny") flags.deny = args[++i] ?? fail("--deny requires a comma-separated address list");
    else positional.push(a);
  }
  const fileArg = positional[0] ?? "-";

  let raw;
  try {
    raw = fileArg === "-" ? await readStdin() : readFileSync(fileArg, "utf8");
  } catch (err) {
    fail(`Cannot read typed-data JSON from ${fileArg === "-" ? "stdin" : fileArg}: ${err.message}`);
  }
  let typedData;
  try {
    typedData = JSON.parse(raw);
  } catch (err) {
    fail(`Typed-data input is not valid JSON: ${err.message}`);
  }
  const context = loadContext(contextFile, flags);
  let report;
  try {
    report = checkSignature(typedData, context);
  } catch (err) {
    fail(err.message);
  }
  console.log(JSON.stringify(report, null, 2));
}

// Run as CLI only when executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => fail(`Unexpected error: ${err.message}`));
}
