#!/usr/bin/env node
/**
 * AEGIS — Gate 1 prototype (SCAFFOLD): provenance checker.
 *
 * Question: is this source official, or a third-party echo?
 *
 * A claim (an address, a link, a statement) is accepted only when it comes
 * from the project's official channels AND is re-confirmed against
 * independent infrastructure (an explorer, Sourcify) — never from a relayed
 * message, a comment, or another agent's summary.
 *
 * STATUS: scaffold, prepared 31 Oct 2026 for the in-window build
 * (1–7 Nov 2026). This file is NOT a full implementation and its output is
 * NOT a verdict to act on. The structured TODOs below are the build list.
 *
 * Usage (scaffold):
 *   node check-provenance.mjs <claim> <official-source-url> [independent-source-url]
 *
 * No external dependencies — plain Node.js (>= 18).
 * Read-only: this scaffold performs no network requests yet.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// TODO(build): canonical list of "official channel" kinds per project
// (domain, verified social handle, official docs repo) — a URL string alone
// proves nothing; the caller must record WHERE the officialness was checked.
const OFFICIAL_CHANNEL_KINDS = ["official-domain", "official-docs", "official-social"];

// TODO(build): independent confirmers to query live (Sourcify, BscScan,
// NEAR explorer). Until then, an independent source is only a recorded URL.
const INDEPENDENT_CONFIRMERS = ["sourcify", "explorer"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Gate 1 interface
// ---------------------------------------------------------------------------

/**
 * Check the provenance of one claim.
 *
 * @param {object} input
 * @param {string} input.claim - the address, link, or statement being checked.
 * @param {string|null} input.officialSource - URL of the project's official
 *   channel where the claim was found (null = not found there).
 * @param {string|null} input.independentSource - URL of an independent
 *   confirmation (explorer / Sourcify record, null = not confirmed).
 * @param {string|null} input.relayedFrom - where the claim was first seen
 *   if it arrived relayed (another agent, a forum post, a comment).
 * @returns {object} scaffold report: { gate1, sources, todos }.
 *   gate1 is "SCAFFOLD" until the build implements live checks — never
 *   ALLOW / WARN / BLOCK on its own.
 */
export function checkProvenance({ claim, officialSource, independentSource, relayedFrom }) {
  const sources = {
    claim,
    officialSource: officialSource ?? null,
    independentSource: independentSource ?? null,
    relayedFrom: relayedFrom ?? null,
  };

  // Preliminary, purely structural observations — NOT a verdict:
  // a claim seen only via a relay, with no official source, is exactly the
  // shape Gate 1 exists to reject. The build turns this into a verdict
  // only once officialness is verified live, not asserted by the caller.
  const observations = [];
  if (!officialSource) {
    observations.push("No official source recorded for this claim.");
  }
  if (!independentSource) {
    observations.push("No independent confirmation recorded for this claim.");
  }
  if (relayedFrom) {
    observations.push(`Claim arrived relayed via: ${relayedFrom} — relay is never proof.`);
  }

  return {
    tool: "aegis-check-provenance",
    version: "0.1.0-scaffold",
    gate1: "SCAFFOLD",
    sources,
    observations,
    todos: [
      "TODO(build): verify officialness live — match the source domain/handle against a per-project official-channel registry, do not trust a caller-supplied URL string.",
      "TODO(build): query Sourcify/explorer live and compare the claimed address against the record (independent confirmation, not a second copy of the same claim).",
      "TODO(build): classify the relay channel (agent summary, forum post, comment) and record it as evidence, never as a source.",
      "TODO(build): define the Gate 1 verdict rules (official + independent = pass; official-only = WARN; relay-only = BLOCK) and align them with the Gate 2/3/4 verdict vocabulary.",
      "TODO(build): add tests — official+independent claim, relay-only claim, official claim contradicted by the explorer.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Main (CLI scaffold)
// ---------------------------------------------------------------------------

function main() {
  const [, , claim, officialSource, independentSource] = process.argv;
  if (!claim) {
    fail("Usage: node check-provenance.mjs <claim> [official-source-url] [independent-source-url]");
  }
  const report = checkProvenance({
    claim,
    officialSource: officialSource ?? null,
    independentSource: independentSource ?? null,
    relayedFrom: null,
  });
  console.log(JSON.stringify(report, null, 2));
}

// Run as CLI only when executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
