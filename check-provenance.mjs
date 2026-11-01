#!/usr/bin/env node
/**
 * AEGIS — Gate 1: provenance checker.
 *
 * Question: is this source official, or a third-party echo?
 *
 * A claim (an address, a link, a statement) is accepted only when it is
 * carried by the project's official channel AND re-confirmed against
 * independent infrastructure (an explorer, Sourcify) — never from a
 * relayed message, a forum post, a comment, or another agent's summary.
 * A relay explains how a claim ARRIVED; it is never evidence FOR it.
 *
 * What this implementation does (v1.0.0, built 1 Nov 2026):
 *   1. Fetches the claimed official source (read-only GET) and checks the
 *      claim actually appears in its content — a caller-supplied URL
 *      string alone proves nothing.
 *   2. If the caller supplies the project's official domains
 *      (--registry), the official source's host must match one of them; a
 *      lookalike domain is a BLOCK, before any fetch happens.
 *   3. Fetches the independent source and checks the claim there too. The
 *      independent source must live on a DIFFERENT host than the official
 *      one — a second page on the project's own domain is not independent.
 *   4. Verdict rules:
 *        BLOCK — no official source at all (relay-only / unattributed);
 *                the official channel does not carry the claim;
 *                the official host fails the registry check; or a
 *                record-style independent URL (the claim is the record's
 *                own identifier in its path, e.g. a Sourcify/explorer
 *                address record) does not contain the claim — the record
 *                contradicts it.
 *        WARN  — official channel confirms the claim, but there is no
 *                independent confirmation (none supplied, not actually
 *                independent, or the independent page did not confirm).
 *        ALLOW — official + independent both confirm the claim.
 *   Fetch failures follow the Gate 2 fail-honest rule: a transient error
 *   (network, HTTP 429/5xx after bounded retries) aborts with NO verdict
 *   rather than fabricating one. HTTP 404 is a definitive answer ("the
 *   record/page is not there") and is treated as content, like Gate 2.
 *
 * Known limits (see AUDIT.md): "claim found" is a content heuristic —
 * substring match, or, for record-style URLs, a fetched record that does
 * not declare itself absent. It is not a semantic proof that the page
 * endorses the claim in the role the caller asserts (e.g. "the mint
 * contract" vs "mentioned in a warning"). Attribution stays human work.
 *
 * Usage:
 *   node check-provenance.mjs <claim> [official-source-url] [independent-source-url]
 *                             [--registry host1,host2] [--relayed <channel>]
 *
 * No external dependencies — plain Node.js (>= 18).
 * Read-only: performs GET requests against the two supplied URLs only.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;

// Bounded retry, same fail-honest policy as Gate 2: transient failures are
// retried, definitive answers (200 / 404) are not, and an exhausted retry
// aborts with no verdict instead of inventing one.
const MAX_FETCH_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = [500]; // wait before attempt 2

// Hosts that count as independent infrastructure rather than "another web
// page". Classification is reported as evidence; the verdict only requires
// the independent source to be on a different host than the official one.
function classifyIndependentHost(host) {
  if (host.includes("sourcify")) return "sourcify";
  if (
    host.includes("bscscan") ||
    host.includes("etherscan") ||
    host.includes("blockscout") ||
    host.includes("nearblocks") ||
    host.includes("explorer")
  ) {
    return "explorer";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseHttpUrl(raw, label) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid ${label} URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Invalid ${label} URL (only http/https): ${raw}`);
  }
  return u;
}

// Fetch one URL read-only with bounded retries.
// Returns { status, body, attempts } for definitive answers (200 / 404).
// Throws on anything else — the caller turns that into "no verdict".
async function fetchPage(url) {
  let lastFailure = "unknown error";
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "aegis-check-provenance/1.0.0" },
      });
    } catch (err) {
      lastFailure = `network error (${err.message})`;
      if (attempt < MAX_FETCH_ATTEMPTS) await sleep(RETRY_BACKOFF_MS[attempt - 1]);
      continue;
    }
    if (res.status === 200) {
      return { status: 200, body: await res.text(), attempts: attempt };
    }
    if (res.status === 404) {
      // Definitive absence — the record/page is not there. Treated as
      // (empty) content, exactly like Gate 2 treats Sourcify's 404.
      return { status: 404, body: "", attempts: attempt };
    }
    if (res.status === 429 || res.status >= 500) {
      lastFailure = `HTTP ${res.status}`;
      if (attempt < MAX_FETCH_ATTEMPTS) await sleep(RETRY_BACKOFF_MS[attempt - 1]);
      continue;
    }
    throw new Error(
      `HTTP ${res.status} from ${url} — source could not be read, no verdict issued`
    );
  }
  throw new Error(
    `Failed to fetch ${url} after ${MAX_FETCH_ATTEMPTS} attempts ` +
      `(last: ${lastFailure}) — no verdict issued; retry later`
  );
}

// Does this fetched page carry the claim?
// Primary test: substring match (case-insensitive — EVM addresses are
// case-insensitive identifiers and pages render them in mixed case).
// Record-style URLs (the claim is the record's identifier in the URL path,
// e.g. a Sourcify API record or an explorer address page) get a second
// test: a fetched JSON record that does not declare itself absent
// ("match": null) confirms the record exists even when the body does not
// echo the claim string.
function claimFoundIn(status, body, claim, url) {
  if (status !== 200 || !body) return false;
  const c = claim.toLowerCase();
  if (body.toLowerCase().includes(c)) return true;
  if (url && url.toLowerCase().includes(c)) {
    try {
      const j = JSON.parse(body);
      if (j !== null && typeof j === "object" && !Array.isArray(j)) {
        if ("match" in j && j.match === null) return false; // declares itself absent
        return true;
      }
    } catch {
      // Not JSON — fall through to "not found".
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Gate 1 interface
// ---------------------------------------------------------------------------

/**
 * Check the provenance of one claim.
 *
 * @param {object} input
 * @param {string} input.claim - the address, link, or statement being checked.
 * @param {string|null} [input.officialSource] - URL of the project's
 *   official channel where the claim was found (null = not found there).
 * @param {string|null} [input.independentSource] - URL of an independent
 *   confirmation (explorer / Sourcify record, null = not confirmed).
 * @param {string|null} [input.relayedFrom] - where the claim was first
 *   seen if it arrived relayed (another agent, a forum post, a comment).
 *   Recorded as evidence of arrival, never as a source.
 * @param {string[]|null} [input.officialDomains] - the project's official
 *   hosts, when the caller has established them out of band. When given,
 *   the official source's host must be one of them.
 * @returns {Promise<object>} report with verdict.gate1 in
 *   { ALLOW, WARN, BLOCK } plus per-source evidence.
 * @throws on unreadable supplied sources (transient fetch failure, invalid
 *   URL) — the caller must treat that as "no verdict", never as a pass.
 */
export async function checkProvenance({
  claim,
  officialSource = null,
  independentSource = null,
  relayedFrom = null,
  officialDomains = null,
}) {
  if (!claim || typeof claim !== "string") {
    throw new Error("claim must be a non-empty string");
  }

  const failures = []; // -> BLOCK
  const warnings = []; // -> WARN
  const notes = []; // evidence that does not move the verdict

  const registry =
    Array.isArray(officialDomains) && officialDomains.length > 0
      ? officialDomains.map((d) => String(d).toLowerCase())
      : null;

  // --- Official source -------------------------------------------------------
  let official = null;
  if (officialSource) {
    const u = parseHttpUrl(officialSource, "official source");
    official = {
      url: officialSource,
      host: u.hostname.toLowerCase(),
      registrySupplied: registry !== null,
      registryMatch: registry ? registry.includes(u.hostname.toLowerCase()) : null,
      fetched: false,
      httpStatus: null,
      claimFound: false,
    };
  }

  if (!official) {
    failures.push(
      "No official source recorded for this claim. A claim that arrives " +
        "only via a relay (another agent, a forum post, a comment) is " +
        "unattributed — Gate 1 cannot pass it."
    );
  } else if (official.registryMatch === false) {
    failures.push(
      `Official source host "${official.host}" is not one of the project's ` +
        `official domains (${registry.join(", ")}) — possible lookalike / ` +
        "phishing domain. Refusing to treat it as the official channel."
    );
  } else {
    const res = await fetchPage(official.url);
    official.fetched = true;
    official.httpStatus = res.status;
    official.claimFound = claimFoundIn(res.status, res.body, claim, official.url);
    if (!official.claimFound) {
      failures.push(
        "The project's official channel does not carry this claim " +
          `(fetched ${official.url}, HTTP ${res.status}, claim not found) — ` +
          "the claim is not attributable to the project."
      );
    }
  }

  // --- Independent source ------------------------------------------------------
  // Fetched only when the official side was actually checked — without an
  // official attribution, an explorer record proves existence, not
  // provenance, and the verdict is already BLOCK.
  let independent = null;
  if (independentSource) {
    const u = parseHttpUrl(independentSource, "independent source");
    const host = u.hostname.toLowerCase();
    independent = {
      url: independentSource,
      host,
      kind: classifyIndependentHost(host),
      differentHost: official ? host !== official.host : true,
      fetched: false,
      httpStatus: null,
      claimFound: false,
    };

    if (official && official.registryMatch !== false) {
      const res = await fetchPage(independent.url);
      independent.fetched = true;
      independent.httpStatus = res.status;
      independent.claimFound = claimFoundIn(
        res.status,
        res.body,
        claim,
        independent.url
      );
      if (!independent.claimFound) {
        const recordStyle = independent.url.toLowerCase().includes(claim.toLowerCase());
        if (recordStyle) {
          failures.push(
            "The independent record does not contain this claim " +
              `(${independent.url}, HTTP ${res.status}) — the independent ` +
              "infrastructure contradicts the claim."
          );
        } else {
          warnings.push(
            "The independent source was fetched but did not confirm the " +
              "claim (claim not found in its content)."
          );
        }
      }
      if (!independent.differentHost) {
        warnings.push(
          "The \"independent\" source is on the same domain as the official " +
            "source — a second page from the same operator is not an " +
            "independent confirmation."
        );
      }
    }
  }

  if (official && official.claimFound && !independent) {
    warnings.push(
      "Claim is carried by the official channel but has no independent " +
        "confirmation (explorer / Sourcify) yet."
    );
  }
  if (official && official.claimFound && independent && !independent.differentHost) {
    // Already warned above about same-domain; make the consequence explicit.
    warnings.push(
      "Without a genuinely independent confirmation, Gate 1 caps this " +
        "claim at WARN."
    );
  }

  if (relayedFrom) {
    notes.push(
      `Claim arrived relayed via: ${relayedFrom} — recorded as arrival ` +
        "evidence only; the relay itself counted for nothing."
    );
  }
  if (official && registry === null) {
    notes.push(
      "No official-domain registry was supplied, so officialness rests on " +
        "the fetched channel actually carrying the claim; a lookalike " +
        "domain carrying the same claim would not be caught without one."
    );
  }

  let gate1 = "ALLOW";
  if (failures.length > 0) gate1 = "BLOCK";
  else if (warnings.length > 0) gate1 = "WARN";

  const reasons = [...failures, ...warnings];
  if (gate1 === "ALLOW") {
    reasons.push(
      "Claim is carried by the project's official channel and confirmed " +
        "by an independent source on a different host."
    );
  }
  reasons.push(...notes);

  return {
    tool: "aegis-check-provenance",
    version: "1.0.0",
    checkedAt: new Date().toISOString(),
    claim,
    sources: {
      official,
      independent,
      relayedFrom: relayedFrom ?? null,
    },
    verdict: { gate1, reasons },
    disclaimer:
      "Gate 1 screening signal only. \"Claim found\" is a content " +
      "heuristic (substring / record-existence), not proof that the page " +
      "endorses the claim in the role asserted; a human/agent must still " +
      "attribute the claim before acting on it.",
  };
}

// ---------------------------------------------------------------------------
// Main (CLI)
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const positional = [];
  let registry = null;
  let relayedFrom = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--registry") {
      const v = args[++i];
      if (!v) fail("Usage: --registry requires a comma-separated host list");
      registry = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (args[i] === "--relayed") {
      const v = args[++i];
      if (!v) fail("Usage: --relayed requires a channel description");
      relayedFrom = v;
    } else {
      positional.push(args[i]);
    }
  }
  const [claim, officialSource, independentSource] = positional;
  if (!claim) {
    fail(
      "Usage: node check-provenance.mjs <claim> [official-source-url] " +
        "[independent-source-url] [--registry host1,host2] [--relayed <channel>]"
    );
  }
  const report = await checkProvenance({
    claim,
    officialSource: officialSource ?? null,
    independentSource: independentSource ?? null,
    relayedFrom,
    officialDomains: registry,
  });
  console.log(JSON.stringify(report, null, 2));
}

// Run as CLI only when executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => fail(err.message));
}
