/**
 * monitor.js — Real-time event monitoring and bot-friendly query utilities
 *
 * Provides everything a bot or AI agent needs to watch Mammoth Protocol
 * without polling: event subscriptions via Anchor's program.addEventListener,
 * plus query helpers optimized for bot decision-making.
 *
 * Event subscription requires a WebSocket-capable connection (wss://).
 * Use Connection('wss://api.devnet.solana.com', 'confirmed') or a Helius/QuickNode WS endpoint.
 *
 * @example — Subscribe to cycle opens
 * const { MammothMonitor } = require('@mammoth-protocol/sdk');
 * const { Connection } = require('@solana/web3.js');
 *
 * const monitor = new MammothMonitor({
 *   connection: new Connection('wss://api.devnet.solana.com', 'confirmed'),
 * });
 *
 * monitor.onCycleOpen((event) => {
 *   console.log('New cycle:', event.projectMint.toBase58(), 'price:', event.basePrice.toString());
 *   // buy logic here
 * });
 *
 * monitor.start();
 * // later: monitor.stop();
 */

'use strict';

const { Program, AnchorProvider } = require('@coral-xyz/anchor');
const { PublicKey } = require('@solana/web3.js');
const { PROGRAM_ID } = require('./constants');
const { MammothError, ErrorCode } = require('./errors');
const { fetchAllProjects, fetchActiveCycle } = require('./queries');
const IDL = require('./idl/mammoth_core.json');

/**
 * MammothMonitor — event-driven interface for bots and AI agents.
 *
 * Wraps Anchor's addEventListener to surface Mammoth on-chain events
 * as clean JS callbacks. No polling. Fires exactly when something happens.
 */
class MammothMonitor {
  /**
   * @param {object} opts
   * @param {import('@solana/web3.js').Connection} opts.connection — WebSocket-capable connection
   * @param {object} [opts.wallet] — optional wallet (read-only if omitted)
   */
  constructor({ connection, wallet }) {
    if (!connection) throw new MammothError(ErrorCode.INVALID_PARAMS, 'connection is required');
    this.connection = connection;
    this.wallet = wallet || null;
    this._program = null;
    this._listeners = [];
  }

  /**
   * Get (or lazily init) the Anchor Program with a read-only provider.
   */
  _getProgram() {
    if (this._program) return this._program;
    const walletForProvider = this.wallet || {
      publicKey: PublicKey.default, // FIX SDK-20 regression: avoid null publicKey
      signTransaction: async (tx) => tx,
      signAllTransactions: async (txs) => txs,
    };
    const provider = new AnchorProvider(this.connection, walletForProvider, { commitment: 'confirmed' });
    this._program = new Program(IDL, provider);
    return this._program;
  }

  // ─── Event subscriptions ─────────────────────────────────────────────────

  /**
   * Subscribe to CycleOpened events.
   * Fires whenever a creator (or authorized operator) opens a new minting cycle.
   *
   * Event fields:
   *   projectMint: PublicKey
   *   projectState: PublicKey
   *   cycleIndex: number
   *   curveType: number (0=Step, 1=Linear, 2=ExpLite)
   *   supplyCap: BN
   *   basePrice: BN (lamports per token)
   *   rightsWindowEnd: BN (unix timestamp; 0 if no rights window)
   *   timestamp: BN
   *
   * @param {(event: object) => void} callback
   * @returns {number} listenerId — pass to removeListener to stop
   */
  onCycleOpen(callback) {
    const id = this._getProgram().addEventListener('CycleOpened', callback);
    this._listeners.push(id);
    return id;
  }

  /**
   * Subscribe to CycleActivated events.
   * Fires when a rights window expires and public buying opens.
   *
   * @param {(event: object) => void} callback
   * @returns {number} listenerId
   */
  onCycleActivated(callback) {
    const id = this._getProgram().addEventListener('CycleActivated', callback);
    this._listeners.push(id);
    return id;
  }

  /**
   * Subscribe to CycleClosed events.
   * Fires when a cycle closes (supply exhausted or creator closes early).
   *
   * @param {(event: object) => void} callback
   * @returns {number} listenerId
   */
  onCycleClose(callback) {
    const id = this._getProgram().addEventListener('CycleClosed', callback);
    this._listeners.push(id);
    return id;
  }

  /**
   * Subscribe to TokensPurchased events.
   * Fires on every public buy. Use for monitoring fill velocity.
   *
   * @param {(event: object) => void} callback
   * @returns {number} listenerId
   */
  onTokensPurchased(callback) {
    const id = this._getProgram().addEventListener('TokensPurchased', callback);
    this._listeners.push(id);
    return id;
  }

  /**
   * Subscribe to RightsExercised events.
   * Fires when a holder exercises rights during a rights window.
   *
   * @param {(event: object) => void} callback
   * @returns {number} listenerId
   */
  onRightsExercised(callback) {
    const id = this._getProgram().addEventListener('RightsExercised', callback);
    this._listeners.push(id);
    return id;
  }

  /**
   * Subscribe to ProjectCreated events.
   * Fires when a new project is deployed on Mammoth.
   *
   * @param {(event: object) => void} callback
   * @returns {number} listenerId
   */
  onProjectCreated(callback) {
    const id = this._getProgram().addEventListener('ProjectCreated', callback);
    this._listeners.push(id);
    return id;
  }

  /**
   * Subscribe to HardCapSet events.
   * Fires when an Elastic project permanently commits to a fixed supply.
   *
   * @param {(event: object) => void} callback
   * @returns {number} listenerId
   */
  onHardCapSet(callback) {
    const id = this._getProgram().addEventListener('HardCapSet', callback);
    this._listeners.push(id);
    return id;
  }

  /**
   * Remove a specific event listener.
   *
   * @param {number} listenerId
   */
  async removeListener(listenerId) {
    // FIX SDK-23: Remove from our list regardless of whether the underlying
    // removeEventListener succeeds — prevents double-remove errors on stop().
    this._listeners = this._listeners.filter(id => id !== listenerId);
    try {
      await this._getProgram().removeEventListener(listenerId);
    } catch (err) {
      // Listener may already be removed or connection closed — safe to ignore
    }
  }

  /**
   * Stop all active listeners and clean up.
   */
  async stop() {
    const program = this._getProgram();
    // FIX SDK-23: Catch individual removal errors so one failure doesn't leak listeners
    await Promise.all(this._listeners.map(id =>
      program.removeEventListener(id).catch(() => null)
    ));
    this._listeners = [];
  }

  // ─── Bot-optimized query utilities ───────────────────────────────────────

  /**
   * Get all currently active cycles across all Mammoth projects.
   * Returns only cycles in Active status — public buying is open right now.
   *
   * Ideal for portfolio bots scanning for entry opportunities.
   *
   * @returns {Promise<Array<{
   *   projectMint: string,
   *   projectState: PublicKey,
   *   cycleState: PublicKey,
   *   cycle: object,
   *   project: object,
   * }>>}
   */
  async getOpenCycles() {
    const program = this._getProgram();
    // FIX SDK-14: Batch fetch — one RPC call for all cycles instead of N+1
    const [projects, allCycles] = await Promise.all([
      fetchAllProjects(program),
      program.account.cycleState.all(),
    ]);

    // Build project lookup by PDA
    const projectByPda = new Map(projects.map(p => [p.publicKey.toBase58(), p]));

    return allCycles
      .filter(c => c.account.status && c.account.status.active !== undefined)
      .map(c => {
        const project = projectByPda.get(c.account.project.toBase58());
        if (!project) return null;
        return {
          projectMint: project.account.mint.toBase58(),
          projectState: project.publicKey,
          cycleState: c.publicKey,
          cycle: c.account,
          project: project.account,
        };
      })
      .filter(Boolean);
  }

  /**
   * Get all projects currently in a rights window (pre-public buying).
   * These are cycles where existing holders can exercise pro-rata rights
   * at base price before the public gets access.
   *
   * Ideal for bots managing holder positions — guarantees advantaged entry.
   *
   * @returns {Promise<Array<object>>}
   */
  async getCyclesInRightsWindow() {
    const program = this._getProgram();
    // FIX SDK-14: Batch fetch — one RPC call for all cycles
    const [projects, allCycles] = await Promise.all([
      fetchAllProjects(program),
      program.account.cycleState.all(),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const projectByPda = new Map(projects.map(p => [p.publicKey.toBase58(), p]));

    return allCycles
      .filter(c =>
        c.account.status &&
        c.account.status.rightsWindow !== undefined &&
        c.account.rightsWindowEnd.toNumber() > now
      )
      .map(c => {
        const project = projectByPda.get(c.account.project.toBase58());
        if (!project) return null;
        const secondsRemaining = c.account.rightsWindowEnd.toNumber() - now;
        return {
          projectMint: project.account.mint.toBase58(),
          projectState: project.publicKey,
          cycleState: c.publicKey,
          cycle: c.account,
          project: project.account,
          rightsWindowSecondsRemaining: secondsRemaining,
        };
      })
      .filter(Boolean);
  }

  /**
   * Get a structured snapshot of a single cycle — everything a bot needs
   * to make a buy decision in one call.
   *
   * @param {string} mintAddress
   * @returns {Promise<{
   *   projectMint: string,
   *   cycleIndex: number,
   *   status: string,
   *   curveType: string,
   *   supplyCap: number,
   *   minted: number,
   *   pctFilled: number,
   *   currentPriceLamports: number,
   *   currentPriceSol: number,
   *   basePrice: number,
   *   solRaised: number,
   *   rightsWindowEnd: number|null,
   *   rightsWindowActive: boolean,
   * }|null>}
   */
  async getCycleSnapshot(mintAddress) {
    const program = this._getProgram();
    const cycle = await fetchActiveCycle(program, mintAddress);
    if (!cycle) return null;

    const c = cycle.account;
    const now = Math.floor(Date.now() / 1000);

    // FIX M1 (round 5): Safe BN→number conversion. For values exceeding 2^53,
    // .toNumber() throws. Fall back to BigInt for precision, then Number for display
    // (with a warning that precision may be lost).
    const safeBnToNum = (bn, name) => {
      if (bn == null) return 0;
      try {
        return bn.toNumber();
      } catch {
        // Value exceeds Number safe range — use BigInt intermediate then cast
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`[mammoth-sdk] ${name} exceeds Number safe range; precision may be lost in snapshot`);
        }
        return Number(BigInt(bn.toString()));
      }
    };

    const supplyCapN = safeBnToNum(c.supplyCap, 'supplyCap');
    const mintedN = safeBnToNum(c.minted, 'minted');
    const basePriceN = safeBnToNum(c.basePrice, 'basePrice');
    // FIX H2 (round 8): Surface publicCap to bots/UIs so fill alerts fire correctly
    const rightsReservedN = c.rightsReservedAtActivation
      ? safeBnToNum(c.rightsReservedAtActivation, 'rightsReservedAtActivation')
      : 0;
    const publicCap = Math.max(0, supplyCapN - rightsReservedN);
    const pctFilled = publicCap > 0
      ? (mintedN / publicCap) * 100
      : 0;

    const statusKey = Object.keys(c.status)[0];
    const curveKey = Object.keys(c.curveType)[0];

    const rightsEnd = c.rightsWindowEnd ? safeBnToNum(c.rightsWindowEnd, 'rightsWindowEnd') : 0;

    // Compute current price inline (curve math)
    let currentPriceLamports = basePriceN;
    if (curveKey === 'step') {
      const stepSizeN = safeBnToNum(c.stepSize, 'stepSize');
      if (stepSizeN > 0) {
        const stepIncrN = safeBnToNum(c.stepIncrement, 'stepIncrement');
        const stepNumber = Math.floor(mintedN / stepSizeN);
        currentPriceLamports = basePriceN + stepNumber * stepIncrN;
      }
    } else if (curveKey === 'linear' && supplyCapN > 0) {
      const endPriceN = safeBnToNum(c.endPrice, 'endPrice');
      const spread = Math.max(0, endPriceN - basePriceN);
      currentPriceLamports = basePriceN + Math.floor(spread * mintedN / supplyCapN);
    } else if (curveKey === 'expLite' && supplyCapN > 0) {
      const kN = safeBnToNum(c.growthFactorK, 'growthFactorK');
      const pctConsumed = Math.floor(mintedN * 10000 / supplyCapN);
      const growth = Math.floor(basePriceN * kN * pctConsumed / 10000 / 10000);
      currentPriceLamports = basePriceN + growth;
    }

    const solRaisedN = c.solRaised ? safeBnToNum(c.solRaised, 'solRaised') : 0;

    return {
      projectMint: mintAddress,
      cycleIndex: c.cycleIndex,
      status: statusKey,
      curveType: curveKey,
      supplyCap: supplyCapN,
      publicCap,             // FIX H2: supplyCap minus rights reservation
      rightsReserved: rightsReservedN, // FIX H2: visible to bots
      minted: mintedN,
      pctFilled: Math.round(pctFilled * 100) / 100,
      currentPriceLamports,
      currentPriceSol: currentPriceLamports / 1e9,
      basePrice: basePriceN,
      solRaised: solRaisedN / 1e9,
      rightsWindowEnd: rightsEnd || null,
      rightsWindowActive: rightsEnd > 0 && rightsEnd > now,
    };
  }

  /**
   * Get all projects where a given wallet holds unexercised rights.
   * Rights = guaranteed below-market entry — a bot should exercise these first.
   *
   * @param {string} holderAddress
   * @returns {Promise<Array<{
   *   projectMint: string,
   *   cycleIndex: number,
   *   rightsAmount: number,
   *   exercisedAmount: number,
   *   remainingRights: number,
   *   expiry: number,
   *   snapshot: object,
   * }>>}
   */
  async getUnexercisedRights(holderAddress) {
    const program = this._getProgram();
    const projects = await fetchAllProjects(program);
    const holder = new PublicKey(holderAddress);
    const results = [];
    const now = Math.floor(Date.now() / 1000);

    // FIX M6: Process in chunks of 10 to avoid RPC rate-limit explosion
    const CHUNK_SIZE = 10;
    const processProject = async (p) => {
      try {
        const cycle = await fetchActiveCycle(program, p.account.mint.toBase58());
        if (!cycle) return;

        // Derive HolderRights PDA
        const [rightsPDA] = PublicKey.findProgramAddressSync(
          [Buffer.from('rights'), cycle.publicKey.toBuffer(), holder.toBuffer()],
          program.programId
        );
        const rights = await program.account.holderRights.fetch(rightsPDA).catch(() => null);
        if (!rights) return;

        const remaining = rights.rightsAmount.toNumber() - rights.exercisedAmount.toNumber();
        const expiry = rights.expiry.toNumber();
        if (remaining > 0 && expiry > now) {
          const snapshot = await this.getCycleSnapshot(p.account.mint.toBase58());
          results.push({
            projectMint: p.account.mint.toBase58(),
            cycleIndex: rights.cycleIndex,
            rightsAmount: rights.rightsAmount.toNumber(),
            exercisedAmount: rights.exercisedAmount.toNumber(),
            remainingRights: remaining,
            expiry,
            snapshot,
          });
        }
      } catch (err) {
        // FIX SDK-22: Only skip on "account does not exist", rethrow actual errors
        const msg = err?.message || String(err);
        if (!/Account does not exist|Could not find/i.test(msg)) {
          throw err;
        }
      }
    };

    // Process projects in chunks to limit concurrent RPC calls
    for (let i = 0; i < projects.length; i += CHUNK_SIZE) {
      const chunk = projects.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map(processProject));
    }

    return results;
  }
}

module.exports = { MammothMonitor };
