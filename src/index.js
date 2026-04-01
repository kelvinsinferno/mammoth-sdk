/**
 * @mammoth-protocol/sdk
 *
 * Solana-native cycle-driven token issuance SDK for Mammoth Protocol.
 * Multi-round raises, rights-based anti-dilution, deterministic treasury routing.
 *
 * @example
 * const { MammothClient, PROGRAM_ID, DEVNET_RPC } = require('@mammoth-protocol/sdk');
 * const { Connection } = require('@solana/web3.js');
 *
 * const client = new MammothClient({
 *   connection: new Connection(DEVNET_RPC, 'confirmed'),
 *   wallet: myWallet,
 * });
 */

'use strict';

// ─── Main client ──────────────────────────────────────────────────────────────
const { MammothClient } = require('./client');

// ─── Monitor (bot/agent event subscriptions) ──────────────────────────────────
const { MammothMonitor } = require('./monitor');

// ─── Errors ───────────────────────────────────────────────────────────────────
const { MammothError, ErrorCode, parseTxError } = require('./errors');

// ─── Constants ────────────────────────────────────────────────────────────────
const {
  PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  DEFAULT_FEE_BPS,
  TOKEN_DECIMALS,
  LAMPORTS_PER_SOL,
  CurveType,
  SupplyMode,
  CycleStatus,
} = require('./constants');

// ─── PDA helpers ──────────────────────────────────────────────────────────────
const {
  getProtocolConfigPDA,
  getProtocolTreasuryPDA,
  getProjectStatePDA,
  getCycleStatePDA,
  getHolderRightsPDA,
  getReservePDA,
  resolveAllPDAs,
} = require('./pdas');

// ─── Curve math (pure, no RPC needed) ────────────────────────────────────────
const {
  lamportsToSol,
  solToLamports,
  computePrice,
  computeBuyQuote,
  stepCurvePriceAt,
  linearCurvePriceAt,
  expLiteCurvePriceAt,
} = require('./curves');

// ─── Low-level instruction builders ──────────────────────────────────────────
const {
  createProject,
  openCycle,
  closeCycle,
  setHardCap,
  buyTokens,
  exerciseRights,
  activateCycle,
} = require('./instructions');

// ─── Query helpers ────────────────────────────────────────────────────────────
const {
  fetchAllProjects,
  fetchProject,
  fetchCycle,
  fetchActiveCycle,
  fetchHolderRights,
  getBalance,
} = require('./queries');

// ─── IDL ──────────────────────────────────────────────────────────────────────
const IDL = require('./idl/mammoth_core.json');

module.exports = {
  // Client
  MammothClient,

  // Monitor (bot/agent event subscriptions + query utilities)
  MammothMonitor,

  // Errors
  MammothError,
  ErrorCode,
  parseTxError,

  // Constants
  PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  DEFAULT_FEE_BPS,
  TOKEN_DECIMALS,
  LAMPORTS_PER_SOL,
  CurveType,
  SupplyMode,
  CycleStatus,

  // PDAs
  getProtocolConfigPDA,
  getProtocolTreasuryPDA,
  getProjectStatePDA,
  getCycleStatePDA,
  getHolderRightsPDA,
  getReservePDA,
  resolveAllPDAs,

  // Curves (pure math)
  lamportsToSol,
  solToLamports,
  computePrice,
  computeBuyQuote,
  stepCurvePriceAt,
  linearCurvePriceAt,
  expLiteCurvePriceAt,

  // Instruction builders (low-level)
  createProject,
  openCycle,
  closeCycle,
  setHardCap,
  buyTokens,
  exerciseRights,
  activateCycle,

  // Queries
  fetchAllProjects,
  fetchProject,
  fetchCycle,
  fetchActiveCycle,
  fetchHolderRights,
  getBalance,

  // IDL (for custom Anchor integrations)
  IDL,
};
