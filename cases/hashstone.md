# Case: Hashstone — verified freemint, direct on-chain

**Overall AEGIS verdict: ALLOW** — executed under SOP on 28 Oct 2026.

- **Subject:** Hashstone (https://hashstone.dev) — 9,999 "crystals", one per
  early Bitcoin block (blocks 1–9,999, Jan–Apr 2009; token ID = block height)
- **Chain:** BNB Smart Chain (chainId 56)
- **Gate:** holders of a `.ai` Agent ID (registry
  `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`)
- **Examined:** 27–28 Oct 2026 (site inspection, Sourcify verification,
  on-chain reads, full source read; then executed)

## Contracts (Gate 2 evidence)

| Role | Address | Sourcify |
|---|---|---|
| NFT | `0x00fbc656caa753a5280835bf9e849c4c0aff9bf4` | Exact Match (creation + runtime) |
| Market | `0xd440182bd99428488b7f1aacfbafafa86b1438dc` | Exact Match (creation + runtime) |

- Both verified at `2026-10-27T13:48:49Z`. Contract owner: a single EOA,
  `0xa67b71c518ae5b0f7c8267cd10ffbfc101597d69`; market fee / royalty 4%.
- Machine check: [`hashstone-contract-check.json`](hashstone-contract-check.json)
  (produced by `../check-contract.mjs`).

## Gate-by-gate

### Gate 1 — Provenance: PASS
Addresses were taken from the project's official site and independently
confirmed on Sourcify before any on-chain read was trusted.

### Gate 2 — Contract: PASS (admin surface noted, attributed)
Source read in full (`contracts/Hashstone.sol` + OpenZeppelin libraries):

- `mine(uint256 nonce)` requires: mint open, caller holds an Agent ID,
  `minesOf(caller) < 2` (max 2 per wallet). Value rule in code: **0 for the
  first mine**, `price()` for later ones — and `price()` read **0** on-chain,
  so both mines were free in fact, not just in marketing copy. (The ABI marks
  `mine` payable; the claim "free" was proven from `price()`, not assumed.)
- Proof-of-work is local and self-computable:
  `proofOf = sha256(abi.encodePacked("HASHSTONE", block.chainid, address(this), miner, nonce))`
  must beat a fixed target (~2²⁴ work). Tickets auto-reveal through a queue
  (DELAY = 2 blocks of subsequent mines).
- Scanner result on **project source**: `delegatecall` 0, `selfdestruct` 0,
  `permit` 0, `approve` 0, `setApprovalForAll` 0, `transferFrom` 0. The
  standard ERC-721 approval/transfer functions live only in the OpenZeppelin
  library files, where they belong.
- Evidence the audit had to attribute: `withdraw` 1× and 7× `onlyOwner`,
  with setters `setOpen`, `setPrice`, `setTarget`, `setBaseURI`,
  `setContractURI`, `setRoyalty`. All are owner-only admin over the
  *contract's own* parameters and balance — disclosed in the project's
  whitepaper (§8) — and none of them can pull user funds or rewrite a user's
  position. Accepted under SOP because the user-facing path is a value-0 call
  the agent constructs and simulates itself, with no approval or permit
  anywhere in it.

### Gate 3 — Signature: PASS
The flow requests **no off-chain signatures at all**. Nothing to decode
because there is nothing to sign — the cleanest possible outcome at this gate.

### Gate 4 — Instruction channel: PASS
Minting is a direct on-chain `mine(nonce)` call. The agent computes the PoW
nonce locally from the verified source, builds the calldata itself,
simulates, then broadcasts. The project also offers an optional MCP server —
it was **not used**; no page-written playbook drives any step.

## Execution record (under the standing SOP)

- `open() = TRUE` + `price() = 0` detected 01:19 WIB, 28 Oct 2026; the human
  partner connected the agent wallet after an alert.
- Two nonces computed locally (1043103, 14029342). First broadcast reverted in
  the reveal-queue rush (gas 294,808); the retry and the second mine
  succeeded. Total gas for 3 transactions: 0.0000621 BNB (≈ $0.05).
- Result: ticket 8303 → crystal **#8028** (Common), ticket 8414 → crystal
  **#9029** (Common); ownership verified via `ownerOf`. Quota 2/2 used.
- Pool sold out on-chain at 01:44:25 WIB the same night (`remaining() = 0`).

## Verdict

**ALLOW.** Verified code, a free and self-built user path, no signatures, no
server in the loop.

*Rule this case established:* **admin surface ≠ automatic block.** Owner
setters are evidence to attribute — what decides the verdict is whether the
user's own transaction can move the user's funds in any way the user did not
construct and simulate themselves.
