#!/usr/bin/env node
/**
 * AEGIS — Gate 4 prototype (SCAFFOLD): instruction-channel scorer.
 *
 * Question: is somebody's page trying to operate the agent?
 *
 * Pages, packages and documents are scanned for instructions addressed to
 * agents: "connect to our MCP server", challenge→sign→submit sequences with
 * server-supplied payloads, agent-targeted install scripts, manufactured
 * urgency, authority claims. Content is data; only the user's own
 * instructions are instructions.
 *
 * STATUS: scaffold, prepared 31 Oct 2026 for the in-window build
 * (1–7 Nov 2026). The pattern counts below are preliminary evidence only:
 * scoring weights, thresholds, and the verdict rules are NOT calibrated,
 * so this file's output is NOT a verdict to act on. The Nonce case (a page
 * embedding a playbook for agents) is the reference BLOCK shape the build
 * must reproduce.
 *
 * Usage (scaffold):
 *   node check-instructions.mjs <text-file>
 *
 * No external dependencies — plain Node.js (>= 18).
 * Read-only: reads one local text file, fetches nothing, executes nothing.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Preliminary signal patterns, grouped by why AEGIS cares. Counts are
// evidence, not verdicts — the build must calibrate weights and thresholds
// against labelled pages (Nonce = BLOCK shape, ordinary docs = clean).
const SIGNALS = [
  {
    key: "agent-addressed-instruction",
    why: "Text written for the agent to follow, not for a human to read.",
    regex: /\b(for (your|the) (ai )?agent|hey agent|ai agent,? (please )?|as an ai agent)\b/gi,
  },
  {
    key: "external-server-connect",
    why: "Directing the agent to connect to a counterparty-controlled server.",
    regex: /\b(connect to (our|this|the) (mcp )?server|add (this|our) mcp server|mcp\.[\w.-]+)\b/gi,
  },
  {
    key: "server-sign-submit",
    why: "Sign-and-submit flow whose payload comes from the counterparty's server.",
    regex: /\b(sign (and )?submit|sign the (challenge|payload|message) (from|provided by|sent by)|paste .* into your agent)\b/gi,
  },
  {
    key: "agent-install-script",
    why: "Install/run script addressed at the agent's environment.",
    regex: /\b(curl .*\| *(sh|bash)|npx .*skill|install (this|the) skill (into|for) your agent)\b/gi,
  },
  {
    key: "manufactured-urgency",
    why: "Time pressure used to skip verification.",
    regex: /\b(act (now|immediately)|limited time|expires in \d+|do not wait|before it('s| is) too late)\b/gi,
  },
  {
    key: "false-authority",
    why: "Claimed authority used to borrow trust the page has not earned.",
    regex: /\b(official (partner|agent)|verified by|endorsed by|as recommended by)\b/gi,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

function countMatches(text, regex) {
  const m = text.match(regex);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// Gate 4 interface
// ---------------------------------------------------------------------------

/**
 * Score one instruction-channel text (page, package readme, document).
 *
 * @param {string} text - the text to scan.
 * @returns {object} scaffold report: { gate4, signals, preliminaryScore,
 *   todos }.
 *   gate4 is "SCAFFOLD" until the build calibrates weights/thresholds —
 *   never ALLOW / WARN / BLOCK on its own. preliminaryScore is the raw
 *   total signal count, shown only so the build has a number to calibrate
 *   against; it is not a verdict threshold.
 */
export function scoreInstructions(text) {
  if (typeof text !== "string") {
    throw new Error("text must be a string");
  }
  const signals = {};
  let preliminaryScore = 0;
  for (const s of SIGNALS) {
    const n = countMatches(text, s.regex);
    signals[s.key] = { count: n, why: s.why };
    preliminaryScore += n;
  }
  return {
    tool: "aegis-check-instructions",
    version: "0.1.0-scaffold",
    gate4: "SCAFFOLD",
    preliminaryScore,
    signals,
    todos: [
      "TODO(build): calibrate weights per signal (a server-sign-submit hit weighs more than a lone urgency phrase) and set WARN/BLOCK thresholds against labelled pages.",
      "TODO(build): reproduce the Nonce reference case — the page embedding an agent playbook must score BLOCK, ordinary project docs must score clean.",
      "TODO(build): add URL/package fetch (read-only) so the CLI can take a page URL or a package path, not only a local text file — with the same fail-honest rule as Gate 2 (fetch failure = no verdict, never a clean score).",
      "TODO(build): sequence detection — a challenge→sign→submit chain spread across paragraphs counts as one flow, not three isolated phrases.",
      "TODO(build): add tests — Nonce-style playbook page, clean docs page, urgency-only page, install-script page.",
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
    fail("Usage: node check-instructions.mjs <text-file>");
  }
  let text;
  try {
    text = readFileSync(fileArg, "utf8");
  } catch (err) {
    fail(`Cannot read text from ${fileArg}: ${err.message}`);
  }
  let report;
  try {
    report = scoreInstructions(text);
  } catch (err) {
    fail(err.message);
  }
  console.log(JSON.stringify(report, null, 2));
}

// Run as CLI only when executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
