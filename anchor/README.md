# AEGIS anchor registry — NEAR testnet

A minimal NEAR **testnet** contract that anchors AEGIS verdict reports.
The AEGIS runner (`../aegis.mjs`, in the repository root) emits a JSON report with a
deterministic SHA-256 `reportHash`. Anchoring records that hash, the
overall verdict, and the agent identity in this registry, together with
the anchoring account and the block timestamp — so anyone can later
re-run the same inputs, recompute the hash, and check it against the
chain without trusting the machine that produced the report.

**An anchor proves a report with that hash existed at that time. It
does NOT prove the verdict is correct.**

## Live deployment (testnet)

| | |
|---|---|
| Contract / account | `aegis-gate.testnet` (contract deployed on the account itself) |
| Network | NEAR testnet (`https://rpc.testnet.near.org`) |
| Account creation tx | `ARw8d8X7hRUZrALcgNbGq3j9abMnPRQHDyBNqyJcnEYJ` (registrar `testnet`, 10 NEAR faucet funding) |
| Deploy tx | `FvkoM3vGrVX4xpQjxJ2LwCY8ydGNZWhyLjw6MZfWeZ5i` |
| Code hash (on-chain) | `6pkAFiaNtLs7g62mwhZY5cSawVnUzXBfvp1GocLcwFf` = base58(sha256(`build/contract.wasm`)) |
| Wasm sha256 | `017de37517371f102c922d68e54d7de6e972cfbcd164e8fd67e8c3fb051c7072` |

Anchored reports (verified by public-RPC read-back):

| Report | reportHash | Verdict | Anchor tx | Anchored at (UTC) |
|---|---|---|---|---|
| Nonce composition (Gate 4 + Gate 3) | `7c7cf5b8979c312f790713f94e650e8d0b83c163570783b16ae171802122060f` | BLOCK | `CQWcvjoukVqBTfa74wRNNKpGtyRRYBv2LmaAzdH5jooo` | 2026-11-01T03:59:17.960Z |
| Hashstone, Gate-2-only | `79729980bfa8fe4ce1b4dde58766b65cba21987364473659190c744d66237d8d` | ALLOW | `FNwEp27ArWZtruwkbvMHJVjHjqkEzms99eZHBDs4gDfn` | 2026-11-01T03:59:29.483Z |

The two runner reports themselves are kept in `reports/` in this
directory. Agent identity recorded for both: `rainyy.ai`.

## Contract (`src/contract.ts`)

Deliberately minimal and auditable:

- `record_anchor({ report_hash, verdict, agent_id })` — validates the
  hash (64-char lowercase hex SHA-256) and verdict (ALLOW / WARN /
  BLOCK), then stores `{ report_hash, verdict, agent_id, anchored_by,
  timestamp_ns }`. **First write wins**: re-anchoring the same hash
  returns the original record unchanged, so the original timestamp can
  never be rewritten.
- `get_anchor({ report_hash })` — view; the stored record or `null`.
- `anchor_count()` — view; total anchors recorded.

Anchoring is **permissionless by design**: no owner, no allowlist, no
admin powers. The caller's account id is stored in every record
(`anchored_by`), so provenance is on-chain. There are no payable
methods and no token handling; the contract holds no funds.

## How to anchor a new report

```bash
cd anchor   # from the repository root
# 1. Produce a report with the kit runner (any gate composition):
node ../aegis.mjs --contract 0x<address> --chain 56 > report.json
#    read the reportHash and overall.verdict fields from report.json
# 2. Record the anchor (signs with the project-local testnet key):
node anchor.mjs record <reportHash> <ALLOW|WARN|BLOCK> <agentId>
# 3. Read it back / check totals:
node anchor.mjs get <reportHash>
node anchor.mjs count
```

## How to verify an anchor with nothing but public RPC

```bash
ARGS=$(python3 -c "import json,base64;print(base64.b64encode(json.dumps({'report_hash':'<reportHash>'}).encode()).decode())")
curl -s -X POST https://rpc.testnet.near.org -H 'Content-Type: application/json' -d "{
  \"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"query\",
  \"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",
              \"account_id\":\"aegis-gate.testnet\",\"method_name\":\"get_anchor\",
              \"args_base64\":\"$ARGS\"}}"
```

The `result.result` byte array decodes to the stored anchor JSON.
Compare its `report_hash` / `verdict` against a fresh runner report on
the same inputs.

## Build / deploy (for reference)

```bash
npm install            # inside anchor/ — near-sdk-js (build), near-api-js (scripts)
npm run build          # -> build/contract.wasm   (build/ is a local artifact and is
                       #    not committed; on the build VM this also needed
                       #    TAR_OPTIONS=--no-same-owner so the SDK's binaryen
                       #    untar doesn't fail)
node deploy.mjs        # deploys to aegis-gate.testnet and verifies the code hash
```

## Account & key custody

**Credentials are never committed to this repository.** No
`.near-credentials/` directory, key file, seed phrase, or `.env` is
part of this repo — the scripts read the signing key from a local
credential file at runtime (see `lib.mjs`), and that file exists only
on the operator's machine. What follows describes that off-repo
arrangement for transparency:

- Deployer account `aegis-gate.testnet` was created fresh for this
  purpose via the testnet faucet helper (`helper.testnet.near.org`;
  the near-cli-rs sponsor flow's endpoint `helper.nearprotocol.com`
  hung through this VM's egress proxy, so the creation was completed
  by POSTing the same helper API on the testnet host with the
  CLI-generated keypair — creation tx above).
- The full-access key lives ONLY in `.near-credentials/testnet/` in
  this directory (git-ignored, `chmod 600`). It controls testnet
  faucet funds only. Musa's mainnet account `rainyy66.near` is
  payout-only and is never touched by anything here.
- Env overrides for the scripts: `NEAR_ACCOUNT_ID`, `NEAR_CONTRACT_ID`,
  `NEAR_RPC_URL`.
