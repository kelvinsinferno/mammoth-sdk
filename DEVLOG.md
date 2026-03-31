# DEVLOG — @mammoth-protocol/sdk

**Date:** 2026-03-31
**Version:** 0.1.0
**Status:** ✅ Built — ready for internal use, not yet published to npm

---

## What Was Built

### Package structure
```
mammoth-sdk/
  src/
    index.js        — main exports (MammothClient + all named exports)
    client.js       — MammothClient class (full API surface)
    pdas.js         — PDA derivation helpers (all seeds from Anchor program)
    instructions.js — instruction builders wrapping anchorClient.js
    queries.js      — read functions (fetchAllProjects, fetchCycle, etc.)
    curves.js       — pure JS bonding curve math (Step/Linear/Exp-Lite)
    errors.js       — MammothError class + ErrorCode enum + parseTransactionError
    constants.js    — PROGRAM_ID, DEVNET_RPC, MAINNET_RPC
    idl/            — mammoth_core.json (copied from web app)
  package.json
  README.md         — full API reference + agent integration examples
  .gitignore
  DEVLOG.md (this file)
```

### Key design decisions

**1. Class-based API (`MammothClient`)**
Wraps all Anchor client functions behind a stateful class. Agent can instantiate once and call methods repeatedly without managing connection/program references manually.

**2. Plain JS with JSDoc**
No TypeScript — matches the web app codebase. JSDoc provides type hints for IDE support without a compilation step.

**3. Peer dependencies**
`@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token` are peer deps — they're large and likely already installed in the consumer's project.

**4. Pure curve math**
`curves.js` contains only math — no imports, no on-chain deps. An agent can compute price quotes without any RPC connection.

**5. `checkOperatorPermission` is a stub**
Included so agents know the interface exists and can write code against it now. Returns `true` until TASK-AI-004 implements AuthorityConfig on-chain. Clearly documented as a stub.

**6. Agent integration examples in README**
Four realistic examples covering the full lifecycle:
- Project creation
- Cycle opening with permission check
- Cycle monitoring + autonomous close
- Generic permission-gated action dispatcher

### Source references
All instruction logic copied/adapted from:
- `C:\Users\kelvi\Desktop\Kelvinsinferno studio\Mammoth\lib\anchorClient.js`
- `C:\Users\kelvi\Desktop\Kelvinsinferno studio\Mammoth\lib\curves.js`
- IDL from `C:\Users\kelvi\Desktop\Kelvinsinferno studio\Mammoth\lib\idl\mammoth_core.json`

---

## Known Limitations / TODOs

1. **Not published to npm** — needs `npm publish` when ready. Will need an npm org account for `@mammoth-protocol` scope.

2. **`checkOperatorPermission` is a stub** — always returns `true`. Full implementation requires TASK-AI-004 (AuthorityConfig on-chain account).

3. **No tests** — unit tests for pure functions (curves math, PDA derivation) would be straightforward to add. Integration tests require a local validator or Devnet.

4. **Wallet adapter abstraction** — currently expects a raw wallet object. A future version could support the `@solana/wallet-adapter` interface directly.

5. **No event listeners** — no WebSocket subscriptions for cycle state changes. Agents currently poll. A future version could expose `onCycleUpdate(mintAddress, callback)`.

6. **`fetchAllProjects` is expensive** — uses `getProgramAccounts` which fetches all program accounts. For production use, an indexer (Helius, Shyft) is recommended. Noted in query function JSDoc.

---

## Next Steps

- TASK-AI-003: Add `operatorType` field support to `createProject` params
- TASK-AI-004: Implement `checkOperatorPermission` against real AuthorityConfig account
- Publish to npm once mainnet is live
- Add unit tests for curves.js
- Add integration test script for Devnet

---

_Built: 2026-03-31 | SDK v0.1.0 | Mammoth Protocol_
