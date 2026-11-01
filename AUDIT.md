# AEGIS starter kit — QA / audit pass

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
