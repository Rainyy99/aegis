# AEGIS — the security gate for AI agents

> *No agent should execute what it hasn't verified.*

AI agents are now told to execute instructions written by third parties:
mint pages that embed step-by-step playbooks **for the agent**, skill
packages served from mutable "latest" URLs, onboarding documents that end
with "copy this prompt into your AI", agent forums where a significant share
of posts are injection material. A compliant agent is one pasted paragraph
away from draining its owner's wallet.

**AEGIS verifies before anyone executes.** Point it at a contract address or
a package; it runs four gates and returns a verdict — **ALLOW**, **WARN**, or
**BLOCK** — with line-level evidence, and the report hash is anchored on
**NEAR** so any agent or human can re-verify it later without trusting our
server.

Built for the **NEAR Hackathon — Build Beyond Boundaries** (submission window
1–14 Nov 2026 UTC). Tracks: **AI Security & Defense** (primary),
**Agent Economy**.

---

## The four gates

| Gate | Question | What it checks | Status |
|---|---|---|---|
| **1 · Provenance** | *Is this source official, or a third-party echo?* | Addresses, links and claims are accepted only from the project's official channels, and re-confirmed against independent infrastructure (explorers, Sourcify) — never from a relayed message, a comment, or another agent's summary. | Scaffold (`check-provenance.mjs`) |
| **2 · Contract** | *Is the code verified, and what can it actually do?* | Sourcify verification (Exact Match preferred), then a risk-pattern scan of the verified source: `delegatecall`, `selfdestruct`, `permit`, approval/`transferFrom` surface, owner setters (`setPrice`, `withdraw`, …). Counts are evidence; a human-grade audit attributes them before they decide anything. | Working prototype v0.2.0 (`check-contract.mjs`) |
| **3 · Signature** | *What exactly is being signed, and who authored the payload?* | Full EIP-712 decode before any signature: domain name, chainId, verifyingContract (never a held token/NFT, a router, or Permit2), primaryType (never `Permit` variants), forbidden `spender`/`value`/`amount` fields, domain scoped to the single project. Payloads authored at runtime by a counterparty's server fail by construction. | Scaffold (`check-signature.mjs`) |
| **4 · Instruction channel** | *Is somebody's page trying to operate the agent?* | Pages, packages and docs are scanned for instructions addressed to agents: "connect to our MCP server", challenge→sign→submit sequences with server-supplied payloads, agent-targeted install scripts, manufactured urgency, authority claims. Content is data; only the user's own instructions are instructions. | Scaffold (`check-instructions.mjs`) |

## Verdicts

- **ALLOW** — all gates pass; the action can be constructed, simulated, and
  executed by the agent itself, within pre-set value limits.
- **WARN** — something needs attribution or a condition first (an unattributed
  pattern, a mutable download that must be hash-pinned, an admin surface to
  understand). A WARN is a to-do list, not a rejection.
- **BLOCK** — a gate fails outright: unverifiable code, a signature the user
  cannot audit in advance, or an execution flow orchestrated by the
  counterparty's server.

## Case studies (real, verified, from live operation)

AEGIS was distilled from gates that were actually run by an operating agent
before this project existed. The full evidence files are in
[`cases/`](cases/):

| Case | Verdict | Lesson |
|---|---|---|
| [Nonce Protocol](cases/nonce.md) — freemint whose page contains an agent playbook; mint orchestrated by the project's MCP server | **BLOCK** (Gate 4) | The contracts passed a full manual audit (Sourcify Exact Match) — and it didn't matter. *Verified contract ≠ verified flow.* |
| [Hashstone](cases/hashstone.md) — Agent-ID-gated freemint, direct on-chain `mine(nonce)` with local PoW | **ALLOW** | Both contracts Exact Match, value-0 self-built transaction, nothing to sign, no server in the loop. Owner-admin surface attributed, not feared. |
| [TermiX skill package](cases/termix.md) — agent skill zip from a `?v=latest` URL, self-updates against an unsigned manifest | **WARN → ALLOW-WITH-PIN** | The engineering inside was sound (keyless default signing); the distribution channel was the risk. Pinning the audited sha256 (`227b1b4e…`) fixed the channel. *"Latest" is not a version.* |

## Run it

Requirements: Node.js ≥ 18. No dependencies, nothing to install.

### Gate 2 — contract checker (working prototype)

```bash
# Hashstone NFT (BSC) — expect: exact_match, ALLOW
node check-contract.mjs 0x00fbc656caa753a5280835bf9e849c4c0aff9bf4

# Nonce FreeMint (BSC) — Gate 2 view of the BLOCK case:
# exact_match, patterns attributed to sibling contracts in the same file
node check-contract.mjs 0x7538ba8C1A82E9706dB6d2463C15f69ADc01a17e

# Any EVM contract: add a chainId (default 56)
node check-contract.mjs <address> <chainId>
```

Output is a JSON report: verification status and match type, verified-at
timestamp, source inventory (project files vs `node_modules/` libraries),
pattern counts split the same way with a per-file breakdown for project
sources, and a Gate 2 screening verdict with named reasons. Saved reports
from the two runs above live in
[`cases/hashstone-contract-check.json`](cases/hashstone-contract-check.json)
and [`cases/nonce-contract-check.json`](cases/nonce-contract-check.json).

How to read it: **counts are evidence, not verdicts.** A textbook ERC-721
shows `approve` / `transferFrom` counts because that's what an ERC-721 is —
the report separates project source from library code so a reviewer can see
*where* every hit lives. The scanner BLOCKs only the unverifiable, WARNs
only when a critical primitive (`delegatecall`, `selfdestruct`) or a
`permit` surface appears in *project* source, or when the match is only
partial, and otherwise ALLOWs with the remaining evidence attached for the
audit trail.

API notes (learned by probing, so you don't have to): Sourcify API v2 lives
at `https://sourcify.dev/server/v2/contract/{chainId}/{address}` — the
`/api` infix you may remember now returns the website's HTML 404. The default
response is a summary only; verified sources require `?fields=sources`. An
unverified contract returns HTTP 404 **with a JSON body** (`match: null`) —
the checker treats that body as the "not verified" answer, not as an error.

### Gates 1, 3, 4 — scaffolds (build phase 1–7 Nov 2026)

These three modules expose their function interfaces and structured TODOs,
but they are **not full implementations and their output is not a verdict
to act on**. Each prints a JSON report with `gateN: "SCAFFOLD"` plus its
preliminary findings and build list:

```bash
# Gate 1 — provenance of one claim (official + independent source recorded)
node check-provenance.mjs <claim> [official-source-url] [independent-source-url]

# Gate 3 — structural EIP-712 check of a typed-data JSON file
# (domain name/chainId/verifyingContract presence, Permit primaryType
# rejection, spender/value/amount field rejection)
node check-signature.mjs <typed-data-json-file>

# Gate 4 — preliminary instruction-channel signal counts of a text file
node check-instructions.mjs <text-file>
```

Try it — do X, see Y:

```bash
# Do: run Gate 2 on the Hashstone freemint contract
node check-contract.mjs 0x00fbc656caa753a5280835bf9e849c4c0aff9bf4
# See: verification exact_match and verdict ALLOW, with the owner-admin
# surface listed as evidence (setBaseURI, setPrice, …) rather than hidden.

# Do: run Gate 3's scaffold on a Permit payload (make one first, or use
# any EIP-712 JSON with primaryType "Permit")
node check-signature.mjs payload.json
# See: gate3 "SCAFFOLD" plus a failure naming the Permit primaryType —
# the shape Gate 3 exists to reject, even before the build is finished.
```

### Web demo (build phase, hosting: Vercel)

The live demo — paste a contract address or a URL, get a verdict in about
a minute, with the three case studies above as one-click examples — is
built in the 1–7 Nov window and deployed from this repo. It is not in this
starter snapshot.

## Why NEAR

Verdicts are only useful if they outlive the server that produced them.
AEGIS anchors the hash of every verdict report in a small NEAR registry
contract: the guard agent's identity is a NEAR account, its verdicts are
timestamped and re-verifiable by anyone, and its track record becomes public
infrastructure for the agent economy — one identity, verifiable verdicts,
chain-agnostic reach. Roadmap beyond the anchoring registry: NEAR Intents /
Chain Signatures so one gate can serve agents operating on any chain.

## Roadmap

- ✅ **Starter kit (pre-window, Oct 2026):** gate definitions, the three case
  files from live evidence, Gate 2 CLI prototype (`check-contract.mjs`) with
  saved reference outputs.
- **In-window (1–14 Nov 2026):** Gate 1 provenance checker and Gate 3 EIP-712
  payload decoder prototypes; Gate 4 instruction-channel heuristics pack;
  NEAR testnet anchoring registry (report-hash contract + agent identity);
  web demo — paste an address or a URL, get a verdict in about a minute;
  mainnet anchoring + final submission (repo, X demo post, payout account).

## Scope & Known Limitations

Disclosed openly, per the submission policy: nothing below is hidden from
reviewers or judges. The full audit trail is in [`AUDIT.md`](AUDIT.md)
(v0.2.0). Limitation numbers follow AUDIT.md §4; #5 is closed in v0.2.0
(`partial_match` is now downgraded to WARN) and is therefore not listed as
remaining.

1. **Counts are raw text occurrences** (code + comments + strings), never
   attributions — by design, and stated in the tool's disclaimer. Known
   noise sources: `permit` is case-insensitive, so EIP-712 type/struct
   names or prose containing "Permit" count too; `withdraw[A-Za-z0-9_]*`
   also matches `withdrawal`; standard interface functions inside a
   project's *own* token contract count as surface evidence.
   *Impact on verdicts:* counts alone never decide; a human/agent audit
   must attribute them. *Mitigation/roadmap:* per-contract attribution in
   the build phase, starting with flattened files.
2. **Project/library split is path-based**: only `node_modules/…` counts as
   library. A single flattened file (the Nonce case) puts *every* contract
   in "project", so surface counts there are per-file, not per-contract —
   the scanner cannot attribute contracts inside one compilation unit; the
   case files carry that attribution manually.
   *Impact:* surface counts on flattened contracts read higher than a
   per-contract view would. *Mitigation/roadmap:* manual attribution in
   case files now; per-contract splitting in the build phase if feasible.
3. **Setter detection is narrow**: only `function setX(…)` declarations are
   listed. Admin mutators with other names (`updatePrice`, `changeFee`,
   `setPaused`-style toggles not starting with "set"+uppercase, public
   state-variable writers) are missed.
   *Impact:* an admin surface can pass unlisted. *Mitigation/roadmap:*
   widen the mutator pattern set in the build phase; until then, setters
   are evidence, not a completeness claim.
4. **Verdict scope is deliberately thin**: Gate 2 escalates only on
   unverifiable code and project-source `delegatecall` / `selfdestruct` /
   `permit` (plus `partial_match`, v0.2.0). Dangerous *combinations* of
   surface/admin patterns (e.g. `onlyOwner` × `withdraw` over user funds)
   still return ALLOW with the evidence attached — the human/agent audit
   remains the decider, exactly as stated above.
   *Impact:* ALLOW at Gate 2 is a screening pass, never a clean bill of
   health. *Mitigation/roadmap:* combination rules are a build-phase item,
   gated by labelled cases so they do not produce false BLOCKs.
6. **(Residual) Sourcify is the trust anchor**: the tool trusts Sourcify's
   match and the sources it returns at query time; it does not independently
   compare runtime bytecode or pin a block height. v0.2.0 narrowed this
   (bounded retry, up to 3 attempts, and an explicit
   `verification.crossCheck.status: "unavailable"` on every report because
   no keyless second source was viable when probed 29 Oct 2026) but did not
   close it: a Sourcify outage still fails loudly with no verdict, and
   there is still no second source.
   *Impact:* a wrong or unavailable Sourcify answer propagates or blocks
   the gate. *Mitigation/roadmap:* fail-loud, never fabricate; plug a real
   second source (e.g. BscScan with a key) in the build phase when one
   becomes viable.
7. **Availability of `AbortSignal.timeout`** assumes Node ≥ 18, as
   documented in the requirements above.
   *Impact:* the checker will not run on older Node. *Mitigation:* the
   requirement is stated up front; no workaround is promised.

## Safety stance

AEGIS only ever **reads**. It holds no keys, signs nothing, and executes
nothing — it exists so that the agents who *do* execute can prove they
checked first.
