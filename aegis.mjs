#!/usr/bin/env node
/**
 * AEGIS — unified runner: all four gates, one report, one hash.
 *
 * Runs whichever gates the supplied inputs allow and merges their
 * verdicts into a single JSON report whose SHA-256 hash (reportHash)
 * is the value a later step anchors on NEAR testnet: anyone can
 * re-run the same inputs, recompute the hash, and check it against
 * the anchored value without trusting this machine.
 *
 * Gates and the input that makes each applicable:
 *   Gate 1 (provenance)   — --claim <text> (plus the same source flags
 *                           as check-provenance.mjs: --official,
 *                           --independent, --registry, --relayed)
 *   Gate 2 (contract)     — --contract <0x-address> [--chain <chainId>]
 *   Gate 3 (signature)    — --typed-data <file> (plus the same context
 *                           flags as check-signature.mjs: --context,
 *                           --expected-chain, --project-domain, --deny)
 *   Gate 4 (instructions) — --brief <text-file>
 * A gate whose primary input is absent is SKIPPED (with the reason);
 * flags belonging to a skipped gate are ignored. At least one gate
 * input is required — running with none is a usage error (exit 1).
 * Gates 1, 3, 4 are imported from their modules; Gate 2 has no library
 * interface, so it is invoked as the check-contract.mjs CLI and its
 * stdout JSON is parsed — the runner never duplicates gate internals.
 *
 * Per-gate outcomes:
 *   VERDICT    — the gate produced ALLOW / WARN / BLOCK.
 *   SKIPPED    — not applicable (primary input absent). Never affects
 *                the merge and never marks the report incomplete.
 *   NO_VERDICT — the gate was applicable but errored or returned no
 *                verdict (transient fetch failure, malformed input,
 *                the gate CLI exiting non-zero, ...). Fail-honest: a
 *                gate that could not run is never silently passed.
 *
 * Merge rule (the overall verdict):
 *   overall = the worst verdict among gates that produced one
 *   (BLOCK > WARN > ALLOW). If any applicable gate is NO_VERDICT, the
 *   overall verdict may not be ALLOW: it is capped at WARN and the
 *   report carries `overall.incomplete: true` with the reasons. If no
 *   applicable gate produced a verdict at all, the overall verdict is
 *   NO_VERDICT (and the runner exits 1 — the report is still printed).
 *
 * reportHash — canonical form and exclusions:
 *   The hash is SHA-256 (Node built-in crypto) over the canonical
 *   serialization of the report body. Canonical serialization:
 *   JSON with object keys sorted recursively (UTF-16 code-unit order),
 *   arrays kept in order, no insignificant whitespace, hashed as
 *   UTF-8. Excluded from the hashed body (volatile fields):
 *     - generatedAt  (the runner's wall-clock timestamp)
 *     - reportHash   (the hash itself)
 *   Everything else — inputs summary (including SHA-256 digests of
 *   the typed-data / brief / context inputs), per-gate verdicts,
 *   reasons and curated evidence, the merge outcome — is hashed.
 *   Re-running identical inputs therefore reproduces the identical
 *   hash; live-gate evidence reflects the sources at run time, so a
 *   changed upstream source legitimately changes the hash.
 *
 * Output: the JSON report on stdout; a short human summary (overall
 * verdict + one line per gate) on stderr — stdout stays machine-clean.
 * --pretty expands the stderr summary to every per-gate reason.
 * Exit codes: 0 when an overall verdict (ALLOW / WARN / BLOCK) was
 * produced; 1 for usage errors and when the overall verdict is
 * NO_VERDICT (report still printed to stdout in that case).
 *
 * Usage:
 *   node aegis.mjs --contract 0x00fb...9bf4 \
 *                  --claim 0x00fb...9bf4 --official https://hashstone.dev \
 *                  --independent https://sourcify.dev/... \
 *                  --typed-data payload.json --context ctx.json \
 *                  --brief page.txt [--pretty]
 *
 * Known limits: runner gate inputs are local files — stdin composition
 * (supported by the individual Gate 3/4 CLIs) is not wired here; the
 * report embeds per-gate verdicts + curated evidence, not the full
 * per-gate reports (run a gate's own CLI for its complete output).
 * Per-gate limitations are unchanged — see AUDIT.md.
 *
 * No external dependencies — plain Node.js (>= 18).
 */

// ---------------------------------------------------------------------------
// Imports (gates 1/3/4 as libraries; gate 2 via its CLI)
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkProvenance } from "./check-provenance.mjs";
import { checkSignature } from "./check-signature.mjs";
import { scoreInstructions } from "./check-instructions.mjs";

const KIT_DIR = dirname(fileURLToPath(import.meta.url));

const RUNNER_VERSION = "1.0.0";
const GATE_TOOLS = {
  gate1: { tool: "aegis-check-provenance", version: "1.0.0", label: "provenance" },
  gate2: { tool: "aegis-check-contract", version: "0.2.0", label: "contract" },
  gate3: { tool: "aegis-check-signature", version: "1.0.0", label: "signature" },
  gate4: { tool: "aegis-check-instructions", version: "1.0.0", label: "instructions" },
};

const SEVERITY = { ALLOW: 1, WARN: 2, BLOCK: 3 };

// Gate 2 fetches with a 30 s timeout and up to 3 attempts (plus backoff),
// so a hung lookup needs a generous ceiling before the runner gives up.
const GATE2_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Canonical serialization (documented in the header): JSON with object
 * keys sorted recursively, arrays in order, no whitespace.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") +
    "}"
  );
}

/**
 * SHA-256 of the canonical report body. Volatile fields (generatedAt,
 * reportHash) are excluded — see the header for the full rule.
 */
export function computeReportHash(report) {
  const body = { ...report };
  delete body.generatedAt;
  delete body.reportHash;
  return sha256Hex(canonicalize(body));
}

// Run a child process to completion, collecting stdout/stderr.
// Resolves { code, stdout, stderr } or { code: 1, stdout, stderr, error }.
function spawnCollect(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr, error: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

const skipped = (gateKey, reason) => ({
  status: "SKIPPED",
  verdict: null,
  reasons: [reason],
  evidence: null,
  tool: GATE_TOOLS[gateKey].tool,
  version: GATE_TOOLS[gateKey].version,
});

const noVerdict = (gateKey, reason) => ({
  status: "NO_VERDICT",
  verdict: null,
  reasons: [reason],
  evidence: null,
  tool: GATE_TOOLS[gateKey].tool,
  version: GATE_TOOLS[gateKey].version,
});

// ---------------------------------------------------------------------------
// Gate adapters — each returns { status, verdict, reasons, evidence, ... }
// ---------------------------------------------------------------------------

async function runGate1(p) {
  try {
    const report = await checkProvenance({
      claim: p.claim,
      officialSource: p.officialSource,
      independentSource: p.independentSource,
      relayedFrom: p.relayedFrom,
      officialDomains: p.officialDomains,
    });
    const s = report.sources ?? {};
    return {
      status: "VERDICT",
      verdict: report.verdict.gate1,
      reasons: report.verdict.reasons ?? [],
      evidence: {
        official: s.official
          ? {
              host: s.official.host,
              registryMatch: s.official.registryMatch,
              claimFound: s.official.claimFound,
            }
          : null,
        independent: s.independent
          ? {
              host: s.independent.host,
              kind: s.independent.kind,
              differentHost: s.independent.differentHost,
              claimFound: s.independent.claimFound,
            }
          : null,
      },
      tool: report.tool,
      version: report.version,
    };
  } catch (err) {
    return noVerdict(
      "gate1",
      `Gate 1 produced no verdict: ${err.message} ` +
        "(transient source failure is reported, never converted into a pass)"
    );
  }
}

async function runGate2({ address, chainId }) {
  const script = join(KIT_DIR, "check-contract.mjs");
  const { code, stdout, stderr, error } = await spawnCollect(
    process.execPath,
    [script, address, String(chainId)],
    GATE2_TIMEOUT_MS
  );
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // Not JSON — handled as no-verdict below.
  }
  if (code === 0 && json?.verdict?.gate2) {
    return {
      status: "VERDICT",
      verdict: json.verdict.gate2,
      reasons: json.verdict.reasons ?? [],
      evidence: {
        address: json.address ?? address,
        chainId: json.chainId ?? chainId,
        verified: json.verification?.verified ?? null,
        match: json.verification?.match ?? null,
      },
      tool: json.tool,
      version: json.version,
    };
  }
  let detail = (error ?? stderr ?? "").trim();
  try {
    const e = JSON.parse(stderr);
    if (e?.error) detail = e.error;
  } catch {
    // Keep the raw stderr text.
  }
  if (!detail) detail = `gate CLI exited with code ${code} and no output`;
  return noVerdict(
    "gate2",
    `Gate 2 produced no verdict: ${detail.split("\n")[0]}`
  );
}

// Reads a gate input file once: returns { bytes, sha256, text } or
// { error } — the digest feeds the report's inputs summary either way
// the gate itself rules on the content.
function readInputFile(file) {
  try {
    const bytes = readFileSync(file);
    return { bytes, sha256: sha256Hex(bytes), text: bytes.toString("utf8") };
  } catch (err) {
    return { error: err.message };
  }
}

function runGate3({ typedDataFile, fileContent, context, contextError }) {
  if (contextError) {
    return noVerdict("gate3", `Gate 3 produced no verdict: ${contextError}`);
  }
  if (fileContent.error) {
    return noVerdict(
      "gate3",
      `Gate 3 produced no verdict: cannot read typed-data file ${typedDataFile}: ${fileContent.error}`
    );
  }
  let typedData;
  try {
    typedData = JSON.parse(fileContent.text);
  } catch (err) {
    return noVerdict(
      "gate3",
      `Gate 3 produced no verdict: typed-data input is not valid JSON: ${err.message}`
    );
  }
  try {
    const report = checkSignature(typedData, context ?? {});
    return {
      status: "VERDICT",
      verdict: report.verdict.gate3,
      reasons: report.verdict.reasons ?? [],
      evidence: {
        decoded: report.decoded,
        forbiddenFieldsFound: report.forbiddenFieldsFound,
      },
      tool: report.tool,
      version: report.version,
    };
  } catch (err) {
    return noVerdict("gate3", `Gate 3 produced no verdict: ${err.message}`);
  }
}

function runGate4({ briefFile, fileContent }) {
  if (fileContent.error) {
    return noVerdict(
      "gate4",
      `Gate 4 produced no verdict: cannot read brief file ${briefFile}: ${fileContent.error}`
    );
  }
  try {
    const report = scoreInstructions(fileContent.text);
    const triggeredSignals = Object.entries(report.signals ?? {})
      .filter(([, s]) => s.count > 0)
      .map(([key, s]) => ({ key, count: s.count, weighted: s.weighted }))
      .sort((a, b) => b.weighted - a.weighted);
    return {
      status: "VERDICT",
      verdict: report.verdict.gate4,
      reasons: report.verdict.reasons ?? [],
      evidence: {
        score: report.score,
        thresholds: report.thresholds,
        sequenceDetected: report.sequence?.detected ?? null,
        triggeredSignals,
      },
      tool: report.tool,
      version: report.version,
    };
  } catch (err) {
    return noVerdict("gate4", `Gate 4 produced no verdict: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Merge rule (documented in the header and in AUDIT.md)
// ---------------------------------------------------------------------------

function mergeGates(gates) {
  const entries = Object.entries(gates);
  const verdicts = entries
    .filter(([, g]) => g.status === "VERDICT")
    .map(([, g]) => g.verdict);
  const failed = entries.filter(([, g]) => g.status === "NO_VERDICT");
  const incomplete = failed.length > 0;
  const incompleteReasons = failed.map(
    ([key, g]) => `${key}: ${g.reasons[0] ?? "no verdict"}`
  );

  let verdict;
  if (verdicts.length === 0) {
    verdict = "NO_VERDICT";
  } else {
    verdict = verdicts.reduce(
      (worst, v) => (SEVERITY[v] > SEVERITY[worst] ? v : worst),
      "ALLOW"
    );
    // A gate that could not run caps the overall at WARN: an incomplete
    // assessment is never reported as a clean pass.
    if (incomplete && verdict === "ALLOW") verdict = "WARN";
  }
  return { verdict, incomplete, incompleteReasons };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the applicable gates and build the merged, hash-stamped report.
 *
 * @param {object} inputs
 * @param {{address: string, chainId: (number|string)}|null} inputs.contract
 * @param {object|null} inputs.provenance - { claim, officialSource,
 *   independentSource, relayedFrom, officialDomains } (same semantics as
 *   check-provenance.mjs).
 * @param {object|null} inputs.signature - { typedDataFile, context,
 *   contextError } — context is the effective Gate 3 context object
 *   (context file + flag overrides already applied by the caller).
 * @param {object|null} inputs.brief - { file }.
 * @returns {Promise<object>} the full report, reportHash included.
 */
export async function runAegis(inputs) {
  const gates = {};
  const inputsSummary = {
    contract: null,
    provenance: null,
    typedData: null,
    signatureContext: null,
    brief: null,
  };

  // --- Gate 2 first (child process; start it before the async Gate 1) ------
  let gate2Promise = null;
  if (inputs.contract) {
    inputsSummary.contract = {
      address: inputs.contract.address,
      chainId: inputs.contract.chainId,
    };
    gate2Promise = runGate2(inputs.contract);
  } else {
    gates.gate2 = skipped(
      "gate2",
      "Not run: no contract address supplied (--contract)."
    );
  }

  // --- Gate 1 ---------------------------------------------------------------
  if (inputs.provenance) {
    const p = inputs.provenance;
    inputsSummary.provenance = {
      claim: p.claim,
      officialSource: p.officialSource ?? null,
      independentSource: p.independentSource ?? null,
      officialDomains: p.officialDomains ?? null,
      relayedFrom: p.relayedFrom ?? null,
    };
    gates.gate1 = await runGate1(p);
  } else {
    gates.gate1 = skipped("gate1", "Not run: no claim supplied (--claim).");
  }

  if (gate2Promise) gates.gate2 = await gate2Promise;

  // --- Gate 3 ---------------------------------------------------------------
  if (inputs.signature) {
    const s = inputs.signature;
    const fileContent = readInputFile(s.typedDataFile);
    inputsSummary.typedData = {
      file: s.typedDataFile,
      sha256: fileContent.error ? null : fileContent.sha256,
      bytes: fileContent.error ? null : fileContent.bytes.length,
    };
    inputsSummary.signatureContext = s.contextError
      ? { error: s.contextError }
      : (s.context ?? {});
    gates.gate3 = runGate3({
      typedDataFile: s.typedDataFile,
      fileContent,
      context: s.context,
      contextError: s.contextError ?? null,
    });
  } else {
    gates.gate3 = skipped(
      "gate3",
      "Not run: no typed-data file supplied (--typed-data)."
    );
  }

  // --- Gate 4 ---------------------------------------------------------------
  if (inputs.brief) {
    const fileContent = readInputFile(inputs.brief.file);
    inputsSummary.brief = {
      file: inputs.brief.file,
      sha256: fileContent.error ? null : fileContent.sha256,
      bytes: fileContent.error ? null : fileContent.bytes.length,
    };
    gates.gate4 = runGate4({ briefFile: inputs.brief.file, fileContent });
  } else {
    gates.gate4 = skipped(
      "gate4",
      "Not run: no brief/text file supplied (--brief)."
    );
  }

  const overall = mergeGates(gates);

  const report = {
    tool: "aegis",
    version: RUNNER_VERSION,
    generatedAt: new Date().toISOString(),
    kit: {
      gate1: GATE_TOOLS.gate1.version,
      gate2: GATE_TOOLS.gate2.version,
      gate3: GATE_TOOLS.gate3.version,
      gate4: GATE_TOOLS.gate4.version,
    },
    inputs: inputsSummary,
    gates,
    overall: {
      verdict: overall.verdict,
      incomplete: overall.incomplete,
      incompleteReasons: overall.incompleteReasons,
      rule:
        "Worst verdict among gates that produced one (BLOCK > WARN > " +
        "ALLOW); any applicable gate with NO_VERDICT caps the overall " +
        "at WARN and sets incomplete: true; SKIPPED gates do not " +
        "affect the merge.",
    },
    reportHash: null, // filled in below, over the canonical body
    disclaimer:
      "AEGIS screening report — per-gate signals merged, not an audit. " +
      "Each gate's own limitations apply (see AUDIT.md); the full " +
      "per-gate reports are available from the individual gate CLIs. " +
      "reportHash covers this report body (canonical form, volatile " +
      "fields excluded) so the verdict can be re-verified against its " +
      "NEAR anchor without trusting the machine that produced it.",
  };
  report.reportHash = computeReportHash(report);
  return report;
}

// ---------------------------------------------------------------------------
// Human-readable summary (stderr — stdout stays pure JSON)
// ---------------------------------------------------------------------------

function printSummary(report, pretty) {
  const lines = [];
  lines.push(`AEGIS overall verdict: ${report.overall.verdict}`);
  for (const key of ["gate1", "gate2", "gate3", "gate4"]) {
    const g = report.gates[key];
    const label = `Gate ${key.slice(-1)} (${GATE_TOOLS[key].label})`;
    const head =
      g.status === "VERDICT" ? g.verdict : g.status;
    lines.push(`  ${label}: ${head}`);
    const reasons = pretty ? g.reasons : g.reasons.slice(0, 1);
    for (const r of reasons) lines.push(`    - ${r}`);
  }
  if (report.overall.incomplete) {
    lines.push("  incomplete: true (a gate that was asked to run produced no verdict)");
  }
  lines.push(`  reportHash: ${report.reportHash}`);
  console.error(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Main (CLI)
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  "--contract", "--chain",
  "--claim", "--official", "--independent", "--registry", "--relayed",
  "--typed-data", "--context", "--expected-chain", "--project-domain", "--deny",
  "--brief",
]);

async function main() {
  const args = process.argv.slice(2);
  const opts = {};
  let pretty = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--pretty") {
      pretty = true;
    } else if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (v === undefined) fail(`Usage: ${a} requires a value`);
      opts[a] = v;
    } else {
      fail(
        `Unknown argument: ${a}\n` +
          "Usage: node aegis.mjs [--contract <address>] [--chain <chainId>] " +
          "[--claim <text>] [--official <url>] [--independent <url>] " +
          "[--registry host1,host2] [--relayed <channel>] " +
          "[--typed-data <file>] [--context <file>] [--expected-chain <id>] " +
          "[--project-domain <name>] [--deny <addr,...>] [--brief <file>] [--pretty]"
      );
    }
  }

  const hasGateInput =
    opts["--contract"] || opts["--claim"] || opts["--typed-data"] || opts["--brief"];
  if (!hasGateInput) {
    fail(
      "Usage: supply at least one gate input: --contract <address>, " +
        "--claim <text>, --typed-data <file>, or --brief <file>."
    );
  }

  // Gate 2 input (chainId kept exactly as Gate 2's CLI would receive it;
  // a non-integer chain makes the gate CLI exit 1 -> NO_VERDICT).
  const contract = opts["--contract"]
    ? {
        address: opts["--contract"],
        chainId: opts["--chain"] !== undefined ? opts["--chain"] : 56,
      }
    : null;

  // Gate 1 input (same flag semantics as check-provenance.mjs).
  const provenance = opts["--claim"]
    ? {
        claim: opts["--claim"],
        officialSource: opts["--official"] ?? null,
        independentSource: opts["--independent"] ?? null,
        relayedFrom: opts["--relayed"] ?? null,
        officialDomains: opts["--registry"]
          ? opts["--registry"].split(",").map((s) => s.trim()).filter(Boolean)
          : null,
      }
    : null;

  // Gate 3 input: resolve the effective context (context file, then flag
  // overrides — identical semantics to check-signature.mjs loadContext),
  // but a broken context is a Gate 3 NO_VERDICT, not a runner crash.
  let signature = null;
  if (opts["--typed-data"]) {
    let context = {};
    let contextError = null;
    if (opts["--context"]) {
      try {
        const parsed = JSON.parse(readFileSync(opts["--context"], "utf8"));
        if (!isPlainObject(parsed)) {
          contextError = `context file ${opts["--context"]} must contain a JSON object`;
        } else {
          context = parsed;
        }
      } catch (err) {
        contextError = `cannot read context JSON from ${opts["--context"]}: ${err.message}`;
      }
    }
    if (!contextError) {
      if (opts["--expected-chain"] !== undefined) {
        context.expectedChainId = Number(opts["--expected-chain"]);
      }
      if (opts["--project-domain"] !== undefined) {
        context.projectDomainName = opts["--project-domain"];
      }
      if (opts["--deny"] !== undefined) {
        const extra = opts["--deny"].split(",").map((s) => s.trim()).filter(Boolean);
        context.deniedContracts = [...(context.deniedContracts ?? []), ...extra];
      }
    }
    signature = { typedDataFile: opts["--typed-data"], context, contextError };
  }

  const brief = opts["--brief"] ? { file: opts["--brief"] } : null;

  const report = await runAegis({ contract, provenance, signature, brief });
  console.log(JSON.stringify(report, null, 2));
  printSummary(report, pretty);
  if (report.overall.verdict === "NO_VERDICT") {
    // The assessment failed as a whole: say so in the exit code too,
    // so no automation can mistake this report for a completed check.
    process.exit(1);
  }
}

// Run as CLI only when executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => fail(`Unexpected error: ${err.message}`));
}
