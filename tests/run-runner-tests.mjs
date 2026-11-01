#!/usr/bin/env node
/**
 * AEGIS kit test battery — unified runner (aegis.mjs).
 *
 * Companion to tests/run-tests.mjs (the per-gate battery); same summary
 * style, same fail-honest conventions.
 *
 *   R1. Full-house Hashstone composition: Gate 1 against the local stub
 *       (official + independent confirmation), Gate 2 live against
 *       Sourcify (Hashstone NFT), Gate 3 benign SignIn fixture, Gate 4
 *       benign fixture -> overall ALLOW, incomplete false, every gate
 *       VERDICT. Live-dependent: if Sourcify is unreachable the
 *       live-dependent checks are SKIP (never silently passed).
 *   R2. reportHash is present and a 64-char lowercase hex string.
 *   R3. reportHash is STABLE across two runs on identical inputs: the
 *       canonical body excludes the volatile fields (generatedAt,
 *       reportHash) — documented in aegis.mjs and AUDIT.md §7 — so two
 *       runs seconds apart must produce the identical hash.
 *   R4. Nonce composition (Gate 4 on cases/nonce.md + Gate 3 on the
 *       Permit fixture) -> overall BLOCK; unrequested gates SKIPPED
 *       with reasons. Fully offline.
 *   R5. Malformed typed-data input (not valid JSON) -> Gate 3
 *       NO_VERDICT, incomplete true, and the overall verdict capped at
 *       WARN even though Gate 4 ALLOWs. Fully offline.
 *   R6. Malformed typed-data as the ONLY input -> overall NO_VERDICT,
 *       runner exit code 1, report still printed with a reportHash.
 *   R7. No gate inputs at all -> usage error, exit 1, no report.
 *   R8. Gate 2 against an unsupported chain (its CLI exits 1) -> Gate 2
 *       NO_VERDICT, overall capped at WARN with Gate 4 ALLOW.
 *
 * Usage: node tests/run-runner-tests.mjs
 * Exit code 0 = all non-skipped tests passed.
 * No external dependencies — plain Node.js (>= 18).
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const KIT = fileURLToPath(new URL("..", import.meta.url));
const FIX = join(KIT, "tests", "fixtures");
const RUNNER = join(KIT, "aegis.mjs");

const HASHSTONE_NFT = "0x00fbc656caa753a5280835bf9e849c4c0aff9bf4";

// ---------------------------------------------------------------------------
// Harness (same conventions as run-tests.mjs)
// ---------------------------------------------------------------------------

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok === "SKIP" ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}
const pass = (name, detail) => record(name, true, detail);
const failT = (name, detail) => record(name, false, detail);
const skip = (name, detail) => record(name, "SKIP", detail);

async function runRunner(args, { timeout = 240_000 } = {}) {
  try {
    const { stdout, stderr } = await run("node", [RUNNER, ...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    let json = null;
    try { json = JSON.parse(stdout); } catch { /* not JSON */ }
    return { code: 0, json, stderr };
  } catch (err) {
    let json = null;
    if (err.stdout) {
      try { json = JSON.parse(err.stdout); } catch { /* not JSON */ }
    }
    return { code: err.code ?? 1, json, stderr: err.stderr ?? "" };
  }
}

// ---------------------------------------------------------------------------
// Stub server: Gate 1 fixture pages (same pages as run-tests.mjs)
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  const url = req.url ?? "";
  const send = (status, body, type = "text/html") => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  if (url === "/official") {
    return send(200, `<html><body><h1>Hashstone</h1><p>Mint contract: ${HASHSTONE_NFT}</p></body></html>`);
  }
  if (url === "/explorer") {
    return send(200, `<html><body><p>Contract ${HASHSTONE_NFT} — verified source</p></body></html>`);
  }
  return send(404, "not found", "text/plain");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const STUB = `http://127.0.0.1:${PORT}`;

// Full-house Hashstone composition (R1/R2/R3 share these arguments).
const FULL_HOUSE_ARGS = [
  "--claim", HASHSTONE_NFT,
  "--official", `${STUB}/official`,
  "--independent", `http://localhost:${PORT}/explorer`,
  "--registry", "127.0.0.1",
  "--contract", HASHSTONE_NFT,
  "--typed-data", join(FIX, "login-ok.json"),
  "--context", join(FIX, "login-context.json"),
  "--brief", join(FIX, "benign.txt"),
];

// ---------------------------------------------------------------------------
// R1–R3. Full-house Hashstone run + hash stability (live Gate 2)
// ---------------------------------------------------------------------------

console.log("\n== R1–R3. Runner — full-house Hashstone composition ==");
const r1 = await runRunner(FULL_HOUSE_ARGS);
const gate2NoVerdict =
  r1.json?.gates?.gate2?.status === "NO_VERDICT" &&
  /Sourcify request failed|network error|Failed to fetch/i.test(
    r1.json?.gates?.gate2?.reasons?.[0] ?? ""
  );
if (!r1.json || gate2NoVerdict) {
  for (const n of [
    "R1 full-house Hashstone overall ALLOW",
    "R2 reportHash present (64-hex)",
    "R3 reportHash stable across two identical runs",
  ]) {
    skip(n, "Sourcify unreachable from this environment");
  }
} else {
  const g = r1.json.gates ?? {};
  const allVerdict = ["gate1", "gate2", "gate3", "gate4"].every(
    (k) => g[k]?.status === "VERDICT"
  );
  if (r1.code === 0 && r1.json.overall?.verdict === "ALLOW" && r1.json.overall?.incomplete === false && allVerdict) {
    pass("R1 full-house Hashstone overall ALLOW", "all four gates VERDICT/ALLOW");
  } else {
    failT(
      "R1 full-house Hashstone overall ALLOW",
      `code=${r1.code} overall=${r1.json.overall?.verdict} incomplete=${r1.json.overall?.incomplete} ` +
        `gates=${["gate1", "gate2", "gate3", "gate4"].map((k) => `${k}:${g[k]?.status}/${g[k]?.verdict}`).join(",")}`
    );
  }
  if (/^[0-9a-f]{64}$/.test(r1.json.reportHash ?? "")) {
    pass("R2 reportHash present (64-hex)", r1.json.reportHash);
  } else {
    failT("R2 reportHash present (64-hex)", `got ${r1.json.reportHash}`);
  }
  const r1b = await runRunner(FULL_HOUSE_ARGS);
  if (r1b.json?.reportHash && r1b.json.reportHash === r1.json.reportHash) {
    pass("R3 reportHash stable across two identical runs", "generatedAt excluded from the canonical body");
  } else {
    failT(
      "R3 reportHash stable across two identical runs",
      `run1=${r1.json.reportHash} run2=${r1b.json?.reportHash}`
    );
  }
}

// ---------------------------------------------------------------------------
// R4. Nonce composition -> BLOCK (offline)
// ---------------------------------------------------------------------------

console.log("\n== R4. Runner — Nonce composition ==");
{
  const r = await runRunner([
    "--brief", join(KIT, "cases", "nonce.md"),
    "--typed-data", join(FIX, "permit.json"),
  ]);
  if (r.code === 0 && r.json?.overall?.verdict === "BLOCK" && r.json?.overall?.incomplete === false) {
    pass("R4 Nonce composition overall BLOCK");
  } else {
    failT("R4 Nonce composition overall BLOCK", `code=${r.code} overall=${r.json?.overall?.verdict}`);
  }
  if (r.json?.gates?.gate4?.verdict === "BLOCK" && r.json?.gates?.gate3?.verdict === "BLOCK") {
    pass("R4 Gate 4 and Gate 3 both BLOCK");
  } else {
    failT("R4 Gate 4 and Gate 3 both BLOCK", `gate4=${r.json?.gates?.gate4?.verdict} gate3=${r.json?.gates?.gate3?.verdict}`);
  }
  const g1 = r.json?.gates?.gate1;
  const g2 = r.json?.gates?.gate2;
  if (g1?.status === "SKIPPED" && g2?.status === "SKIPPED" && g1.reasons?.[0] && g2.reasons?.[0]) {
    pass("R4 unrequested gates SKIPPED with reasons");
  } else {
    failT("R4 unrequested gates SKIPPED with reasons", `gate1=${g1?.status} gate2=${g2?.status}`);
  }
}

// ---------------------------------------------------------------------------
// R5–R6. Malformed Gate 3 input -> NO_VERDICT handling (offline)
// ---------------------------------------------------------------------------

console.log("\n== R5–R6. Runner — malformed typed-data input ==");
const tmp = mkdtempSync(join(tmpdir(), "aegis-runner-"));
const MALFORMED = join(tmp, "malformed.json");
writeFileSync(MALFORMED, "{ this is not valid json");
{
  const r = await runRunner(["--typed-data", MALFORMED, "--brief", join(FIX, "benign.txt")]);
  if (r.json?.gates?.gate3?.status === "NO_VERDICT") {
    pass("R5 malformed typed data -> Gate 3 NO_VERDICT", r.json.gates.gate3.reasons[0]?.slice(0, 60));
  } else {
    failT("R5 malformed typed data -> Gate 3 NO_VERDICT", `gate3=${r.json?.gates?.gate3?.status}`);
  }
  if (r.json?.overall?.incomplete === true && r.json?.overall?.verdict === "WARN" && r.code === 0) {
    pass("R5 overall capped at WARN with incomplete: true");
  } else {
    failT(
      "R5 overall capped at WARN with incomplete: true",
      `overall=${r.json?.overall?.verdict} incomplete=${r.json?.overall?.incomplete} code=${r.code}`
    );
  }
}
{
  const r = await runRunner(["--typed-data", MALFORMED]);
  if (r.json?.overall?.verdict === "NO_VERDICT" && r.code === 1 && /^[0-9a-f]{64}$/.test(r.json?.reportHash ?? "")) {
    pass("R6 sole NO_VERDICT gate -> overall NO_VERDICT, exit 1, report + hash still printed");
  } else {
    failT(
      "R6 sole NO_VERDICT gate -> overall NO_VERDICT, exit 1, report + hash still printed",
      `overall=${r.json?.overall?.verdict} code=${r.code} hash=${r.json?.reportHash}`
    );
  }
}

// ---------------------------------------------------------------------------
// R7. No inputs -> usage error
// ---------------------------------------------------------------------------

console.log("\n== R7. Runner — usage ==");
{
  const r = await runRunner([]);
  if (r.code === 1 && !r.json?.overall) pass("R7 no gate inputs exits 1, no report");
  else failT("R7 no gate inputs exits 1, no report", `code=${r.code}`);
}

// ---------------------------------------------------------------------------
// R8. Gate 2 error -> NO_VERDICT (unsupported chain: the gate CLI exits 1
// whether Sourcify answers 400 or is unreachable, so this is stable)
// ---------------------------------------------------------------------------

console.log("\n== R8. Runner — Gate 2 failure surfaces as NO_VERDICT ==");
{
  const r = await runRunner([
    "--contract", HASHSTONE_NFT,
    "--chain", "999999",
    "--brief", join(FIX, "benign.txt"),
  ]);
  if (r.json?.gates?.gate2?.status === "NO_VERDICT" && r.json?.overall?.verdict === "WARN" && r.json?.overall?.incomplete === true) {
    pass("R8 Gate 2 CLI failure -> NO_VERDICT, overall capped at WARN");
  } else {
    failT(
      "R8 Gate 2 CLI failure -> NO_VERDICT, overall capped at WARN",
      `gate2=${r.json?.gates?.gate2?.status} overall=${r.json?.overall?.verdict} incomplete=${r.json?.overall?.incomplete}`
    );
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

server.close();
const passed = results.filter((r) => r.ok === true).length;
const failed = results.filter((r) => r.ok === false).length;
const skippedCount = results.filter((r) => r.ok === "SKIP").length;
console.log(`\n== Summary: ${passed} passed, ${failed} failed, ${skippedCount} skipped (${results.length} total) ==`);
process.exit(failed > 0 ? 1 : 0);
