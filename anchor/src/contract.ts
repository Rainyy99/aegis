// AEGIS report-anchor registry — NEAR testnet.
//
// Purpose: store immutable anchors for AEGIS verdict reports. An anchor
// binds a report's SHA-256 hash to the verdict, the agent identity that
// produced it, the account that anchored it, and the block timestamp.
// Anyone can re-run the AEGIS kit on the same inputs, recompute the
// hash, and check it against this registry without trusting the machine
// that produced the report.
//
// An anchor proves only that a report with that exact hash was recorded
// at that time. It does NOT prove the verdict is correct.
//
// Design (deliberately minimal, auditable):
//   - One record per report_hash; first write wins. Re-anchoring the
//     same hash returns the existing record unchanged, so the original
//     timestamp can never be rewritten.
//   - Anchoring is permissionless: no owner, no allowlist, no admin
//     powers of any kind. The caller's account id is stored with the
//     record (anchored_by) so provenance is on-chain.
//   - No payable methods, no token handling, no fund flows at all.
//   - Input validation: report_hash must be a 64-char lowercase hex
//     SHA-256; verdict must be one of ALLOW / WARN / BLOCK; agent_id
//     must be a non-empty string of at most 128 chars.

import { NearBindgen, near, call, view, UnorderedMap } from "near-sdk-js";

const VALID_VERDICTS = ["ALLOW", "WARN", "BLOCK"];
const HEX64 = /^[0-9a-f]{64}$/;

class Anchor {
  report_hash: string;
  verdict: string;
  agent_id: string;
  anchored_by: string;
  // Block timestamp in nanoseconds since epoch, stored as a decimal
  // string (avoids bigint JSON serialization issues off-chain).
  timestamp_ns: string;

  constructor(
    report_hash: string,
    verdict: string,
    agent_id: string,
    anchored_by: string,
    timestamp_ns: string
  ) {
    this.report_hash = report_hash;
    this.verdict = verdict;
    this.agent_id = agent_id;
    this.anchored_by = anchored_by;
    this.timestamp_ns = timestamp_ns;
  }
}

@NearBindgen({})
export class AegisAnchorRegistry {
  anchors = new UnorderedMap<Anchor>("a");
  count = 0;

  @call({})
  record_anchor({
    report_hash,
    verdict,
    agent_id,
  }: {
    report_hash: string;
    verdict: string;
    agent_id: string;
  }): Anchor {
    if (!HEX64.test(report_hash)) {
      throw new Error("report_hash must be a 64-char lowercase hex SHA-256");
    }
    if (!VALID_VERDICTS.includes(verdict)) {
      throw new Error("verdict must be one of ALLOW, WARN, BLOCK");
    }
    if (!agent_id || agent_id.length === 0 || agent_id.length > 128) {
      throw new Error("agent_id must be a non-empty string of at most 128 chars");
    }

    const existing = this.anchors.get(report_hash);
    if (existing !== null) {
      // First write wins: return the original record untouched.
      near.log(
        `anchor already recorded for ${report_hash}; returning original`
      );
      return existing;
    }

    const anchor = new Anchor(
      report_hash,
      verdict,
      agent_id,
      near.predecessorAccountId(),
      near.blockTimestamp().toString()
    );
    this.anchors.set(report_hash, anchor);
    this.count += 1;
    near.log(`anchored ${report_hash} -> ${verdict} by ${anchor.anchored_by}`);
    return anchor;
  }

  @view({})
  get_anchor({ report_hash }: { report_hash: string }): Anchor | null {
    return this.anchors.get(report_hash, null);
  }

  @view({})
  anchor_count(): number {
    return this.count;
  }
}
