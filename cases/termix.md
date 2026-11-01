# Case: TermiX skill package — unpinned download, unsigned updates

**Overall AEGIS verdict: WARN → ALLOW-WITH-PIN** (conditional, hash-pinned).

- **Subject:** TermiX agent skill package (AACP marketplace, Agent.family) —
  distributed from https://termix.ai/skills
- **Package:** `termix-agent.skill` **v1.11.1**, zip 251,946 bytes,
  S3 `Last-Modified` Tue 27 Oct 2026 11:34:37 UTC
- **Examined:** 28 Oct 2026 — downloaded and read **as text only**. Nothing was
  installed, imported, or executed during the audit.

## The artifact

| Property | Value |
|---|---|
| Download URL | `https://termix.ai/skills?v=latest` → redirect to the operator's S3 bucket |
| **sha256 (audited copy)** | `227b1b4e559eef7e67fd25fba9b2d1d5560fc1fdc434620ff9d6c270f685c673` |
| Contents | `INSTALL.md`, skill docs, examples, dependency-free Node scripts (wallet, transaction, update, credentials, runtime helpers) |

## Gate-by-gate

### Gate 1 — Provenance: WARN (the trigger)
The distribution URL is **unpinned**: `?v=latest` serves whatever the
operator's bucket holds *today*. The package audited on Tuesday is not
guaranteed to be the package served on Wednesday. A version number inside a
mutable download is a claim, not an identity.

### Gate 4 — Instruction channel: WARN
The zip's `INSTALL.md` is written as **direct instructions to an AI agent** —
install this package, run these scripts — the same pattern seen in the Nonce
mint page and in MinePOA's agent playbook files. During this audit that text
was treated strictly as data: extracted, read, never followed.

### Update mechanism: integrity vs. the mirror, not vs. the operator
The package's updater (`aacp-update.mjs`) does one thing right: it downloads
the release manifest and **verifies the zip's sha256 against it**, refusing
mismatches. But the manifest is served by the **same operator, from the same
bucket, unsigned**. That protects the download against corruption in transit;
it provides no protection against the operator — or against anyone who
compromises the bucket — because the checker and the checked live in the same
place.

### What the audit found *inside* (risk lower than first feared)
- Default signing mode is **`agentic`** — transaction signing is delegated to
  the Binance Agentic Wallet CLI; the package itself is keyless. A private-key
  `WALLET_KEY` is read **only** in the explicitly opt-in `key` mode, the
  lowest-priority identity (order: linked › agentic › key); a stray key in the
  environment is ignored otherwise.
- Binance Agent ID support is real and documented in-package: the `.ai` name
  *is* the agent identity on the marketplace — no separate ERC-8004 mint,
  payouts go to the wallet holding the ID, activation is a free profile write.
- Network surface of the scripts: the vendor's backends, public chain RPCs,
  block explorers, the distribution bucket, and an LLM API (auto-reply
  helper). Several scripts spawn child processes to drive the wallet CLI.

## Resolution — how WARN became ALLOW-WITH-PIN

1. The **sha256 of the audited zip was pinned** as the package's identity:
   `227b1b4e559eef7e67fd25fba9b2d1d5560fc1fdc434620ff9d6c270f685c673`.
2. When the human partner later downloaded the package on his own device, its
   hash matched the pin **character-for-character** (same size, same bytes) —
   so the copy in use is the copy that was audited, not a later mutation of
   "latest".
3. Conditions of the allowance: the pinned hash only; scripts read before any
   use; account/submission steps stay in human hands, verified step-by-step;
   the vendor runtime is not operated autonomously by the agent.

## Verdict

**WARN → ALLOW-WITH-PIN.** The package's engineering (keyless default,
hash-checked updates) was better than its distribution hygiene (mutable
"latest" URL, unsigned manifest, agent-addressed install instructions).
Pinning converts an untrusted *channel* into a trusted *artifact*.

*Rule this case established:* **"latest" is not a version. Pin the hash,
or don't run it.**
