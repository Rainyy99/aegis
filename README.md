# AEGIS — the security gate for AI agents

> *No agent should execute what it hasn't verified.*

AI agents are now told to execute instructions written by third parties:
mint pages that embed step-by-step playbooks **for the agent**, skill
packages served from mutable "latest" URLs, onboarding documents that end
with "copy this prompt into your AI", agent forums where a significant share
of posts are injection material. A compliant agent is one pasted paragraph
away from draining its owner's wallet.

**AEGIS verifies before anyone executes.** Point it at a contract address, a
signature payload, a claim, or a page of instructions; it runs four gates and
returns a verdict — **ALLOW**, **WARN**, or **BLOCK** — with line-level
evidence. The hash of the merged report is anchored in a registry contract
on **NEAR testnet**, so any agent or human can re-run the same inputs,
recompute the hash, and check it against the chain later — without trusting
this machine or a server of ours.

Built for the **NEAR Hackathon — Build Beyond Boundaries** (submission window
1–14 Nov 2026 UTC). Tracks: **AI Security & Defense** (primary),
**Agent Economy**.

This is the **v1.0** release: all four gates are full implementations, the
unified runner is included, both test suites pass (45 checks), and two real
reports are anchored on NEAR testnet (see [On-chain anchors](#on-chain-anchors--near-testnet)).

---

## The four gates

| Gate | Question | What it checks | Status |
|---|---|---|---|
| **1 · Provenance** | *Is this source official, or a third-party echo?* | A claim (an address, a link) is accepted only when the project's **official channel actually carries it** — the tool fetches the official source and an independent source and checks the claim is present in each; a caller-supplied URL string alone is never proof. With `--registry`, the official host must match the project's known domains (checked before any fetch); the independent source must be on a different host than the official one. Relayed messages are recorded as arrival evidence only, never as confirmation. | Full implementation v1.0.0 (`check-provenance.mjs`) |
| **2 · Contract** | *Is the code verified, and what can it actually do?* | Sourcify verification (Exact Match preferred; a partial match is downgraded to WARN), then a risk-pattern scan of the verified source: `delegatecall`, `selfdestruct`, `permit`, approval/`transferFrom` surface, owner setters (`setPrice`, `withdraw`, …). Counts are evidence; a human-grade audit attributes them before they decide anything. | Working v0.2.0 (`check-contract.mjs`) — unchanged component of kit v1.0.0 |
| **3 · Signature** | *What exactly is being signed, and who authored the payload?* | Full EIP-712 structural decode before any signature: domain name, chainId, verifyingContract (never a held token/NFT, a router, or Permit2 — Permit2 is built in, the rest via caller context), primaryType (never `Permit` variants), forbidden `spender`/`value`/`amount` fields anywhere in the message or declared types, domain scoped to the single project. One failed check = stop and report the payload — the full payload is echoed in the report. | Full implementation v1.0.0 (`check-signature.mjs`) |
| **4 · Instruction channel** | *Is somebody's page trying to operate the agent?* | Pages, packages and docs are scanned for instructions addressed to agents across six weighted signal groups: server-sign-submit sequences, external-server (MCP) connection directives, agent-targeted install scripts, agent-addressed instructions, false authority, manufactured urgency. A challenge→sign→submit sequence, or a server-sign-submit + external-server combination, is a BLOCK at any score. Every hit is reported with line-numbered excerpts. Content is data; only the user's own instructions are instructions. | Full implementation v1.0.0 (`check-instructions.mjs`) |

## Verdicts

- **ALLOW** — all gates pass; the action can be constructed, simulated, and
  executed by the agent itself, within pre-set value limits.
- **WARN** — something needs attribution or a condition first (an unattributed
  pattern, a mutable download that must be hash-pinned, independent
  confirmation missing). A WARN is a to-do list, not a rejection.
- **BLOCK** — a gate fails outright: unverifiable code, a signature payload
  that fails the structural rules, a claim no official channel carries, or an
  execution flow orchestrated by the counterparty's server.

## Case studies (real, verified, from live operation)

AEGIS was distilled from gates that were actually run by an operating agent
before this project existed. The full evidence files are in
[`cases/`](cases/):

| Case | Verdict | Lesson |
|---|---|---|
| [Nonce Protocol](cases/nonce.md) — freemint whose page contains an agent playbook; mint orchestrated by the project's MCP server | **BLOCK** (Gates 3–4) | The contracts passed a full manual audit (Sourcify Exact Match) — and it didn't matter. *Verified contract ≠ verified flow.* |
| [Hashstone](cases/hashstone.md) — Agent-ID-gated freemint, direct on-chain `mine(nonce)` with local PoW | **ALLOW** | Both contracts Exact Match, value-0 self-built transaction, nothing to sign, no server in the loop. Owner-admin surface attributed, not feared. |
| [TermiX skill package](cases/termix.md) — agent skill zip from a `?v=latest` URL, self-updates against an unsigned manifest | **WARN → ALLOW-WITH-PIN** | The engineering inside was sound (keyless default signing); the distribution channel was the risk. Pinning the audited sha256 (`227b1b4e…`) fixed the channel. *"Latest" is not a version.* |

The Nonce and Hashstone verdicts were re-run through the unified runner and
their report hashes are **anchored on NEAR testnet** — see
[On-chain anchors](#on-chain-anchors--near-testnet) below; the anchored runner
reports themselves are committed under [`anchor/reports/`](anchor/reports/).

## Run it

Requirements: Node.js ≥ 18. No dependencies, nothing to install.

### The unified runner — `aegis.mjs`

One entry point runs whichever gates your inputs make applicable and merges
them into a single report with a deterministic **reportHash** — the value the
NEAR anchor registry stores.

```bash
# Gate 2 only — Hashstone NFT (BSC): expect overall ALLOW
node aegis.mjs --contract 0x00fbc656caa753a5280835bf9e849c4c0aff9bf4 --chain 56

# The Nonce composition — Gate 4 on the case file + Gate 3 on a Permit
# payload: expect overall BLOCK
node aegis.mjs --brief cases/nonce.md --typed-data tests/fixtures/permit.json

# Full composition — every gate that has its primary input runs:
node aegis.mjs \
  --claim 0x00fbc656caa753a5280835bf9e849c4c0aff9bf4 \
  --official <official-page-url> --independent <independent-source-url> \
  --registry <official-host> \
  --contract 0x00fbc656caa753a5280835bf9e849c4c0aff9bf4 --chain 56 \
  --typed-data <typed-data.json> --expected-chain 56 \
  --brief <instructions.txt>
```

Gate inputs: Gate 1 ← `--claim` (plus `--official`, `--independent`,
`--registry`, `--relayed`), Gate 2 ← `--contract` (`--chain`), Gate 3 ←
`--typed-data` (plus `--context`, `--expected-chain`, `--project-domain`,
`--deny`), Gate 4 ← `--brief`. A gate without its primary input is
**SKIPPED** (reason recorded; skipped gates never affect the result). A gate
that was applicable but could not produce a verdict (transient fetch failure,
malformed input, …) is **NO_VERDICT**.

**Merge rule:** the overall verdict is the *worst* verdict among gates that
produced one (BLOCK > WARN > ALLOW). If any applicable gate is NO_VERDICT,
the overall verdict may not be ALLOW — it is capped at WARN and the report
carries `overall.incomplete: true`. If no applicable gate produced a verdict,
the overall verdict is NO_VERDICT and the runner exits 1 (the report is still
printed). Running with no gate input at all is a usage error (exit 1).

**reportHash:** SHA-256 over the canonical serialization of the report body
— JSON with object keys sorted recursively, arrays in order, no insignificant
whitespace, UTF-8. Exactly two volatile fields are excluded: `generatedAt`
and `reportHash` itself. Everything else is hashed, including SHA-256
digests of the file inputs, so the verdict is bound to its exact inputs and
re-running identical inputs reproduces the identical hash. The JSON report
goes to stdout; a short human summary (overall verdict, one line per gate,
the hash) goes to stderr — `--pretty` expands it to every per-gate reason.

### The gates individually

Each gate is also a standalone CLI with the same conventions (JSON report on
stdout, named reasons, operator errors as JSON on stderr with exit 1).

```bash
# Gate 1 — provenance of one claim. The official and independent sources
# are fetched and must actually carry the claim; --registry pins the
# official host to the project's known domains.
node check-provenance.mjs <claim> [official-source-url] [independent-source-url] \
    [--registry host1,host2] [--relayed <channel>]

# Gate 2 — contract checker (Sourcify). Expect exact_match + ALLOW for
# Hashstone; the Nonce FreeMint also passes Gate 2 alone — its BLOCK
# comes from Gates 3–4, which is exactly the point of the case.
node check-contract.mjs 0x00fbc656caa753a5280835bf9e849c4c0aff9bf4
node check-contract.mjs 0x7538ba8C1A82E9706dB6d2463C15f69ADc01a17e
node check-contract.mjs <address> <chainId>     # chainId defaults to 56

# Gate 3 — structural EIP-712 check of a typed-data JSON file (or stdin).
# tests/fixtures/permit.json is an ERC-2612 Permit — expect BLOCK.
node check-signature.mjs tests/fixtures/permit.json
node check-signature.mjs <typed-data.json> [--context ctx.json] \
    [--expected-chain 56] [--project-domain "<project name>"] [--deny 0x…,…]

# Gate 4 — instruction-channel scan of a text file (or stdin).
# cases/nonce.md — expect BLOCK (score 15; the challenge→sign→submit
# sequence fires). tests/fixtures/benign.txt — expect ALLOW.
node check-instructions.mjs cases/nonce.md
node check-instructions.mjs tests/fixtures/benign.txt
```

How to read Gate 2 output: **counts are evidence, not verdicts.** A textbook
ERC-721 shows `approve` / `transferFrom` counts because that's what an ERC-721
is — the report separates project source from library code so a reviewer can
see *where* every hit lives. The scanner BLOCKs only the unverifiable, WARNs
only when a critical primitive (`delegatecall`, `selfdestruct`) or a `permit`
surface appears in *project* source, or when the match is only partial, and
otherwise ALLOWs with the remaining evidence attached for the audit trail.
Saved reference outputs live in
[`cases/hashstone-contract-check.json`](cases/hashstone-contract-check.json)
and [`cases/nonce-contract-check.json`](cases/nonce-contract-check.json).

API notes (learned by probing, so you don't have to): Sourcify API v2 lives
at `https://sourcify.dev/server/v2/contract/{chainId}/{address}` — the
`/api` infix you may remember now returns the website's HTML 404. The default
response is a summary only; verified sources require `?fields=sources`. An
unverified contract returns HTTP 404 **with a JSON body** (`match: null`) —
the checker treats that body as the "not verified" answer, not as an error.

### Tests

```bash
npm test
# — or individually:
node tests/run-tests.mjs          # 34 checks: per-gate batteries
node tests/run-runner-tests.mjs   # 11 checks: runner composition + hash
```

Both suites run against the files in this repo (fixtures in
`tests/fixtures/`) and finish in seconds. Parts of the Gate 2 battery query
**live Sourcify**, and the runner suite's live cases are SKIP-guarded if
Sourcify is unreachable; the partial-match / retry cases run against a local
stub server and work offline. A full green run therefore wants network
access to `sourcify.dev`.


## On-chain anchors — NEAR testnet

Verdicts are only useful if they outlive the server that produced them, so
the runner's `reportHash` can be registered in a small NEAR registry
contract. The contract and its tooling live in [`anchor/`](anchor/) (source:
`anchor/src/contract.ts`; full deployment record and verification recipe:
[`anchor/README.md`](anchor/README.md)).

| | |
|---|---|
| Contract / account | [`aegis-gate.testnet`](https://testnet.nearblocks.io/address/aegis-gate.testnet) (NEAR **testnet**) |
| Surface | `record_anchor(report_hash, verdict, agent_id)` · `get_anchor(report_hash)` · `anchor_count()` |
| Rules | The hash must be a 64-char lowercase hex SHA-256 and the verdict ALLOW / WARN / BLOCK. **First write wins** — re-anchoring a hash returns the original record unchanged, so a timestamp can never be rewritten. Anchoring is **permissionless**: no owner, no allowlist, no admin power. No payable methods; the contract holds no funds. |

Two real reports are anchored (both read back via public RPC, round-trip
exact; agent identity recorded: `rainyy.ai`):

| Report | reportHash | Verdict | Anchor tx |
|---|---|---|---|
| Nonce composition (Gate 4 brief + Gate 3 Permit payload) | `7c7cf5b8979c312f790713f94e650e8d0b83c163570783b16ae171802122060f` | **BLOCK** | [`CQWcvjoukVqBTfa74wRNNKpGtyRRYBv2LmaAzdH5jooo`](https://testnet.nearblocks.io/txns/CQWcvjoukVqBTfa74wRNNKpGtyRRYBv2LmaAzdH5jooo) |
| Hashstone, Gate-2-only run | `79729980bfa8fe4ce1b4dde58766b65cba21987364473659190c744d66237d8d` | **ALLOW** | [`FNwEp27ArWZtruwkbvMHJVjHjqkEzms99eZHBDs4gDfn`](https://testnet.nearblocks.io/txns/FNwEp27ArWZtruwkbvMHJVjHjqkEzms99eZHBDs4gDfn) |

**What anchoring proves:** a report with that exact hash existed at the
recorded time and was submitted by the recorded account under the recorded
agent identity. **What it does not prove:** that the verdict is correct, that
the gates ran honestly, or that the inputs were authentic. Anyone can re-run
the kit on the same inputs, recompute the hash, and compare — that
reproducibility, not the chain record alone, is the verification. (The
anchored hashes bind the runner's merged digest, not the full per-gate
evidence — limitation 13.)

Security note: **no credentials are committed in this repository** — no NEAR
key files, seed phrases, or `.env`. The anchor scripts read the deployer key
from a local `.near-credentials/` file at runtime (testnet funds only);
see `anchor/README.md`, "Account & key custody" (limitations 14–15).

## Web demo

A static showcase page lives in [`demo/`](demo/) (`demo/index.html`, no
build step, no dependencies): the four gates, the three case studies with
their real verdicts, and the on-chain anchor proof above. It is served via
**Vercel** from this repository. The page is a showcase — the checkers
themselves are the CLIs in this repo, run locally as documented above.

## Why NEAR

The guard agent's identity is a NEAR account, its verdicts are timestamped
and re-verifiable by anyone, and its track record becomes public
infrastructure for the agent economy — one identity, verifiable verdicts,
chain-agnostic reach (the gates themselves check EVM contracts and payloads).
Roadmap beyond the testnet anchoring registry: automatic anchoring from the
runner, mainnet anchoring, and NEAR Intents / Chain Signatures so one gate
can serve agents operating on any chain.

## Roadmap

- ✅ **Starter kit (pre-window, Oct 2026):** gate definitions, the three case
  files from live evidence, Gate 2 CLI prototype (`check-contract.mjs`) with
  saved reference outputs.
- ✅ **Build window (1–7 Nov 2026):** Gates 1, 3, 4 implemented in full
  (v1.0.0); unified runner `aegis.mjs` with the merge rule and canonical
  `reportHash`; 45-check test suite green; NEAR **testnet** anchoring
  registry deployed with two real reports anchored and read back; demo page
  built (`demo/`).
- **Remaining to submission (by 14 Nov 2026):** demo served via Vercel from
  this repo; this v1.0 repo sync; demo post on X from @aegisonnear;
  submission form (payout account `rainyy66.near`, mainnet — payout only,
  never touched by the tooling).
- **Post-hackathon:** runner-integrated automatic anchoring; mainnet
  registry; a second verification source for Gate 2 (limitation 6).

## Scope & Known Limitations

Disclosed openly, per the submission policy: nothing below is hidden from
reviewers or judges. The full audit trail is in [`AUDIT.md`](AUDIT.md)
(sections 1–8). Limitation numbers follow AUDIT.md; **#5 is closed**
(`partial_match` has been downgraded to a forced WARN since v0.2.0) and is
therefore not listed as remaining.

1. **Counts are raw text occurrences** (code + comments + strings), never
   attributions — by design, and stated in the tool's disclaimer. Known
   noise sources: `permit` is case-insensitive, so EIP-712 type/struct
   names or prose containing "Permit" count too; `withdraw[A-Za-z0-9_]*`
   also matches `withdrawal`; standard interface functions inside a
   project's *own* token contract count as surface evidence.
   *Impact on verdicts:* counts alone never decide; a human/agent audit
   must attribute them. *Mitigation/roadmap:* per-contract attribution,
   starting with flattened files.
2. **Project/library split is path-based**: only `node_modules/…` counts as
   library. A single flattened file (the Nonce case) puts *every* contract
   in "project", so surface counts there are per-file, not per-contract —
   the scanner cannot attribute contracts inside one compilation unit; the
   case files carry that attribution manually.
   *Impact:* surface counts on flattened contracts read higher than a
   per-contract view would. *Mitigation/roadmap:* manual attribution in
   case files now; per-contract splitting if feasible.
3. **Setter detection is narrow**: only `function setX(…)` declarations are
   listed. Admin mutators with other names (`updatePrice`, `changeFee`,
   `setPaused`-style toggles not starting with "set"+uppercase, public
   state-variable writers) are missed.
   *Impact:* an admin surface can pass unlisted. *Mitigation/roadmap:*
   widen the mutator pattern set; until then, setters are evidence, not a
   completeness claim.
4. **Verdict scope is deliberately thin**: Gate 2 escalates only on
   unverifiable code and project-source `delegatecall` / `selfdestruct` /
   `permit` (plus `partial_match`). Dangerous *combinations* of
   surface/admin patterns (e.g. `onlyOwner` × `withdraw` over user funds)
   still return ALLOW with the evidence attached — the human/agent audit
   remains the decider, exactly as stated above.
   *Impact:* ALLOW at Gate 2 is a screening pass, never a clean bill of
   health. *Mitigation/roadmap:* combination rules, gated by labelled cases
   so they do not produce false BLOCKs.
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
   second source (e.g. BscScan with a key) when one becomes viable.
7. **Availability of `AbortSignal.timeout`** assumes Node ≥ 18, as
   documented in the requirements above.
   *Impact:* the checker will not run on older Node. *Mitigation:* the
   requirement is stated up front; no workaround is promised.
8. **Gate 1 "claim found" is a content heuristic**, not semantic
   attribution: substring match, or record-existence for record-style
   URLs. A page that mentions an address in a warning still "carries" it.
   *Impact:* a human/agent must still confirm the claim's ROLE (mint
   contract? warning example?) before acting.
9. **Gate 1 does not discover official channels.** Whoever supplies the
   "official" URL frames the check; without a caller-supplied domain
   registry, a lookalike domain carrying the same claim would pass the
   content test (the report states on every run when no registry was
   supplied). *Mitigation:* the registry + independent-confirmation
   requirements mitigate, not eliminate, this.
10. **Gate 3 is structural only.** It verifies no signature, recovers no
    signer, and cannot prove a verifyingContract really belongs to the
    project. Held/router classification is only as complete as the
    caller-supplied lists — only Permit2 is built in; a hostile contract
    on no list passes classification, with domain-scope and chain checks
    as backstops only when the caller supplies that context. An ALLOW
    never replaces building and simulating the final transaction
    separately (outside this gate by design).
11. **Gate 3 types/message mismatch is WARN, not BLOCK** — deliberate
    (wallets sign the declared types; undeclared message fields are not
    signed), but the warning must actually be read.
12. **Gate 4 remains regex/heuristic screening.** Paraphrased, obfuscated,
    image-carried, or non-English instructions can evade it; thresholds are
    calibrated on the kit's own cases, not a broad labelled corpus; and
    text DISCUSSING these patterns scores like text using them (stated in
    every report's disclaimer). URL/package fetching is not implemented —
    input is a local file or stdin, so whoever fetches the page controls
    its freshness.
13. **The runner composes file inputs only, and its report is a digest,
    not the full evidence.** Stdin composition (supported by the Gate 3/4
    CLIs individually) is not wired into the runner, and the merged report
    embeds per-gate verdicts, reasons, and curated evidence — not the
    gates' complete reports (run a gate's own CLI for its full output).
    The reportHash therefore binds the merged digest, not the underlying
    per-gate artifacts, whose own digests would need separate anchoring if
    byte-level evidence retention is ever required.
14. **Anchoring is testnet-only and manual.** The registry lives on NEAR
    testnet (anchors carry no mainnet evidentiary weight), and anchoring
    is a separate manual step via `anchor/anchor.mjs` — the runner does
    not yet anchor automatically.
15. **Anchor deployer key custody is a local file.** The
    `aegis-gate.testnet` full-access key sits in the operator's local
    `.near-credentials/` (never committed, testnet funds only). Because
    anchoring is permissionless and records are first-write-wins, a leaked
    key could only spend the account's testnet balance or anchor
    additional reports under this account's name — it cannot alter
    existing anchors.

## Safety stance

AEGIS only ever **reads**. It holds no keys, signs nothing, and executes
nothing — it exists so that the agents who *do* execute can prove they
checked first. The one component that signs (the testnet anchor tooling)
uses a local, never-committed key for testnet faucet funds only, and is
kept apart from the checkers.
