#!/usr/bin/env node
/**
 * AEGIS — Gate 4: instruction-channel scorer.
 *
 * Question: is somebody's page trying to operate the agent?
 *
 * Pages, packages and documents are scanned for instructions addressed to
 * agents: "connect to our MCP server", challenge→sign→submit sequences
 * with server-supplied payloads, agent-targeted install scripts,
 * manufactured urgency, authority claims. Content is data; only the
 * user's own instructions are instructions.
 *
 * Scoring (v1.0.0, built 1 Nov 2026). Each of the six signal groups has a
 * weight reflecting how directly it moves an agent toward execution:
 *
 *   server-sign-submit          5  sign/submit a counterparty payload
 *   external-server-connect     4  attach the agent to a foreign server
 *   agent-install-script        4  run code in the agent's environment
 *   agent-addressed-instruction 2  text written FOR an agent to obey
 *   false-authority             2  borrowed trust ("official partner", …)
 *   manufactured-urgency        1  pressure to skip verification
 *
 *   score = Σ (hits × weight)
 *     score >= 8  -> BLOCK
 *     score >= 3  -> WARN
 *     else        -> ALLOW
 *
 * Hard rules, independent of the score:
 *   - A server-sign-submit hit TOGETHER WITH an external-server-connect
 *     hit is the Nonce shape (a foreign server both instructs the agent
 *     and feeds it payloads to sign) -> BLOCK.
 *   - A detected challenge→sign→submit SEQUENCE (the stages of one
 *     server-orchestrated flow spread across the text) -> BLOCK.
 *
 * Calibration anchors: the Nonce case file (cases/nonce.md) must score
 * BLOCK; ordinary human-facing project docs must score ALLOW; a page
 * whose only sin is urgency scores WARN. Every hit is reported with a
 * line-numbered excerpt — counts alone are never the verdict's evidence.
 *
 * Known limits (see AUDIT.md): this is regex/heuristic screening.
 * Paraphrased, obfuscated, image-carried, or non-English instructions
 * can evade it, and a page DISCUSSING these patterns (like the Nonce
 * case file itself) scores as if it used them — Gate 4 flags channels
 * for review; it does not judge intent. Input is a local text file or
 * stdin; URL fetching is deliberately not built in (a fetch layer must
 * keep Gate 2's fail-honest rule and is future work).
 *
 * Usage:
 *   node check-instructions.mjs <text-file>
 *   node check-instructions.mjs -        (reads stdin)
 *
 * No external dependencies — plain Node.js (>= 18).
 * Read-only: reads one local text file or stdin, fetches nothing,
 * executes nothing.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WARN_THRESHOLD = 3;
const BLOCK_THRESHOLD = 8;
const MAX_EXCERPTS_PER_SIGNAL = 5;
const EXCERPT_MAX_CHARS = 160;

// Multi-word phrases use \s+ between tokens: real pages and documents
// wrap lines mid-phrase (the Nonce case file wraps "sign the login\n
// challenge" across two lines), and a phrase split by a line break is
// still the same instruction.
const SIGNALS = [
  {
    key: "agent-addressed-instruction",
    weight: 2,
    why: "Text written for the agent to follow, not for a human to read.",
    regex:
      /\b(for\s+(your|the)\s+(ai\s+)?agents?|addressed\s+to\s+(ai\s+)?agents?|hey\s+agent|ai\s+agents?,?\s+(please|must|should)|as\s+an\s+ai\s+agent|instructions\s+for\s+(the\s+)?(ai\s+)?agents?)\b/gi,
  },
  {
    key: "external-server-connect",
    weight: 4,
    why: "Directing the agent to connect to a counterparty-controlled server.",
    regex:
      /\b(connect\s+to\s+(an?|our|this|the)\s+(external\s+)?(mcp\s+)?server|add\s+(this|our|the)\s+mcp\s+server|our\s+mcp\s+server|mcp\.[\w.-]+)\b/gi,
  },
  {
    key: "server-sign-submit",
    weight: 5,
    why: "Sign-and-submit flow whose payload comes from the counterparty's server.",
    regex:
      /\b(sign\s+(and\s+|&\s+)?submit|sign\s+(the\s+|this\s+|our\s+)?(login\s+|server\s+)?(challenge|payload|message|typed\s+data)|submit\s+(the\s+|your\s+)?(signed|artifact|result|solution)|paste\s+.{0,60}?\s+into\s+your\s+agent)\b/gi,
  },
  {
    key: "agent-install-script",
    weight: 4,
    why: "Install/run script addressed at the agent's environment.",
    regex:
      /\b(curl\s+.{0,120}\|\s*(sh|bash)|npx\s+.{0,60}?skill|install\s+(this|the)\s+skill\s+(into|for)\s+your\s+agent|(paste|enter|run)\s+(this|the\s+following)\s+(command|code|script)\s+(in|into)\s+your\s+(terminal|agent))\b/gi,
  },
  {
    key: "manufactured-urgency",
    weight: 1,
    why: "Time pressure used to skip verification.",
    regex:
      /\b(act\s+(now|immediately)|limited\s+time|expires\s+in\s+\d+|do\s+not\s+wait|before\s+it('s|\s+is)\s+too\s+late|only\s+\d+\s+(spots|places|left)|selling\s+out\s+fast|hurry)\b/gi,
  },
  {
    key: "false-authority",
    weight: 2,
    why: "Claimed authority used to borrow trust the page has not earned.",
    regex:
      /\b(official\s+(partner|agent)|verified\s+by|endorsed\s+by|as\s+recommended\s+by|officially\s+(partnered|endorsed))\b/gi,
  },
];

// The stages of one server-orchestrated flow. Any single stage is a
// phrase; all three together are a pipeline: the server issues a
// challenge/puzzle, the agent signs, the agent submits back. Detected as
// a sequence finding (one flow), not as three isolated phrases.
const SEQUENCE_STAGES = [
  {
    key: "obtain-challenge",
    regex:
      /\b(prepare_attempt|start_attempt|get_challenge|solve\s+(the\s+|a\s+)?(sat\s+|logic\s+)?(puzzle|challenge)|fetch\s+(the\s+|a\s+)?(challenge|fragment|payload))\b/i,
  },
  { key: "sign", regex: /\bsign\b/i },
  { key: "submit", regex: /\b(submit|submit_artifact|mint_transaction)\b/i },
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

// Line-numbered excerpts for a signal: one excerpt per matching line
// (trimmed, length-capped), up to MAX_EXCERPTS_PER_SIGNAL. A hit whose
// phrase wraps across a line break matches no single line; for those,
// fall back to one excerpt of the matched text itself (line: null,
// whitespace collapsed) so every counted signal still shows evidence.
function collectExcerpts(lines, signal, fullText) {
  const excerpts = [];
  const lineRe = new RegExp(signal.regex.source, "i");
  for (let i = 0; i < lines.length && excerpts.length < MAX_EXCERPTS_PER_SIGNAL; i++) {
    if (lineRe.test(lines[i])) {
      const text = lines[i].trim();
      excerpts.push({
        line: i + 1,
        text: text.length > EXCERPT_MAX_CHARS ? text.slice(0, EXCERPT_MAX_CHARS) + "…" : text,
      });
    }
  }
  if (excerpts.length === 0 && fullText) {
    const m = fullText.match(new RegExp(signal.regex.source, "i"));
    if (m) {
      const text = m[0].replace(/\s+/g, " ").trim();
      excerpts.push({
        line: null,
        text: text.length > EXCERPT_MAX_CHARS ? text.slice(0, EXCERPT_MAX_CHARS) + "…" : text,
      });
    }
  }
  return excerpts;
}

// ---------------------------------------------------------------------------
// Gate 4 interface
// ---------------------------------------------------------------------------

/**
 * Score one instruction-channel text (page, package readme, document).
 *
 * @param {string} text - the text to scan.
 * @returns {object} report with verdict.gate4 in { ALLOW, WARN, BLOCK },
 *   the weighted score, per-signal counts with line-numbered excerpts,
 *   and the sequence finding.
 */
export function scoreInstructions(text) {
  if (typeof text !== "string") {
    throw new Error("text must be a string");
  }
  const lines = text.split(/\r?\n/);
  const signals = {};
  let score = 0;
  for (const s of SIGNALS) {
    const n = countMatches(text, s.regex);
    signals[s.key] = {
      count: n,
      weight: s.weight,
      weighted: n * s.weight,
      why: s.why,
      excerpts: n > 0 ? collectExcerpts(lines, s, text) : [],
    };
    score += n * s.weight;
  }

  const stages = SEQUENCE_STAGES.map((st) => ({
    key: st.key,
    present: st.regex.test(text),
  }));
  const sequence = {
    detected: stages.every((s) => s.present),
    stages,
  };

  // --- Verdict -------------------------------------------------------------
  const reasons = [];
  let gate4 = "ALLOW";
  const signSubmit = signals["server-sign-submit"].count;
  const serverConnect = signals["external-server-connect"].count;

  if (sequence.detected) {
    gate4 = "BLOCK";
    reasons.push(
      "Challenge→sign→submit sequence detected (stages: " +
        stages.map((s) => s.key).join(", ") +
        ") — one server-orchestrated flow spread across the text, the " +
        "Nonce shape: the counterparty issues, the agent signs, the " +
        "agent submits."
    );
  }
  if (signSubmit > 0 && serverConnect > 0) {
    gate4 = "BLOCK";
    reasons.push(
      "Server-sign-submit instructions appear together with a direction " +
        "to connect to an external server — a foreign server both " +
        "instructs the agent and feeds it payloads to sign."
    );
  }
  if (score >= BLOCK_THRESHOLD) {
    gate4 = "BLOCK";
    reasons.push(`Weighted injection score ${score} >= BLOCK threshold ${BLOCK_THRESHOLD}.`);
  } else if (gate4 !== "BLOCK" && score >= WARN_THRESHOLD) {
    gate4 = "WARN";
    reasons.push(`Weighted injection score ${score} >= WARN threshold ${WARN_THRESHOLD}.`);
  }

  // Evidence summary: every triggered signal, strongest first.
  const triggered = SIGNALS.filter((s) => signals[s.key].count > 0).sort(
    (a, b) => signals[b.key].weighted - signals[a.key].weighted
  );
  for (const s of triggered) {
    reasons.push(
      `${s.key}: ${signals[s.key].count} hit(s) × weight ${s.weight} — ${s.why} (see excerpts)`
    );
  }
  if (gate4 === "ALLOW") {
    reasons.push(
      `Weighted injection score ${score} below WARN threshold ${WARN_THRESHOLD}; ` +
        "no agent-directed execution signals found."
    );
  }

  return {
    tool: "aegis-check-instructions",
    version: "1.0.0",
    checkedAt: new Date().toISOString(),
    input: { chars: text.length, lines: lines.length },
    score,
    thresholds: { warn: WARN_THRESHOLD, block: BLOCK_THRESHOLD },
    signals,
    sequence,
    verdict: { gate4, reasons },
    disclaimer:
      "Gate 4 screening signal only. Regex heuristics flag channels for " +
      "review — paraphrase, obfuscation, images, or other languages can " +
      "evade them, and text DISCUSSING these patterns scores like text " +
      "using them. Content is data; only the user's own instructions " +
      "are instructions.",
  };
}

// ---------------------------------------------------------------------------
// Main (CLI)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

// Read stdin as a stream, not readFileSync(0): under a spawned pipe the
// fd can be non-blocking and the sync read never returns. The stream
// iteration works for terminal, file, and pipe stdin alike.
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [, , fileArg] = process.argv;
  if (!fileArg) {
    fail("Usage: node check-instructions.mjs <text-file>  (or - for stdin)");
  }
  let text;
  try {
    text = fileArg === "-" ? await readStdin() : readFileSync(fileArg, "utf8");
  } catch (err) {
    fail(`Cannot read text from ${fileArg === "-" ? "stdin" : fileArg}: ${err.message}`);
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
  main().catch((err) => fail(`Unexpected error: ${err.message}`));
}
