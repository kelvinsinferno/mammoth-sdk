/**
 * constants.js — Mammoth Protocol SDK constants
 * Program addresses, RPC endpoints, and protocol-level configuration.
 */

'use strict';

const { PublicKey } = require('@solana/web3.js');

/**
 * The Mammoth Protocol program ID deployed on Solana.
 * @type {PublicKey}
 */
const PROGRAM_ID = new PublicKey('DUnfGXcmPJgjSHvrPxeqPPYjrx6brurKUBJ4cVGVFR31');

/**
 * Solana Devnet RPC endpoint.
 * @type {string}
 */
const DEVNET_RPC = 'https://api.devnet.solana.com';

/**
 * Solana Mainnet-Beta RPC endpoint.
 * @type {string}
 */
const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * Default protocol fee in basis points (2%).
 * @type {number}
 */
const DEFAULT_FEE_BPS = 200;

/**
 * Token mint decimals used by Mammoth (6 decimals = 1_000_000 base units per token).
 * @type {number}
 */
const TOKEN_DECIMALS = 6;

/**
 * Lamports per SOL.
 * @type {number}
 */
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * CurveType enum values matching the on-chain IDL.
 * @enum {object}
 */
const CurveType = {
  STEP: { step: {} },
  LINEAR: { linear: {} },
  EXP_LITE: { expLite: {} },
};

/**
 * SupplyMode enum values matching the on-chain IDL.
 * @enum {object}
 */
const SupplyMode = {
  FIXED: { fixed: {} },
  ELASTIC: { elastic: {} },
};

/**
 * CycleStatus enum — mirrors on-chain CycleStatus variants.
 * @enum {string}
 */
const CycleStatus = {
  PENDING: 'pending',
  RIGHTS_WINDOW: 'rightsWindow',
  ACTIVE: 'active',
  CLOSED: 'closed',
};

module.exports = {
  PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  DEFAULT_FEE_BPS,
  TOKEN_DECIMALS,
  LAMPORTS_PER_SOL,
  CurveType,
  SupplyMode,
  CycleStatus,
};
