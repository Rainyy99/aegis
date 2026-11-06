# AEGIS — QA / audit pass (kit v1.0.0 + runner + NEAR testnet anchor)

**Date:** 28 Oct 2026 (WIB) · **Scope:** `check-contract.mjs`, the three case
files (`cases/nonce.md`, `cases/hashstone.md`, `cases/termix.md`), the saved
reference outputs, and README claims about the tool. **Method:** full code
read, live test battery against Sourcify (read-only GETs), and a line-by-line
fact-check of the case files against `~/MEMORY.md` and the daily logs
`~/memory/2026-10-27.md` + `~/memory/2026-10-28.md`. No wallet, no
transactions, no sign-ups.

**Outcome:** 4 bugs found and fixed in `check-contract.mjs` (v0.1.0 → v0.1.1).
All required verdicts are unchanged after the fixes. Case files: **zero
discrepancies** against the memory record.

---

## 1. Code review — `check-contract.mjs`

Reviewed: argument handling, fetch/JSON error handling, regex patterns,
project-vs-library split, verdict logic, exit behavior.

### Bugs found & fixed (v0.1.1)

1. **Non-200/404 HTTP statuses were misread as "not verified".**
   The old code parsed *any* Sourcify response body; a `400` (unsupported
   chain), `429` (rate limit) or `5xx` body would be treated as
   `match: undefined` → a fabricated **BLOCK ("contract is not verified")**
   verdict. Reproduced: chainId `999999` returned HTTP 400 (verified with
   curl) yet the old CLI issued a BLOCK verdict. **Fix:** only `200`
   (verified) and `404` (the genuine not-verified answer, JSON body with
   `match: null`) are parsed; any other status now fails loudly with
   `Sourcify request failed: HTTP <status> (… no verdict issued)`, exit 1.
2. **Setter-list false friend: `setApprovalForAll`.**
   `SETTER_REGEX` (`set[A-Z]…`) captured the standard ERC-721/1155 interface
   function `setApprovalForAll` and reported it as an owner-admin "setter"
   (visible in the Nonce output: `setterFunctions: ["setApprovalForAll",
   "setPaused"]`). **Fix:** a `SETTER_EXCLUSIONS` set removes it from the
   setter listing; its pattern count still appears under
   `patterns.setApprovalForAll`, so nothing is hidden.
3. **Verified-but-no-sources would have produced a false ALLOW.**
   If Sourcify reported a match but returned zero source files, the scan
   silently produced all-zero counts and the verdict read "Verified …; no
   critical/permit patterns in project source" — claiming a clean scan that
   never happened. **Fix:** zero source files now force **WARN** with a named
   reason ("…returned no source files to scan — fetch and review the source
   manually…").
4. **Unhandled-rejection / shape crashes.**
   `main()` was invoked without `.catch()`, and the parsed body was trusted
   blindly: a JSON `null` body (`data.match` → TypeError), or a `sources`
   entry that is `null`/non-object (`v.content` → TypeError), would have
   crashed with a raw stack trace. **Fix:** `main().catch(...)` routes any
   unexpected throw through the clean JSON error path (stderr, exit 1); the
   parsed body must be a non-null, non-array object; `sources` entries are
   coerced (`content` used only when it is actually a string).

### Reviewed and found sound (no change)

- Address validation (`/^0x[0-9a-fA-F]{40}$/`) and chainId validation
  (positive integer) reject bad input with a JSON usage error, exit 1.
- The 404-with-JSON unverified path works as documented (see test T3/F3).
- Shared module-level global regexes are safe across calls:
  `String.match` with `/g` resets `lastIndex`, and `matchAll` clones the
  regex — repeated scans show no state bleed (outputs are byte-stable across
  runs, modulo `queriedAt`).
- Errors go to stderr as JSON, reports to stdout as JSON; unverified is a
  successful report (exit 0, verdict BLOCK), operator errors exit 1.

---

## 2. Test battery — actual verdicts

Run before fixes (v0.1.0) and re-run after (v0.1.1). Verdicts identical
except where a fix intentionally corrects behavior (noted).

| # | Input | Expected | v0.1.0 | v0.1.1 |
|---|---|---|---|---|
| T1/F1 | Hashstone NFT `0x00fbc656caa753a5280835bf9e849c4c0aff9bf4` | verified exact_match, ALLOW | ✅ exact_match, **ALLOW** — project: delegatecall/selfdestruct/permit/approve/setApprovalForAll/transferFrom all 0, withdraw 1, onlyOwner 7, setters [setBaseURI, setContractURI, setOpen, setPrice, setRoyalty, setTarget] | ✅ identical |
| T2/F2 | Nonce FreeMint `0x7538ba8C1A82E9706dB6d2463C15f69ADc01a17e` | verified exact_match, ALLOW at Gate 2 | ✅ exact_match, **ALLOW** — project (single flattened file): approve 14, setApprovalForAll 6, transferFrom 12, withdraw 1; critical/permit 0 | ✅ same verdict & counts; setter list corrected to `["setPaused"]` (false friend removed) |
| T3/F3 | Agentic Pixels NFT `0xd861842E29686d092DAd39EfB5d1Ba3807804e2A` | NOT verified (exercises 404-with-JSON), BLOCK | ✅ `verified: false`, **BLOCK**, exit 0 | ✅ identical |
| T4/F4 | `0x123` (invalid) | clean error, no crash | ✅ JSON usage error on stderr, exit 1 | ✅ identical |
| T5/F5 | Zero address `0x0000…0000` | no ugly crash | ✅ treated as unverified → **BLOCK**, exit 0 | ✅ identical |
| F6 | no arguments | clean error | ✅ usage error, exit 1 | ✅ |
| F7 | chainId `abc` | clean error | ✅ "Invalid chainId: abc", exit 1 | ✅ |
| F8 | chainId `999999` (unsupported) | — | ❌ fabricated BLOCK (HTTP 400 body misread) | ✅ clean error, exit 1 — *behavior corrected by Fix 1* |
| F9 | Hashstone $ATOMS `0xfbd02ff0b007e08c5a36bd85e4c38d39a6ab2d57` (regression) | exact_match, ALLOW, clean project source | ✅ exact_match, **ALLOW** — all risk patterns 0 except onlyOwner 1, no setters | ✅ identical |

Saved reference outputs `cases/hashstone-contract-check.json` and
`cases/nonce-contract-check.json` were regenerated with v0.1.1; their
verification blocks (match, verifiedAt, matchId) and all counts are
unchanged from the v0.1.0 originals — only `version`, `queriedAt`, and the
Nonce setter list differ.

---

## 3. Case-file fact-check (vs MEMORY.md + daily logs)

Every address, hash, number, date, and verdict in all three case files was
checked against the record. **Zero discrepancies.**

- **nonce.md** — FreeMint `0x7538…a17e` (`NONCE_2_FreeMint`) and NFT
  `0x0532…398a` (`NonceFreeGenesis`), both Sourcify Exact Match; FreeMint
  `verifiedAt 2026-10-26T04:34:00Z`, solc 0.8.37, ~5,915-line combined file;
  `MintAuthorization` fields (attemptId, wallet, agentId, receiptHash,
  expiry); `usedAttempts` marked before mint; `MAX_PER_WALLET = 2`; only
  setter `setPaused` (guardian); MCP endpoint `mcp.nonceprotocol.xyz`;
  EIP-712 domains "NONCE MCP Sign In" / "NONCE Free Mint"; SAT format
  `nonce-logic-balanced-1536` (1,536 vars / 33,792 clauses); scanner counts
  quoted in the file (approve 14, setApprovalForAll 6, transferFrom 12,
  withdraw 1; delegatecall/selfdestruct/permit 0) match the saved JSON;
  overall verdict BLOCK (Gates 3–4) — all confirmed.
- **hashstone.md** — NFT `0x00fb…9bf4`, Market `0xd440…38dc`, Agent-ID
  registry `0x60B9…022F`; both Exact Match at `2026-10-27T13:48:49Z`; owner
  EOA `0xa67b…7d69`; `royaltyBps` 400 (4%); PoW target
  `6901746346790563787434755862277025452451108972170386555162524223799296`
  (~2²⁴ work); nonces 1043103 and 14029342; first attempt reverted (gas
  294,808); total gas 3 txs 0.0000621 BNB (≈ $0.05); ticket 8303 → crystal
  #8028 (Common), ticket 8414 → crystal #9029 (Common); pool sold out
  01:44:25 WIB; whitepaper §8 admin disclosure; scanner project counts
  quoted in the file match the saved JSON — all confirmed. Verdict ALLOW.
- **termix.md** — package `termix-agent.skill` v1.11.1; sha256
  `227b1b4e559eef7e67fd25fba9b2d1d5560fc1fdc434620ff9d6c270f685c673`
  (matches the audited pin and the partner's device download,
  character-for-character); S3 `Last-Modified` Tue 27 Oct 2026 11:34 UTC;
  unpinned `?v=latest` distribution; updater verifies zip sha256 against an
  operator-served, unsigned manifest; identity order linked › agentic ›
  key; `WALLET_KEY` read only in explicit `key` mode; Binance Agent ID
  documented in-package (no ERC-8004 mint, payout to the ID holder, free
  activation) — all confirmed. Verdict WARN → ALLOW-WITH-PIN.

---

## 4. Remaining known limitations

1. **Counts are raw text occurrences** (code + comments + strings), never
   attributions — by design, and stated in the tool's disclaimer. Known
   noise sources: `permit` is case-insensitive, so EIP-712 type/struct
   names or prose containing "Permit" count too; `withdraw[A-Za-z0-9_]*`
   also matches `withdrawal`; standard interface functions inside a
   project's *own* token contract count as surface evidence.
2. **Project/library split is path-based**: only `node_modules/…` counts as
   library. A single flattened file (the Nonce case) puts *every* contract
   in "project", so surface counts there are per-file, not per-contract —
   the scanner cannot attribute contracts inside one compilation unit; the
   case files carry that attribution manually.
3. **Setter detection is narrow**: only `function setX(…)` declarations are
   listed. Admin mutators with other names (`updatePrice`, `changeFee`,
   `setPaused`-style toggles not starting with "set"+uppercase, public
   state-variable writers) are missed.
4. **Verdict scope is deliberately thin**: Gate 2 escalates only on
   unverifiable code and project-source `delegatecall` / `selfdestruct` /
   `permit`. Dangerous *combinations* of surface/admin patterns (e.g.
   `onlyOwner` × `withdraw` over user funds) still return ALLOW with the
   evidence attached — the human/agent audit remains the decider, exactly
   as the README states.
5. **`partial_match` is treated as verified** (the match type is reported
   verbatim in the output). AEGIS prefers Exact Match, but the CLI does
   not downgrade a partial match on its own.
6. **Sourcify is the trust anchor**: the tool trusts Sourcify's match and
   the sources it returns at query time; it does not independently compare
   runtime bytecode or pin a block height. A Sourcify outage/rate-limit now
   fails loudly (Fix 1) — the caller must retry; there is no built-in
   retry or second source (e.g. BscScan) yet.
7. **Availability of `AbortSignal.timeout`** assumes Node ≥ 18, as
   documented in the README requirements.

---

## 5. Perbaikan v0.2.0

**Date:** 29 Oct 2026 (WIB). Two follow-up fixes to `check-contract.mjs`
(v0.1.1 → v0.2.0), addressing limitations 5 and 6 above. Limitations 1–4
and 7 are unchanged and still apply verbatim.

### Fix A — Sourcify lookup resilience (limitation 6, narrowed)

- **Bounded retry:** the Sourcify v2 lookup now retries transient failures
  (network errors, HTTP 429, HTTP 5xx) up to **3 attempts total** with
  short backoff (500 ms, then 1500 ms). Definitive answers — 200
  (verified) and 404 (not verified) — are never retried; other 4xx (e.g.
  400 unsupported chain) still fail immediately. If retries are exhausted
  the tool fails loudly (`Sourcify request failed after 3 attempts … no
  verdict issued; retry later`, clean JSON on stderr, exit 1). The v0.1.1
  guarantee is preserved: a transient failure can never fabricate a
  BLOCK/ALLOW verdict. Each report now records
  `verification.lookup.attempts`.
- **Second source — evaluated, none viable keyless (yet):** Blockscout's
  BSC API returns a blanket `404` for every route (instance broken);
  Sourcify API v1 is removed (its repo endpoints answer "API v1 is
  removed. Use API v2."); Routescan does not support chain 56; GoPlus
  `token_security` only indexes ERC-20 tokens (empty result for NFT /
  general contracts); BscScan and Etherscan require API keys. Per the
  audit's fail-honest rule, the tool does **not** pretend to cross-check:
  every report carries `verification.crossCheck.status: "unavailable"`
  with the reason, ready to plug a real second source into when one
  becomes viable. Sourcify therefore remains the single trust anchor —
  limitation 6 is narrowed (no more one-shot fragility), not closed.

### Fix B — `partial_match` downgraded to WARN (limitation 5, closed)

A Sourcify `partial_match` is no longer treated as fully verified. It
forces **WARN** with an explicit reason (the source is not a
byte-for-byte match for the deployed contract; an exact match or a manual
bytecode-level review is required before execution). `exact_match`
behavior is unchanged, and the match type is still reported verbatim in
`verification.match`.

### Regression battery (v0.2.0)

Live against Sourcify, plus a mocked-response harness for the cases the
live API cannot produce on demand (no real BSC `partial_match` contract
could be found in Sourcify's recent or oldest chain-56 listing windows —
partials are rare there — so the verdict function was tested against a
local stub server returning crafted v2 responses to an unmodified copy of
the CLI pointed at the stub):

| Case | Expected | v0.2.0 |
|---|---|---|
| Hashstone NFT `0x00fb…9bf4` | ALLOW | ✅ exact_match, **ALLOW**, counts identical to v0.1.1 |
| Nonce FreeMint `0x7538…a17e` | ALLOW (Gate 2) | ✅ exact_match, **ALLOW**, counts identical, setters `["setPaused"]` |
| Agentic Pixels set-1 `0xd861…e2A` | BLOCK (404) | ✅ `verified: false`, **BLOCK**, exit 0 |
| Hashstone $ATOMS `0xfbd0…2d57` | ALLOW | ✅ exact_match, **ALLOW**, clean (onlyOwner 1, no setters) |
| Invalid address `0x123` | clean error | ✅ JSON usage error, exit 1 |
| Zero address | BLOCK, no crash | ✅ **BLOCK**, exit 0 |
| chainId `999999` (regression F8) | clean error | ✅ HTTP 400 → JSON error, exit 1, no fabricated BLOCK |
| Mock: `partial_match`, clean source | WARN (new) | ✅ **WARN**, sole reason = the partial-match downgrade |
| Mock: 503, 503, then 200 exact_match | ALLOW, attempts = 3 | ✅ **ALLOW**, `lookup.attempts: 3` |
| Mock: persistent 503 | clean error, no verdict | ✅ JSON error after 3 attempts, exit 1 |

---

## 6. Build 1 Nov 2026 — Gates 1, 3, 4 implemented (v1.0.0)

**Date:** 1 Nov 2026 (WIB), inside the official build window. The three
scaffolds prepared 31 Oct 2026 are now full implementations in the kit
directory: `check-provenance.mjs`, `check-signature.mjs`,
`check-instructions.mjs`, each at version 1.0.0, plain Node ≥ 18, zero
dependencies, same CLI/report conventions as Gate 2 (JSON report on
stdout, verdict under `verdict.gateN` with named reasons, operator
errors as JSON on stderr with exit 1, verdicts exit 0). Gate 2
(`check-contract.mjs`) is unchanged at v0.2.0. Nothing was pushed,
deployed, or submitted in this pass; the already-pushed public repo
still contains the scaffolds and must be re-synced before submission.

### Gate 1 — `check-provenance.mjs` (provenance)

Fetches the claimed official source and the independent source
(read-only GETs, bounded retry, Gate 2 fail-honest rule: transient
failure aborts with NO verdict; HTTP 404 is a definitive answer) and
checks the claim is actually carried by each — a caller-supplied URL
string alone is never accepted as proof. When the caller supplies the
project's official domains (`--registry`), the official host must match
one, checked before any fetch. The independent source must be on a
different host than the official one and is classified
(sourcify / explorer / other) as evidence. Verdicts: **BLOCK** — no
official source (relay-only/unattributed); official channel does not
carry the claim; official host fails the registry; or a record-style
independent URL (the claim is the record's identifier in its path)
does not contain the claim, i.e. the record contradicts it. **WARN** —
official confirms but independent confirmation is missing, not
genuinely independent, or did not confirm. **ALLOW** — official +
independent both confirm. Relay channels (`--relayed`) are recorded as
arrival evidence only.

### Gate 3 — `check-signature.mjs` (EIP-712 payload gate)

Full structural implementation of the signature SOP addendum. Decodes
and reports domain name / chainId / verifyingContract and the
primaryType. **BLOCK** — missing or unreadable domain name, chainId, or
verifyingContract; missing primaryType; primaryType is Permit /
PermitSingle / PermitBatch; a field named spender / value / amount
appears anywhere in the message OR in the declared types
(case-insensitive, recursive); verifyingContract is Permit2
(0x000000000022D473030F116dDEE9F6B43aC78BA3, built-in); or
verifyingContract is on the caller-supplied denylist (held token/NFT
contracts, routers, denied contracts — via `--context` JSON and/or
`--deny`). **WARN** — chainId differs from the caller-supplied expected
chain; domain.name not scoped to the caller-supplied project name;
declared types do not match the message fields; no types table
supplied; verifyingContract is the zero address. Checks that need
caller context are listed in the report as performed or skipped —
never silently assumed. Input is a JSON file path, `-`, or piped stdin
(stream-read; see the testing note below). The full payload is echoed
in the report: one failed check = stop and report the payload.

### Gate 4 — `check-instructions.mjs` (instruction channel)

The scaffold's six signal groups are kept and weighted by how directly
they move an agent toward execution: server-sign-submit 5,
external-server-connect 4, agent-install-script 4,
agent-addressed-instruction 2, false-authority 2, manufactured-urgency
1. Score = Σ hits × weight; **BLOCK ≥ 8, WARN ≥ 3**, plus two hard
rules: server-sign-submit together with external-server-connect is a
BLOCK at any score (the Nonce shape), and a detected
challenge→sign→submit sequence (obtain / sign / submit stages anywhere
in the text) is a BLOCK. Every hit is reported with line-numbered
excerpts; multi-word phrases match across line breaks (`\s+` between
tokens — the Nonce case file wraps "sign the login⏎challenge"), and a
cross-line hit falls back to an excerpt of the matched text itself
(`line: null`). Calibration on the kit's own anchors: `cases/nonce.md`
scores 15 → **BLOCK** (all three BLOCK paths fire), a benign docs page
scores 0 → **ALLOW**, an urgency-only page scores 7 → **WARN**. Input
is a local text file or stdin; URL fetching is deliberately not built
in (see limitation 12).

### Test battery — `tests/run-tests.mjs`

34 checks, all passing (run 1 Nov 2026, ~11 s; fixtures in
`tests/fixtures/`):

- **Gate 2 regression (no changes to the tool):** the §2/§5 battery
  re-run live — Hashstone NFT ALLOW exact_match, Nonce FreeMint ALLOW,
  Hashstone $ATOMS ALLOW, Agentic Pixels unverified BLOCK, zero address
  BLOCK, invalid/no-arg/bad-chainId usage errors exit 1, unsupported
  chain exits 1 with no fabricated verdict — plus the v0.2.0 mock cases
  against a local stub (partial_match → WARN; 503,503,200 → ALLOW with
  `lookup.attempts: 3`; persistent 503 → exit 1, no verdict).
- **Gate 4:** Nonce case file BLOCK (sequence detected; first
  external-server-connect excerpt at line 71), benign fixture ALLOW,
  urgency fixture WARN, stdin input BLOCK.
- **Gate 3:** ERC-2612 Permit fixture BLOCK (forbidden fields spender +
  value named); Permit2 verifyingContract fixture BLOCK (classified
  `permit2`); benign project-scoped SignIn fixture ALLOW *because every
  rule passes* (domain complete, non-Permit type, no forbidden fields,
  verifyingContract neither Permit2 nor denied, chainId 56 = expected
  56, domain name = supplied project name, types match message); the
  same payload against expected chain 1 WARNs (chainId mismatch);
  caller-denylist verifyingContract BLOCKs; stdin input ALLOW.
- **Gate 1 (local stub pages):** official + independent (different
  host, registry match) ALLOW; relay-only BLOCK; official page not
  carrying the claim BLOCK; independent Sourcify-shaped record
  returning `match: null` for the claimed address BLOCK (contradiction);
  official-only WARN; official host outside the supplied registry
  BLOCK.

Testing note: stdin is read by stream iteration in Gates 3/4. In this
environment (Node 24) a child process fed via `execFile`'s `input`
option never observes stdin EOF and hangs — reproduced with a one-line
stdin-echo child, so it is a runtime/harness quirk, not a tool defect;
shell pipes and `spawn` deliver EOF correctly, and the test harness
uses `spawn` for its stdin cases.

### Remaining known limitations — additions (items 1–7 unchanged)

Limitations 1–4, 6 (as narrowed by v0.2.0) and 7 in §4 still apply
verbatim to Gate 2; limitation 5 stays closed. The new gates add:

8. **Gate 1 "claim found" is a content heuristic**, not semantic
   attribution: substring match, or record-existence for record-style
   URLs. A page that mentions an address in a warning still "carries"
   it. A human/agent must still confirm the claim's ROLE (mint
   contract? warning example?) before acting.
9. **Gate 1 does not discover official channels.** Whoever supplies the
   "official" URL frames the check; without a caller-supplied domain
   registry, a lookalike domain carrying the same claim would pass the
   content test (the report states on every run when no registry was
   supplied). The registry + independent-confirmation requirements
   mitigate, not eliminate, this.
10. **Gate 3 is structural only.** It verifies no signature, recovers
    no signer, and cannot prove a verifyingContract really belongs to
    the project. Held/router classification is only as complete as the
    caller-supplied lists — only Permit2 is built in; a hostile
    contract on no list passes classification, with domain-scope and
    chain checks as backstops only when the caller supplies that
    context. An ALLOW never replaces building and simulating the final
    transaction separately (SOP step 4, outside this gate by design).
11. **Gate 3 types/message mismatch is WARN, not BLOCK** — deliberate
    (wallets sign the declared types; undeclared message fields are
    not signed), but the warning must actually be read.
12. **Gate 4 remains regex/heuristic screening.** Paraphrased,
    obfuscated, image-carried, or non-English instructions can evade
    it; thresholds are calibrated on the kit's own cases, not a broad
    labelled corpus; and text DISCUSSING these patterns scores like
    text using them (stated in every report's disclaimer). URL/package
    fetching is not implemented — input is a local file or stdin, so
    whoever fetches the page controls its freshness.

---

## 7. Build 1 Nov 2026 — unified runner `aegis.mjs` (v1.0.0)

**Date:** 1 Nov 2026 (WIB), inside the official build window. One entry
point now runs whichever gates the supplied inputs allow and merges
them into a single report carrying an anchor-ready hash. Plain
Node ≥ 18, zero dependencies, same conventions as the gates (JSON
report on stdout, JSON errors on stderr, exit 1 on usage errors).
Nothing was pushed, deployed, anchored, or submitted in this pass;
the already-pushed public repo still contains the starter kit and
must be re-synced before submission (it has neither the v1.0.0 gates
nor this runner yet).

### Composition

- **Gate 1** applies with `--claim` (plus `--official`,
  `--independent`, `--registry`, `--relayed` — identical semantics to
  `check-provenance.mjs`); **Gate 2** with `--contract` (+ `--chain`);
  **Gate 3** with `--typed-data` (plus `--context`,
  `--expected-chain`, `--project-domain`, `--deny` — identical
  context semantics to `check-signature.mjs`); **Gate 4** with
  `--brief`. A gate without its primary input is **SKIPPED**, with
  the reason recorded; running with no gate input at all is a usage
  error (exit 1, no report).
- Gates 1/3/4 are imported from their modules (Gate 2 has no library
  interface, so it is invoked as the `check-contract.mjs` CLI and its
  stdout JSON parsed — gate internals are never duplicated).
- A gate that was applicable but errored or returned no verdict —
  transient fetch failure, malformed typed-data JSON, the Gate 2 CLI
  exiting non-zero — is reported as **NO_VERDICT** with the reason.
  Fail-honest, as everywhere in the kit: a gate that could not run is
  never silently passed.

### Merge rule

The overall verdict is the **worst** verdict among gates that
produced one (BLOCK > WARN > ALLOW). If any applicable gate is
NO_VERDICT, the overall verdict **may not be ALLOW**: it is capped
at WARN and the report carries `overall.incomplete: true` with the
reasons. SKIPPED gates affect neither the merge nor completeness.
If no applicable gate produced a verdict, the overall verdict is
NO_VERDICT; the report is still printed (with its hash) and the
runner exits 1 so no automation can mistake it for a completed
check. The rule is stated in the `aegis.mjs` header, in every
report's `overall.rule` field, and here.

### reportHash — canonical form

SHA-256 (Node built-in `crypto`) over the canonical serialization
of the report body: JSON with object keys sorted recursively
(UTF-16 code-unit order), arrays in order, no insignificant
whitespace, hashed as UTF-8. Exactly two volatile fields are
excluded from the hashed body: **`generatedAt`** (the runner's
wall-clock timestamp) and **`reportHash`** itself. Everything else
is hashed — including the inputs summary, which binds the verdict
to its inputs via SHA-256 digests and byte counts of the
typed-data, brief, and context inputs. Re-running identical inputs
reproduces the identical hash (test R3); live-gate evidence
reflects its sources at run time, so a changed upstream source
legitimately changes the hash. This hash is the value the NEAR
testnet anchor step (separate, later) will register.

The report also prints a short human summary to **stderr** (overall
verdict + one line per gate + the hash; `--pretty` expands it to
every per-gate reason), keeping stdout pure JSON.

### Test battery — `tests/run-runner-tests.mjs`

11 checks, all passing (run 1 Nov 2026, ~3 s), in the same summary
style as `tests/run-tests.mjs`; the per-gate battery was re-run
unchanged afterwards: **34/34 still passing**.

- **R1–R3 (live Gate 2, SKIP-guarded if Sourcify is unreachable):**
  full-house Hashstone composition — Gate 1 against the local stub
  (official + independent confirmation), Gate 2 on the Hashstone
  NFT, Gate 3 benign SignIn fixture, Gate 4 benign fixture → all
  four gates VERDICT/ALLOW, overall **ALLOW**, `incomplete: false`;
  reportHash present (64-hex); **identical across two runs** on
  identical inputs (canonical body excludes only `generatedAt` /
  `reportHash`).
- **R4:** Nonce composition (Gate 4 on `cases/nonce.md` + Gate 3 on
  the Permit fixture) → overall **BLOCK**, both gates BLOCK,
  unrequested gates SKIPPED with reasons.
- **R5:** malformed typed-data JSON → Gate 3 **NO_VERDICT**,
  `incomplete: true`, overall capped at **WARN** despite a Gate 4
  ALLOW in the same run.
- **R6:** malformed typed-data as the only input → overall
  **NO_VERDICT**, exit 1, report + reportHash still printed.
- **R7:** no gate inputs → usage error, exit 1, no report.
- **R8:** Gate 2 against an unsupported chain (its CLI exits 1) →
  Gate 2 NO_VERDICT, overall capped at WARN next to a Gate 4 ALLOW.

### Remaining known limitations — addition

Limitations 1–12 are unchanged. The runner adds:

13. **The runner composes file inputs only, and its report is a
    digest, not the full evidence.** Stdin composition (supported
    by the Gate 3/4 CLIs individually) is not wired into the
    runner, and the merged report embeds per-gate verdicts,
    reasons, and curated evidence — not the gates' complete
    reports (run a gate's own CLI for its full output). The
    reportHash therefore binds the merged digest, not the
    underlying per-gate artifacts, whose own digests would need
    separate anchoring if byte-level evidence retention is ever
    required.

## 8. Build 1 Nov 2026 — NEAR testnet report-anchor registry (live)

The reportHash defined in §7 is now anchored on **NEAR testnet** by a
minimal registry contract, deployed and exercised end-to-end on
1 Nov 2026.

- **Contract / deployer account:** `aegis-gate.testnet` (the contract
  lives on the account itself; account created fresh for this purpose
  via the testnet faucet helper, funded with 10 testnet NEAR).
  Creation tx: `ARw8d8X7hRUZrALcgNbGq3j9abMnPRQHDyBNqyJcnEYJ`.
  Deploy tx: `FvkoM3vGrVX4xpQjxJ2LwCY8ydGNZWhyLjw6MZfWeZ5i`.
  On-chain `code_hash` `6pkAFiaNtLs7g62mwhZY5cSawVnUzXBfvp1GocLcwFf`
  equals base58(sha256(contract.wasm)) — deployment byte-verified.
  Source + tooling: `~/workspace/hackathon-near/near-anchor/`
  (`src/contract.ts`, `deploy.mjs`, `anchor.mjs`, project README).
- **Contract surface (deliberately minimal):** `record_anchor`
  (report_hash, verdict, agent_id) — validates a 64-char lowercase
  hex hash and an ALLOW/WARN/BLOCK verdict, stores the record with
  the caller (`anchored_by`) and block timestamp; **first write
  wins**, re-anchoring a hash returns the original record unchanged.
  Views: `get_anchor` (by hash), `anchor_count`. Anchoring is
  permissionless — there is no owner, no allowlist, and no admin
  power of any kind. No payable methods, no token handling; the
  contract holds no funds.
- **Anchored reports (both read back via public RPC `get_anchor`,
  round-trip exact):**
  - Nonce composition (Gate 4 brief + Gate 3 Permit fixture) —
    reportHash `7c7cf5b8979c312f790713f94e650e8d0b83c163570783b16ae171802122060f`,
    verdict **BLOCK**, agent `rainyy.ai`, anchor tx
    `CQWcvjoukVqBTfa74wRNNKpGtyRRYBv2LmaAzdH5jooo`,
    anchored 2026-11-01T03:59:17.960Z.
  - Hashstone Gate-2-only run (contract
    `0x00fbc656caa753a5280835bf9e849c4c0aff9bf4`, chain 56) —
    reportHash `79729980bfa8fe4ce1b4dde58766b65cba21987364473659190c744d66237d8d`,
    verdict **ALLOW**, agent `rainyy.ai`, anchor tx
    `FNwEp27ArWZtruwkbvMHJVjHjqkEzms99eZHBDs4gDfn`,
    anchored 2026-11-01T03:59:29.483Z.
  `anchor_count` after both: **2**.
- **What anchoring proves — and what it does not.** An anchor proves
  that a report with that exact hash existed at the recorded time
  and was submitted by the recorded account under the recorded agent
  identity. It does **not** prove the verdict is correct, that the
  gates ran honestly, or that the inputs were authentic — the same
  trust limits as the report itself (see §7, limitation 13: the hash
  binds the merged digest, not the full per-gate evidence). Anyone
  can re-run the kit on the same inputs, recompute the hash, and
  compare — that reproducibility, not the chain record alone, is
  the verification.
- **Limitations of this step (honest list, additions to §7):**
  14. **Testnet only, manual anchoring.** The registry lives on
      NEAR testnet (anchors carry no mainnet evidentiary weight),
      and anchoring is a separate manual step via `anchor.mjs` —
      the runner does not yet anchor automatically.
  15. **Deployer key custody is a local file.** The
      `aegis-gate.testnet` full-access key sits in the project
      directory's `.near-credentials/` (never committed, testnet
      funds only). Because anchoring is permissionless and records
      are first-write-wins, a leaked key could only spend the
      account's testnet balance or anchor additional reports under
      this account's name — it cannot alter existing anchors.

## 9. Addendum — repo re-sync and submission (6 Nov 2026)

The re-sync anticipated in §§6–7 was completed on 1 Nov 2026: the public
repo (github.com/Rainyy99/aegis, commit `954f5bfa40e7`) carries the full
v1.0 kit — all four gates, the runner, the anchor tooling and reports,
and the demo — blob-for-blob identical to the local staging tree
(re-verified 6 Nov 2026: 31/31). The project was submitted on 6 Nov 2026
with payout account `rainyy66.near` (mainnet, payout only); the demo post
is live from @aegisonnear. Nothing in §§1–8 was altered by this addendum.
