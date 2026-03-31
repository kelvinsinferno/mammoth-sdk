# @mammoth-protocol/sdk

**Solana-native cycle-driven token issuance SDK for Mammoth Protocol.**

Mammoth Protocol is a token issuance framework for founders and builders who need multi-stage capital formation — not a one-shot meme launch. Tokens are issued through discrete, bounded minting cycles with rights-based anti-dilution for existing holders. Each cycle has a defined supply cap, a bonding curve (Step, Linear, or Exp-Lite), and a rights window where existing holders participate before the public.

This SDK wraps the Mammoth Anchor program for programmatic access — designed for AI agents, automation scripts, and developers who need to interact with Mammoth Protocol without a UI.

---

## Installation

```bash
npm install @mammoth-protocol/sdk
```

**Peer dependencies (install separately):**
```bash
npm install @coral-xyz/anchor @solana/web3.js @solana/spl-token
```

---

## Quick Start

```js
const { MammothClient } = require('@mammoth-protocol/sdk');
const { Connection, Keypair } = require('@solana/web3.js');

// 1. Set up connection
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// 2. Set up wallet (must have publicKey + signTransaction + signAllTransactions)
const keypair = Keypair.generate(); // or load from file
const wallet = {
  publicKey: keypair.publicKey,
  signTransaction: async (tx) => { tx.sign(keypair); return tx; },
  signAllTransactions: async (txs) => txs.map(tx => { tx.sign(keypair); return tx; }),
};

// 3. Create client
const client = new MammothClient({ connection, wallet, cluster: 'devnet' });

// 4. Create a project
const { mint, signature } = await client.createProject({
  supplyMode: 'fixed',
  totalSupply: 1_000_000_000,
  publicAllocationBps: 6000,  // 60% for public cycles
  creatorBps: 7000,           // 70% of SOL raised → creator
  reserveBps: 2000,           // 20% → reserve
  sinkBps: 1000,              // 10% → sink
});

console.log('Project created:', mint.toBase58());

// 5. Open first cycle
const { signature: cycleSig } = await client.openCycle(mint.toBase58(), {
  curveType: 'step',
  supplyCap: 100_000,
  startPrice: 0.001,       // SOL
  stepSize: 5000,          // tokens per step
  stepIncrement: 0.0002,   // SOL per step
  rightsWindowDuration: 86400, // 24h rights window in seconds
});

console.log('Cycle opened:', cycleSig);
```

---

## API Reference

### `new MammothClient({ connection, wallet, cluster })`

Creates a new client instance.

| Parameter | Type | Description |
|---|---|---|
| `connection` | `Connection` | Solana Connection instance |
| `wallet` | `object` | Wallet with `publicKey`, `signTransaction`, `signAllTransactions` |
| `cluster` | `'devnet' \| 'mainnet-beta'` | Default: `'devnet'` |

---

### Project Lifecycle

#### `client.createProject(params)` → `{ mint, signature, projectState }`

Deploy a new Mammoth project on-chain.

| Param | Type | Description |
|---|---|---|
| `supplyMode` | `'fixed' \| 'elastic'` | Fixed = hard cap at launch. Elastic = cap settable later. |
| `totalSupply` | `number` | Total token supply (base units, 6 decimals) |
| `publicAllocationBps` | `number` | BPS of total supply reserved for public cycles (e.g. 6000 = 60%) |
| `creatorBps` | `number` | BPS of SOL raised going to creator wallet |
| `reserveBps` | `number` | BPS of SOL raised going to reserve |
| `sinkBps` | `number` | BPS of SOL raised going to sink/burn |

Returns: `{ mint: PublicKey, signature: string, projectState: PublicKey }`

---

#### `client.openCycle(mintAddress, params)` → `{ signature, cycleIndex }`

Open a new minting cycle on an existing project.

| Param | Type | Description |
|---|---|---|
| `mintAddress` | `string` | Project mint address |
| `curveType` | `'step' \| 'linear' \| 'expLite'` | Bonding curve type |
| `supplyCap` | `number` | Token allocation for this cycle |
| `startPrice` | `number` | Starting price in SOL |
| `stepSize` | `number` | (Step only) Tokens per price step |
| `stepIncrement` | `number` | (Step only) SOL price increase per step |
| `endPrice` | `number` | (Linear only) Ending price in SOL |
| `growthFactorK` | `number` | (Exp-Lite only) Growth factor (e.g. 2.0) |
| `rightsWindowDuration` | `number` | Rights window in seconds (0 = no rights window) |

---

#### `client.closeCycle(mintAddress)` → `{ signature }`

Close the active cycle early. Creator-only.

---

#### `client.setHardCap(mintAddress, hardCapAmount)` → `{ signature }`

Set an irreversible hard cap on an Elastic supply project. **This action cannot be undone.**

| Param | Type | Description |
|---|---|---|
| `mintAddress` | `string` | Project mint address |
| `hardCapAmount` | `number` | Maximum total supply (must be ≥ current total minted) |

> ⚠️ **Irreversible.** Once called, supply can never exceed `hardCapAmount`. Ensure this is intentional before calling.

---

### Trading

#### `client.buyTokens(mintAddress, amount)` → `{ signature, solIn, tokensOut }`

Buy tokens from the active cycle.

| Param | Type | Description |
|---|---|---|
| `mintAddress` | `string` | Project mint address |
| `amount` | `number` | Number of tokens to buy |

---

#### `client.exerciseRights(mintAddress, amount)` → `{ signature, amount }`

Exercise rights allocation during a rights window.

---

### Queries (no wallet required)

#### `client.fetchProject(mintAddress)` → `ProjectState | null`

Fetch a single project by mint address.

#### `client.fetchAllProjects()` → `ProjectState[]`

Fetch all Mammoth projects from on-chain.

#### `client.fetchCycle(mintAddress, cycleIndex)` → `CycleState | null`

Fetch a specific cycle by index.

#### `client.fetchHolderRights(mintAddress, holderAddress)` → `HolderRights | null`

Fetch rights allocation for a specific holder in the current cycle.

#### `client.getBalance(address)` → `number`

Get SOL balance for an address (in SOL, not lamports).

---

### Utilities

#### `client.computePrice(cycleState)` → `number`

Compute current token price in SOL from a cycle state object. Pure function — no RPC call.

#### `client.computeBuyQuote(cycleState, solIn)` → `QuoteResult`

Compute buy quote for a given SOL amount. Returns `{ tokensOut, effectivePrice, fee, newPrice, nextStepIn, remainingAfter }`. Pure function.

#### `client.checkOperatorPermission(mintAddress, operatorAddress, instruction)` → `boolean`

> ⚠️ **STUB** — Requires TASK-AI-004 AuthorityConfig implementation. Currently always returns `true`. Will enforce on-chain permission bitmap once AuthorityConfig is deployed.

---

## Agent Integration Examples

### Example 1: AI Agent Launches a New Token Project

```js
const { MammothClient } = require('@mammoth-protocol/sdk');
const { Connection } = require('@solana/web3.js');

async function agentLaunchProject(agentWallet, projectConfig) {
  // Agent receives a project brief and deploys it on Mammoth
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const client = new MammothClient({ connection, wallet: agentWallet });

  console.log('[agent] Creating project:', projectConfig.name);

  // Step 1: Check the agent has permission to create projects
  // (Full permission check requires TASK-AI-004 AuthorityConfig)
  const hasPermission = await client.checkOperatorPermission(null, agentWallet.publicKey, 'createProject');
  if (!hasPermission) {
    throw new Error('[agent] Insufficient authority to create project. Escalating to principal.');
  }

  // Step 2: Deploy the project on-chain
  const { mint, signature } = await client.createProject({
    supplyMode: projectConfig.supplyMode || 'elastic',
    totalSupply: projectConfig.totalSupply || 1_000_000_000,
    publicAllocationBps: projectConfig.publicAllocationBps || 6000,
    creatorBps: projectConfig.creatorBps || 7000,
    reserveBps: projectConfig.reserveBps || 2000,
    sinkBps: projectConfig.sinkBps || 1000,
  });

  console.log('[agent] Project deployed. Mint:', mint.toBase58());
  console.log('[agent] Transaction:', signature);

  // Step 3: Report back to principal with result
  return {
    success: true,
    mint: mint.toBase58(),
    signature,
    message: `Project deployed. Ready to open Cycle 1.`,
  };
}
```

---

### Example 2: AI Agent Opens a Cycle with Specific Parameters

```js
async function agentOpenCycle(agentWallet, mintAddress, cycleParams) {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const client = new MammothClient({ connection, wallet: agentWallet });

  // Step 1: Fetch current project state
  const project = await client.fetchProject(mintAddress);
  if (!project) throw new Error(`[agent] Project not found: ${mintAddress}`);

  console.log('[agent] Current cycle:', project.currentCycle);
  console.log('[agent] Opening Cycle', project.currentCycle + 1);

  // Step 2: Check permission to open cycles
  const hasPermission = await client.checkOperatorPermission(mintAddress, agentWallet.publicKey, 'openCycle');
  if (!hasPermission) {
    // Agent must escalate — cannot proceed autonomously
    return { success: false, escalate: true, reason: 'InsufficientAuthority:openCycle' };
  }

  // Step 3: Open the cycle
  const { signature, cycleIndex } = await client.openCycle(mintAddress, {
    curveType: cycleParams.curveType || 'step',
    supplyCap: cycleParams.supplyCap,
    startPrice: cycleParams.startPrice,
    stepSize: cycleParams.stepSize,
    stepIncrement: cycleParams.stepIncrement,
    rightsWindowDuration: cycleParams.rightsWindowHours
      ? cycleParams.rightsWindowHours * 3600
      : 0,
  });

  console.log(`[agent] Cycle ${cycleIndex} opened. Signature: ${signature}`);

  return { success: true, cycleIndex, signature };
}
```

---

### Example 3: AI Agent Monitors a Cycle and Decides When to Close It

```js
async function agentMonitorCycle(agentWallet, mintAddress, closingThreshold = 0.95) {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const client = new MammothClient({ connection, wallet: agentWallet });

  // Agent polls cycle state and closes when threshold is met
  const POLL_INTERVAL_MS = 30_000; // check every 30 seconds

  while (true) {
    const project = await client.fetchProject(mintAddress);
    if (!project || project.currentCycle === 0) {
      console.log('[agent] No active cycle found. Waiting...');
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const cycle = await client.fetchCycle(mintAddress, project.currentCycle - 1);
    if (!cycle || cycle.status?.closed !== undefined) {
      console.log('[agent] Cycle is already closed.');
      return { closed: true, reason: 'already_closed' };
    }

    const pctSold = cycle.minted / cycle.supplyCap;
    const currentPrice = client.computePrice(cycle);

    console.log(`[agent] Cycle ${project.currentCycle}: ${(pctSold * 100).toFixed(1)}% sold at ${currentPrice.toFixed(6)} SOL`);

    if (pctSold >= closingThreshold) {
      console.log(`[agent] Threshold reached (${(closingThreshold * 100)}%). Closing cycle.`);

      // Check permission before acting
      const hasPermission = await client.checkOperatorPermission(mintAddress, agentWallet.publicKey, 'closeCycle');
      if (!hasPermission) {
        return { success: false, escalate: true, reason: 'InsufficientAuthority:closeCycle' };
      }

      const { signature } = await client.closeCycle(mintAddress);
      console.log('[agent] Cycle closed. Signature:', signature);
      return { success: true, signature, pctSold };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
```

---

### Example 4: AI Agent Checks Permissions Before Acting

```js
async function agentCheckAndAct(agentWallet, mintAddress, action, params) {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const client = new MammothClient({ connection, wallet: agentWallet });

  // Always check permission before irreversible or high-impact actions
  const hasPermission = await client.checkOperatorPermission(
    mintAddress,
    agentWallet.publicKey,
    action
  );

  if (!hasPermission) {
    // Agent cannot proceed — must report back to its principal
    console.warn(`[agent] No permission for '${action}'. Reporting to principal.`);
    return {
      success: false,
      escalate: true,
      action,
      reason: `InsufficientAuthority: operator not permitted to call '${action}' on ${mintAddress}`,
      requestedBy: agentWallet.publicKey.toBase58(),
    };
  }

  // Proceed with the action
  switch (action) {
    case 'openCycle':
      return client.openCycle(mintAddress, params);
    case 'closeCycle':
      return client.closeCycle(mintAddress);
    case 'buyTokens':
      return client.buyTokens(mintAddress, params.amount);
    case 'setHardCap':
      // Extra warning — this is irreversible
      console.warn('[agent] setHardCap is IRREVERSIBLE. Proceeding only because principal explicitly granted this permission.');
      return client.setHardCap(mintAddress, params.hardCapAmount);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
```

---

## Error Handling

All methods throw `MammothError` on failure:

```js
const { MammothError, ErrorCode } = require('@mammoth-protocol/sdk');

try {
  await client.buyTokens(mintAddress, 1000);
} catch (err) {
  if (err instanceof MammothError) {
    console.error('Mammoth error:', err.code, err.message);
    // err.code is one of ErrorCode.*
    // err.message is human-readable
  } else {
    throw err; // re-throw unknown errors
  }
}
```

**Error codes:**

| Code | Meaning |
|---|---|
| `UNAUTHORIZED` | Caller is not authorized |
| `HARD_CAP_ALREADY_SET` | set_hard_cap called twice |
| `NOT_ELASTIC_MODE` | set_hard_cap on fixed-supply project |
| `NOT_RIGHTS_WINDOW` | exerciseRights called outside rights window |
| `RIGHTS_WINDOW_EXPIRED` | Rights window has closed |
| `EXCEEDS_RIGHTS_ALLOCATION` | Amount exceeds rights allocation |
| `NOT_ACTIVE` | buy/close called on non-active cycle |
| `SUPPLY_CAP_EXCEEDED` | Attempted to buy beyond cycle cap |
| `MATH_OVERFLOW` | On-chain arithmetic overflow |
| `ZERO_AMOUNT` | Amount must be > 0 |
| `NETWORK_ERROR` | RPC or network failure |
| `UNKNOWN` | Unrecognized error |

---

## Constants

```js
const { PROGRAM_ID, DEVNET_RPC, MAINNET_RPC } = require('@mammoth-protocol/sdk');

// Program ID (Devnet)
console.log(PROGRAM_ID.toBase58());
// → DUnfGXcmPJgjSHvrPxeqPPYjrx6brurKUBJ4cVGVFR31

// RPC endpoints
console.log(DEVNET_RPC);   // https://api.devnet.solana.com
console.log(MAINNET_RPC);  // https://api.mainnet-beta.solana.com
```

---

## Authority Delegation (Coming: TASK-AI-004)

The `checkOperatorPermission` method is currently a stub. The full **AuthorityConfig** system — on-chain permission delegation for AI agents — is being implemented in TASK-AI-004.

When complete, it will allow a **principal** (human wallet, DAO, or AI controller) to configure exactly what operations an **operator** (AI agent wallet) can perform autonomously:

- `can_open_cycle` — agent can open cycles without approval
- `can_close_cycle` — agent can close cycles autonomously
- `can_set_hard_cap` — agent can set hard cap (off by default — must be explicitly granted)
- `spending_limit` — max SOL raise per cycle before escalation required

Until TASK-AI-004 is deployed, `checkOperatorPermission` returns `true` for all calls.

---

## Project Links

- **Web app:** https://mammoth-protocol.vercel.app
- **AI reference:** https://mammoth-protocol.vercel.app/ai-reference
- **Learn:** https://mammoth-protocol.vercel.app/learn
- **Whitepaper:** https://mammoth-protocol.vercel.app/whitepaper
- **GitHub:** https://github.com/kelvinsinferno/mammoth

---

## License

MIT — Kelvinsinferno Studio
