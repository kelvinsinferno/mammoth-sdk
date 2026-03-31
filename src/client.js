/**
 * client.js — MammothClient
 *
 * The primary entry point for interacting with Mammoth Protocol.
 * Wraps all instruction builders and query functions behind a clean,
 * stateful class interface.
 *
 * Usage:
 *   const { MammothClient } = require('@mammoth-protocol/sdk');
 *   const client = new MammothClient({ connection, wallet });
 *   await client.createProject({ ... });
 */

'use strict';

const { Connection } = require('@solana/web3.js');
const { Program, AnchorProvider } = require('@coral-xyz/anchor');

const { PROGRAM_ID, DEVNET_RPC, MAINNET_RPC } = require('./constants');
const { MammothError, ErrorCode } = require('./errors');
const { computePrice, computeBuyQuote } = require('./curves');
const instructions = require('./instructions');
const queries = require('./queries');
const IDL = require('./idl/mammoth_core.json');

/**
 * MammothClient — high-level client for Mammoth Protocol.
 *
 * @example
 * const { MammothClient } = require('@mammoth-protocol/sdk');
 * const { Connection, Keypair } = require('@solana/web3.js');
 *
 * const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
 * const wallet = { publicKey: keypair.publicKey, signTransaction: ..., signAllTransactions: ... };
 * const client = new MammothClient({ connection, wallet });
 */
class MammothClient {
  /**
   * @param {object} opts
   * @param {Connection} opts.connection — Solana Connection instance
   * @param {object} [opts.wallet] — wallet adapter (publicKey + signTransaction + signAllTransactions)
   *   Required for write operations; optional for read-only usage.
   * @param {'devnet'|'mainnet-beta'} [opts.cluster='devnet']
   */
  constructor({ connection, wallet, cluster = 'devnet' }) {
    if (!connection) {
      throw new MammothError(ErrorCode.INVALID_PARAMS, 'connection is required');
    }

    this.connection = connection;
    this.wallet = wallet || null;
    this.cluster = cluster;
    this._program = null;
  }

  /**
   * Get (or lazily initialize) the Anchor Program instance.
   * Throws if wallet is not set and the program requires signing.
   *
   * @param {boolean} [requireWallet=true]
   * @returns {import('@coral-xyz/anchor').Program}
   */
  _getProgram(requireWallet = true) {
    if (requireWallet && !this.wallet) {
      throw new MammothError(
        ErrorCode.WALLET_REQUIRED,
        'A wallet is required for write operations. Pass { wallet } to the MammothClient constructor.'
      );
    }

    // Use a read-only wallet stub if no wallet is configured (queries only)
    const walletForProvider = this.wallet || {
      publicKey: null,
      signTransaction: async (tx) => tx,
      signAllTransactions: async (txs) => txs,
    };

    const provider = new AnchorProvider(
      this.connection,
      walletForProvider,
      { commitment: 'confirmed', preflightCommitment: 'confirmed' }
    );

    // Anchor 0.30+: new Program(idl, provider) — programId comes from idl.address
    return new Program(IDL, provider);
  }

  // ─── Project lifecycle ────────────────────────────────────────────────────

  /**
   * Create a new Mammoth project on-chain.
   *
   * @param {object} params
   * @param {'fixed'|'elastic'} [params.supplyMode='fixed'] — supply mode
   * @param {number} params.totalSupply — total supply in base units (6 decimals, e.g. 1_000_000_000_000 = 1M tokens)
   * @param {number} params.publicAllocationBps — BPS of total supply for public sale (e.g. 6000 = 60%)
   * @param {number} params.creatorBps — creator SOL revenue BPS (e.g. 7000)
   * @param {number} params.reserveBps — reserve SOL split BPS (e.g. 2000)
   * @param {number} params.sinkBps — sink SOL split BPS (e.g. 800)
   * @param {number|null} [params.launchAt=null] — Unix timestamp to lock cycle opening until, or null
   * @param {import('@solana/web3.js').Keypair} [params.mintKeypair] — optional existing mint keypair
   * @returns {Promise<{tx: string, mint: string, projectState: import('@solana/web3.js').PublicKey}>}
   * @throws {MammothError}
   */
  async createProject(params) {
    const program = this._getProgram(true);
    const supplyModeObj =
      params.supplyMode === 'elastic' ? { elastic: {} } : { fixed: {} };

    return instructions.createProject(program, {
      ...params,
      supplyMode: supplyModeObj,
    });
  }

  /**
   * Open a new issuance cycle for an existing project. Creator-only.
   *
   * @param {string|import('@solana/web3.js').PublicKey} mintAddress — token mint
   * @param {object} params
   * @param {'step'|'linear'|'expLite'} params.curveType — pricing curve type
   * @param {number} params.supplyCap — tokens to sell this cycle (base units)
   * @param {number} params.startPrice — starting price in SOL (e.g. 0.001)
   * @param {number} [params.rightsWindowDuration=0] — rights window in seconds (0 = skip)
   * @param {number} [params.stepSize=0] — tokens per price step (step curve)
   * @param {number} [params.stepIncrement=0] — SOL price increment per step (step curve)
   * @param {number} [params.endPrice=0] — ending price in SOL (linear curve)
   * @param {number} [params.growthFactorK=0] — growth factor k (expLite curve, e.g. 2.5)
   * @returns {Promise<{tx: string, cycleIndex: number, cycleState: import('@solana/web3.js').PublicKey}>}
   * @throws {MammothError}
   */
  async openCycle(mintAddress, params) {
    const program = this._getProgram(true);
    return instructions.openCycle(program, mintAddress, params);
  }

  /**
   * Close the active cycle for a project. Creator-only.
   *
   * @param {string|import('@solana/web3.js').PublicKey} mintAddress
   * @returns {Promise<{tx: string}>}
   * @throws {MammothError}
   */
  async closeCycle(mintAddress) {
    const program = this._getProgram(true);
    return instructions.closeCycle(program, mintAddress);
  }

  /**
   * Set a hard cap on an Elastic supply project. Irreversible. Creator-only.
   *
   * @param {string|import('@solana/web3.js').PublicKey} mintAddress
   * @param {number} hardCapAmount — hard cap in base units (6 decimals)
   * @returns {Promise<{tx: string}>}
   * @throws {MammothError}
   */
  async setHardCap(mintAddress, hardCapAmount) {
    const program = this._getProgram(true);
    return instructions.setHardCap(program, mintAddress, hardCapAmount);
  }

  // ─── Trading ──────────────────────────────────────────────────────────────

  /**
   * Buy tokens from the active cycle of a project.
   *
   * @param {string|import('@solana/web3.js').PublicKey} mintAddress
   * @param {number} amount — token amount to buy (base units, 6 decimals)
   * @returns {Promise<{tx: string, amount: number}>}
   * @throws {MammothError}
   */
  async buyTokens(mintAddress, amount) {
    const program = this._getProgram(true);
    return instructions.buyTokens(program, mintAddress, amount);
  }

  /**
   * Exercise previously allocated rights during the RightsWindow.
   *
   * @param {string|import('@solana/web3.js').PublicKey} mintAddress
   * @param {number} amount — token amount to exercise (base units)
   * @returns {Promise<{tx: string, amount: number}>}
   * @throws {MammothError}
   */
  async exerciseRights(mintAddress, amount) {
    const program = this._getProgram(true);
    return instructions.exerciseRights(program, mintAddress, amount);
  }

  // ─── Queries (no wallet required) ────────────────────────────────────────

  /**
   * Fetch a project's on-chain state.
   *
   * @param {string|import('@solana/web3.js').PublicKey} mintAddress
   * @returns {Promise<{publicKey: import('@solana/web3.js').PublicKey, account: object}|null>}
   * @throws {MammothError}
   */
  async fetchProject(mintAddress) {
    const program = this._getProgram(false);
    return queries.fetchProject(program, mintAddress);
  }

  /**
   * Fetch all projects deployed on Mammoth Protocol.
   *
   * @returns {Promise<Array<{publicKey: import('@solana/web3.js').PublicKey, account: object}>>}
   * @throws {MammothError}
   */
  async fetchAllProjects() {
    const program = this._getProgram(false);
    return queries.fetchAllProjects(program);
  }

  /**
   * Fetch a specific cycle by index.
   *
   * @param {string|import('@solana/web3.js').PublicKey} mintAddress
   * @param {number} cycleIndex — 0-based cycle index
   * @returns {Promise<{publicKey: import('@solana/web3.js').PublicKey, account: object}|null>}
   * @throws {MammothError}
   */
  async fetchCycle(mintAddress, cycleIndex) {
    const program = this._getProgram(false);
    return queries.fetchCycle(program, mintAddress, cycleIndex);
  }

  /**
   * Fetch HolderRights for a wallet on a specific cycle.
   *
   * @param {string|import('@solana/web3.js').PublicKey} mintAddress
   * @param {string|import('@solana/web3.js').PublicKey} holderAddress
   * @returns {Promise<{publicKey: import('@solana/web3.js').PublicKey, account: object}|null>}
   *   null = no rights allocated for this holder
   * @throws {MammothError}
   */
  async fetchHolderRights(mintAddress, holderAddress) {
    const program = this._getProgram(false);
    // Fetch active cycle index first
    const project = await queries.fetchProject(program, mintAddress);
    if (!project) return null;
    const cycleIndex = project.account.currentCycle - 1;
    if (cycleIndex < 0) return null;
    return queries.fetchHolderRights(program, mintAddress, cycleIndex, holderAddress);
  }

  /**
   * Get the SOL balance of any address.
   *
   * @param {string|import('@solana/web3.js').PublicKey} address
   * @returns {Promise<number>} balance in SOL
   * @throws {MammothError}
   */
  async getBalance(address) {
    return queries.getBalance(this.connection, address);
  }

  // ─── Utils (synchronous, no RPC) ─────────────────────────────────────────

  /**
   * Compute the current token price from a CycleState object.
   *
   * @param {object} cycleState — on-chain CycleState (camelCase from Anchor)
   * @returns {number} current price in SOL
   */
  computePrice(cycleState) {
    return computePrice(cycleState);
  }

  /**
   * Compute a buy quote: how many tokens for `solIn` SOL.
   *
   * @param {object} cycleState — on-chain CycleState (camelCase)
   * @param {number} solIn — SOL amount to spend
   * @param {number} [feeBps=200] — protocol fee in basis points
   * @returns {{
   *   tokensOut: number,
   *   effectivePrice: number,
   *   fee: number,
   *   newPrice: number,
   *   nextStepIn: number|null,
   *   remainingAfter: number
   * }|null}
   */
  computeBuyQuote(cycleState, solIn, feeBps = 200) {
    return computeBuyQuote(cycleState, solIn, feeBps);
  }

  /**
   * Check whether an operator address has permission to execute a given instruction.
   *
   * ⚠️ STUB — Requires TASK-AI-004 AuthorityConfig implementation.
   * This method is intentionally included so agents can discover the interface now.
   * It currently always returns { allowed: false, reason: 'not-implemented' }.
   *
   * When TASK-AI-004 is complete, this will:
   * - Fetch the AuthorityConfig PDA for the mint
   * - Check the operator's permission set against the requested instruction
   * - Return { allowed: boolean, reason: string }
   *
   * @param {string|import('@solana/web3.js').PublicKey} mintAddress
   * @param {string|import('@solana/web3.js').PublicKey} operatorAddress
   * @param {string} instruction — instruction name (e.g. 'openCycle', 'closeCycle', 'buyTokens')
   * @returns {{ allowed: boolean, reason: string }}
   */
  checkOperatorPermission(mintAddress, operatorAddress, instruction) {
    // TASK-AI-004: AuthorityConfig implementation required.
    // This stub ensures agents can discover the interface and build around it.
    console.warn(
      '[MammothSDK] checkOperatorPermission is a stub. ' +
      'Full implementation requires TASK-AI-004 (AuthorityConfig on-chain account).'
    );
    return {
      allowed: false,
      reason: 'not-implemented — awaiting TASK-AI-004 AuthorityConfig',
    };
  }
}

module.exports = { MammothClient };
