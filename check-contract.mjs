#!/usr/bin/env node
/**
 * AEGIS — Gate 2 prototype: contract verification & risk-pattern scanner.
 *
 * Given a contract address (BSC / chainId 56 by default), this tool:
 *   1. Queries the Sourcify API v2 for the contract's verification status
 *      and verified source code.
 *   2. Scans the source for risk patterns (approval surface, fund-flow
 *      functions, critical primitives, owner-admin surface).
 *   3. Prints a structured JSON verdict to stdout.
 *
 * It is a SCREENING tool, not an auditor: pattern counts are evidence for a
 * human/agent review, never a final judgement on their own. A standard
 * ERC-721 will always "contain" transferFrom/approve (inherited library
 * code); what matters is where a pattern lives (project source vs library)
 * and whether a human audit has attributed it.
 *
 * Usage:
 *   node check-contract.mjs <address> [chainId]
 *   node check-contract.mjs 0x00fbc656caa753a5280835bf9e849c4c0aff9bf4
 *   node check-contract.mjs 0x00fbc656caa753a5280835bf9e849c4c0aff9bf4 56
 *
 * No external dependencies — plain Node.js (>= 18) fetch.
 * Read-only: performs GET requests against the public Sourcify API only.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Sourcify API v2. NOTE: the live route is /server/v2/contract/... — the
// older /server/api/v2/... prefix returns the frontend's HTML 404 page.
// The default response contains only the match summary; the verified source
// code must be requested explicitly with ?fields=sources.
const SOURCIFY_API = "https://sourcify.dev/server/v2/contract";

const DEFAULT_CHAIN_ID = 56; // BNB Smart Chain
const FETCH_TIMEOUT_MS = 30_000;

// Bounded retry for the Sourcify lookup (v0.2.0): transient failures
// (network errors, HTTP 429, HTTP 5xx) are retried up to 3 attempts total
// with short backoff. Definitive answers (200 verified / 404 not verified)
// and definitive request errors (other 4xx, e.g. 400 unsupported chain) are
// never retried and never turned into a fabricated verdict.
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 1500]; // wait before attempt 2 and attempt 3

// Second source for the verification status: probed 2026-10-29, no keyless
// independent source was viable for BSC — Blockscout's BSC API returns a
// blanket 404, Sourcify API v1 is removed, Routescan does not support
// chain 56, and GoPlus token_security only indexes ERC-20 tokens (empty
// result for NFT/general contracts). BscScan/Etherscan require API keys.
// So Sourcify v2 remains the single trust anchor for now (AUDIT.md,
// "Perbaikan v0.2.0"), hardened by the bounded retry above; the report's
// verification.crossCheck field states this on every run instead of
// pretending a cross-check happened.

// Risk patterns, grouped by why AEGIS cares about them.
// `regex` counts raw textual occurrences in the source (code + comments).
const PATTERNS = [
  // Critical primitives: arbitrary external execution / contract destruction.
  // Their presence in PROJECT source always forces human review (WARN).
  { key: "delegatecall", tier: "critical", regex: /\bdelegatecall\b/g },
  { key: "selfdestruct", tier: "critical", regex: /\bselfdestruct\b/g },
  // Signature-based approval: an EIP-2612-style permit lets a signature move
  // funds — directly relevant to AEGIS Gate 3. Forces human review (WARN).
  { key: "permit", tier: "review", regex: /\bpermit\b/gi },
  // Approval surface: standard on ERC-20/721 tokens, dangerous only in
  // unexpected places. Reported as evidence, does not change the verdict.
  { key: "approve", tier: "surface", regex: /\bapprove\b/g },
  { key: "setApprovalForAll", tier: "surface", regex: /\bsetApprovalForAll\b/g },
  // Fund-flow surface: likewise standard on tokens; evidence only.
  { key: "transferFrom", tier: "surface", regex: /\btransferFrom\b/g },
  { key: "withdraw", tier: "surface", regex: /\bwithdraw[A-Za-z0-9_]*\b/g },
  // Owner-admin surface: centralisation evidence (who can change the rules?).
  { key: "onlyOwner", tier: "admin", regex: /\bonlyOwner\b/g },
];

// Setter-style function definitions (setPrice, setBaseURI, ...) — the classic
// "admin can rewrite the deal after you bought in" surface. Names are listed,
// not just counted, so a reviewer can judge each one.
const SETTER_REGEX = /function\s+(set[A-Z][A-Za-z0-9_]*)\s*\(/g;

// Standard token-interface functions that match the set* shape but are NOT
// admin setters: every token holder calls setApprovalForAll; listing it as an
// "admin setter" is a false friend. It stays visible in the pattern counts.
const SETTER_EXCLUSIONS = new Set(["setApprovalForAll"]);

// Files under node_modules/ are third-party library code (e.g. OpenZeppelin);
// everything else is treated as the project's own source.
const isLibraryPath = (p) => p.startsWith("node_modules/");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countMatches(text, regex) {
  const m = text.match(regex);
  return m ? m.length : 0;
}

function emptyCounts() {
  const counts = {};
  for (const p of PATTERNS) counts[p.key] = 0;
  counts.setterFunctions = [];
  return counts;
}

function scanSource(text) {
  const counts = emptyCounts();
  for (const p of PATTERNS) counts[p.key] = countMatches(text, p.regex);
  const setters = new Set();
  for (const m of text.matchAll(SETTER_REGEX)) {
    if (!SETTER_EXCLUSIONS.has(m[1])) setters.add(m[1]);
  }
  counts.setterFunctions = [...setters].sort();
  return counts;
}

function mergeCounts(a, b) {
  const out = emptyCounts();
  for (const p of PATTERNS) out[p.key] = a[p.key] + b[p.key];
  out.setterFunctions = [...new Set([...a.setterFunctions, ...b.setterFunctions])].sort();
  return out;
}

function fail(message) {
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch the Sourcify v2 contract record with bounded retries.
// Returns { res, attempts } for the two definitive statuses (200 / 404).
// Any other 4xx fails immediately; retryable failures that exhaust the
// attempts fail loudly — in both cases via fail(), so no verdict is issued.
async function fetchSourcify(url) {
  let lastFailure = "unknown error";
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      lastFailure = `network error (${err.message})`;
      if (attempt < MAX_FETCH_ATTEMPTS) await sleep(RETRY_BACKOFF_MS[attempt - 1]);
      continue;
    }
    if (res.status === 200 || res.status === 404) {
      return { res, attempts: attempt };
    }
    if (res.status === 429 || res.status >= 500) {
      lastFailure = `HTTP ${res.status}`;
      if (attempt < MAX_FETCH_ATTEMPTS) await sleep(RETRY_BACKOFF_MS[attempt - 1]);
      continue;
    }
    fail(
      `Sourcify request failed: HTTP ${res.status} ` +
        "(unsupported chain or request error — no verdict issued)"
    );
  }
  fail(
    `Sourcify request failed after ${MAX_FETCH_ATTEMPTS} attempts ` +
      `(last: ${lastFailure}) — transient failure, no verdict issued; retry later`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [, , addressArg, chainIdArg] = process.argv;

  if (!addressArg || !/^0x[0-9a-fA-F]{40}$/.test(addressArg)) {
    fail("Usage: node check-contract.mjs <0x-address> [chainId=56]");
  }
  const chainId = chainIdArg ? Number(chainIdArg) : DEFAULT_CHAIN_ID;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    fail(`Invalid chainId: ${chainIdArg}`);
  }
  const address = addressArg; // Sourcify accepts any hex casing.

  // --- Step 1: verification status + verified sources from Sourcify --------
  // Sourcify answers 200 for verified contracts and 404 (with a JSON body,
  // match: null) for contracts it has never verified — that 404 body IS the
  // "not verified" answer, not an error. fetchSourcify retries transient
  // failures (network / 429 / 5xx) with backoff and fails loudly on anything
  // that is not a definitive answer, so an outage or rate limit can never be
  // misread as a verdict (see AUDIT.md Fix 1 and the v0.2.0 note).
  const url = `${SOURCIFY_API}/${chainId}/${address}?fields=sources`;
  let data;
  let lookupAttempts = 1;
  try {
    const { res, attempts } = await fetchSourcify(url);
    lookupAttempts = attempts;
    data = await res.json();
  } catch (err) {
    fail(`Sourcify request failed: ${err.message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    fail("Sourcify returned an unexpected response (not a JSON object) — no verdict issued");
  }

  const verified = data.match !== null && data.match !== undefined;
  const report = {
    tool: "aegis-check-contract",
    version: "0.2.0",
    queriedAt: new Date().toISOString(),
    chainId,
    address,
    verification: {
      verified,
      match: data.match ?? null,
      creationMatch: data.creationMatch ?? null,
      runtimeMatch: data.runtimeMatch ?? null,
      verifiedAt: data.verifiedAt ?? null,
      matchId: data.matchId ?? null,
      lookup: {
        source: "sourcify-v2",
        attempts: lookupAttempts,
        maxAttempts: MAX_FETCH_ATTEMPTS,
      },
      crossCheck: {
        status: "unavailable",
        detail:
          "No keyless independent second source for verification status " +
          "was viable at build time (probed 2026-10-29; see AUDIT.md, " +
          "Perbaikan v0.2.0). Sourcify v2 is the trust anchor, hardened " +
          "with bounded retries.",
      },
    },
    sources: null,
    patterns: null,
    verdict: null,
    disclaimer:
      "Gate 2 screening signal only. Pattern counts are raw occurrences in " +
      "verified source (code and comments); a human/agent audit must attribute " +
      "them before any execution decision. See the AEGIS case files.",
  };

  if (!verified) {
    report.verdict = {
      gate2: "BLOCK",
      reasons: [
        "Contract is not verified on Sourcify (no source available to audit). " +
          "AEGIS never executes against unverifiable code.",
      ],
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // --- Step 2: pattern scan, split by project vs library source -------------
  const sources =
    data.sources && typeof data.sources === "object" ? data.sources : {};
  const files = Object.entries(sources).map(([path, v]) => ({
    path,
    content: v && typeof v.content === "string" ? v.content : "",
    library: isLibraryPath(path),
  }));

  let projectCounts = emptyCounts();
  let libraryCounts = emptyCounts();
  const perFile = {};
  let totalChars = 0;

  for (const f of files) {
    totalChars += f.content.length;
    const c = scanSource(f.content);
    if (f.library) {
      libraryCounts = mergeCounts(libraryCounts, c);
    } else {
      projectCounts = mergeCounts(projectCounts, c);
      perFile[f.path] = c;
    }
  }

  report.sources = {
    fileCount: files.length,
    projectFiles: files.filter((f) => !f.library).map((f) => f.path),
    libraryFileCount: files.filter((f) => f.library).length,
    totalChars,
  };
  report.patterns = {
    project: projectCounts,
    library: libraryCounts,
    perFile,
  };

  // --- Step 3: screening verdict --------------------------------------------
  // Rules (deliberately conservative, and every trigger is named):
  //   BLOCK — not verified (handled above).
  //   WARN  — a critical primitive (delegatecall/selfdestruct) or a permit
  //           surface appears in PROJECT source: a human must attribute it
  //           before the contract can pass Gate 2. Also WARN: Sourcify
  //           reports only a partial_match (v0.2.0) — the source is not an
  //           exact match for the deployed bytecode, so it is not counted
  //           as fully verified.
  //   ALLOW — verified exact_match, nothing in project source forces
  //           review; remaining counts are attached as evidence notes.
  const reasons = [];
  let gate2 = "ALLOW";

  if (files.length === 0) {
    // Verified according to the API, but there is nothing to scan — an ALLOW
    // here would claim a clean scan that never happened.
    gate2 = "WARN";
    reasons.push(
      "Sourcify reports this contract as verified but returned no source " +
        "files to scan — fetch and review the source manually before " +
        "trusting any verdict."
    );
  }

  if (data.match === "partial_match") {
    // A partial match means the submitted source does not reproduce the
    // deployed bytecode exactly (metadata/compiler details differ, or only
    // part of the code is accounted for). It must not ride along as "fully
    // verified": downgrade to WARN with the gap named explicitly.
    gate2 = "WARN";
    reasons.push(
      "Sourcify match is only \"partial_match\", not \"exact_match\": the " +
        "verified source is not a byte-for-byte match for the deployed " +
        "contract, so AEGIS does not count it as fully verified. Require " +
        "an exact match or a manual bytecode-level review before " +
        "execution."
    );
  }

  for (const p of PATTERNS) {
    if (p.tier !== "critical" && p.tier !== "review") continue;
    const n = projectCounts[p.key];
    if (n > 0) {
      gate2 = "WARN";
      reasons.push(
        `Project source contains ${n}x "${p.key}" (${p.tier} pattern) — ` +
          "human audit must attribute this before execution."
      );
    }
  }
  if (gate2 === "ALLOW") {
    reasons.push(
      `Verified ${data.match}; no critical/permit patterns in project source.`
    );
  }
  const notes = [];
  for (const p of PATTERNS) {
    if (p.tier !== "surface" && p.tier !== "admin") continue;
    if (projectCounts[p.key] > 0) {
      notes.push(`project source: ${projectCounts[p.key]}x "${p.key}"`);
    }
  }
  if (projectCounts.setterFunctions.length > 0) {
    notes.push(
      `project setters: ${projectCounts.setterFunctions.join(", ")}`
    );
  }
  if (notes.length > 0) {
    reasons.push(`Evidence (attributed by audit, see case files): ${notes.join("; ")}`);
  }

  report.verdict = { gate2, reasons };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => fail(`Unexpected error: ${err.message}`));
