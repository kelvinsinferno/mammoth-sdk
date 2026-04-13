/**
 * errors.js — Mammoth Protocol SDK error classes and parser
 *
 * All SDK errors throw MammothError with a machine-readable `code` and
 * a human-readable `message`. Consumers can branch on error.code for
 * automated retry / fallback logic.
 */

'use strict';

/**
 * Error codes used by the Mammoth SDK.
 * @enum {string}
 */
const ErrorCode = {
  // On-chain program errors (mirror IDL)
  UNAUTHORIZED: 'UNAUTHORIZED',
  HARD_CAP_ALREADY_SET: 'HARD_CAP_ALREADY_SET',
  NOT_ELASTIC_MODE: 'NOT_ELASTIC_MODE',
  NOT_RIGHTS_WINDOW: 'NOT_RIGHTS_WINDOW',
  RIGHTS_WINDOW_EXPIRED: 'RIGHTS_WINDOW_EXPIRED',
  EXCEEDS_RIGHTS_ALLOCATION: 'EXCEEDS_RIGHTS_ALLOCATION',
  NOT_ACTIVE: 'NOT_ACTIVE',
  SUPPLY_CAP_EXCEEDED: 'SUPPLY_CAP_EXCEEDED',
  CYCLE_PARAMS_IMMUTABLE: 'CYCLE_PARAMS_IMMUTABLE',
  ELASTIC_REQUIRES_RIGHTS: 'ELASTIC_REQUIRES_RIGHTS',
  MATH_OVERFLOW: 'MATH_OVERFLOW',
  NOT_CLOSED: 'NOT_CLOSED',
  ZERO_AMOUNT: 'ZERO_AMOUNT',
  ZERO_STEP_SIZE: 'ZERO_STEP_SIZE',
  RIGHTS_WINDOW_STILL_OPEN: 'RIGHTS_WINDOW_STILL_OPEN',
  LAUNCH_TIME_NOT_REACHED: 'LAUNCH_TIME_NOT_REACHED',
  INVALID_CYCLE_PROJECT: 'INVALID_CYCLE_PROJECT',
  INVALID_PROJECT_MINT: 'INVALID_PROJECT_MINT',
  INVALID_RIGHTS_PROJECT: 'INVALID_RIGHTS_PROJECT',
  INVALID_RIGHTS_CYCLE: 'INVALID_RIGHTS_CYCLE',
  INVALID_RIGHTS_HOLDER: 'INVALID_RIGHTS_HOLDER',

  // SDK-level errors
  INVALID_PARAMS: 'INVALID_PARAMS',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  NETWORK_ERROR: 'NETWORK_ERROR',
  WALLET_REQUIRED: 'WALLET_REQUIRED',
  USER_REJECTED: 'USER_REJECTED',
  UNKNOWN: 'UNKNOWN',
};

/**
 * MammothError — the base error class for all SDK errors.
 *
 * @extends Error
 * @property {string} code — machine-readable error code from ErrorCode enum
 * @property {string} message — human-readable description
 * @property {Error|null} cause — original underlying error (if any)
 */
class MammothError extends Error {
  /**
   * @param {string} code — ErrorCode value
   * @param {string} message — human-readable description
   * @param {Error|null} [cause=null] — original error
   */
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'MammothError';
    this.code = code;
    this.cause = cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MammothError);
    }
  }
}

/**
 * Parse a raw Anchor/Solana transaction error into a MammothError.
 *
 * @param {Error|unknown} error — raw error from an RPC or Anchor call
 * @returns {MammothError} — structured SDK error
 */
function parseTxError(error) {
  if (error instanceof MammothError) return error;

  const msg = (error && (error.message || String(error))) || '';

  // User rejection — not a real failure
  if (
    msg.includes('User rejected') ||
    msg.includes('Transaction cancelled') ||
    msg.includes('WalletSignTransactionError') ||
    msg.includes('rejected the request')
  ) {
    return new MammothError(ErrorCode.USER_REJECTED, 'User rejected the transaction', error);
  }

  // FIX SDK-8: Use specific patterns to avoid false positives on substring matches.
  // Anchor errors follow format: "Error Code: <Name>" or "custom program error: 0x<hex>"
  // IDL custom errors start at 6000 (0x1770). Match the specific hex.

  // Insufficient funds — check specific messages (not 0x1 which matches anything with that substring)
  if (
    /\binsufficient funds\b/i.test(msg) ||
    /\binsufficient lamports\b/i.test(msg) ||
    /\bcustom program error: 0x1\b/.test(msg)  // specific: 0x1 followed by word boundary
  ) {
    return new MammothError(ErrorCode.INVALID_PARAMS, 'Insufficient SOL balance', error);
  }

  // Network / RPC errors
  if (/\btimeout\b/i.test(msg) || /\bnetwork error\b/i.test(msg) || /\bfetch failed\b/i.test(msg)) {
    return new MammothError(ErrorCode.NETWORK_ERROR, 'Network error — please retry', error);
  }

  // Helper: match IDL error by hex code (6000 = 0x1770, 6001 = 0x1771, etc.)
  // Use word-boundary matching on hex and exact error name match.
  const matchIdlError = (hexCode, name) => {
    const hexPattern = new RegExp(`\\b0x${hexCode.toString(16)}\\b`, 'i');
    const namePattern = new RegExp(`\\bError Code: ${name}\\b`);
    return hexPattern.test(msg) || namePattern.test(msg);
  };

  if (matchIdlError(0x1770, 'Unauthorized'))
    return new MammothError(ErrorCode.UNAUTHORIZED, 'Not authorized for this instruction', error);
  if (matchIdlError(0x1771, 'HardCapAlreadySet'))
    return new MammothError(ErrorCode.HARD_CAP_ALREADY_SET, 'Hard cap already set — irreversible', error);
  if (matchIdlError(0x1772, 'NotElasticMode'))
    return new MammothError(ErrorCode.NOT_ELASTIC_MODE, 'Hard cap only settable in Elastic supply mode', error);
  if (matchIdlError(0x1773, 'NotRightsWindow'))
    return new MammothError(ErrorCode.NOT_RIGHTS_WINDOW, 'Cycle is not in Rights Window status', error);
  if (matchIdlError(0x1774, 'RightsWindowExpired'))
    return new MammothError(ErrorCode.RIGHTS_WINDOW_EXPIRED, 'Rights window has expired', error);
  if (matchIdlError(0x1775, 'ExceedsRightsAllocation'))
    return new MammothError(ErrorCode.EXCEEDS_RIGHTS_ALLOCATION, 'Exceeds your rights allocation', error);
  if (matchIdlError(0x1776, 'NotActive'))
    return new MammothError(ErrorCode.NOT_ACTIVE, 'Cycle is not in Active status', error);
  if (matchIdlError(0x1777, 'SupplyCapExceeded'))
    return new MammothError(ErrorCode.SUPPLY_CAP_EXCEEDED, 'Cycle supply cap has been reached', error);
  if (matchIdlError(0x1778, 'CycleParamsImmutable'))
    return new MammothError(ErrorCode.CYCLE_PARAMS_IMMUTABLE, 'Cycle params are immutable once opened', error);
  if (matchIdlError(0x1779, 'ElasticRequiresRights'))
    return new MammothError(ErrorCode.ELASTIC_REQUIRES_RIGHTS, 'Elastic supply mode requires rights-based issuance', error);
  if (matchIdlError(0x177a, 'MathOverflow'))
    return new MammothError(ErrorCode.MATH_OVERFLOW, 'Arithmetic overflow in on-chain computation', error);
  if (matchIdlError(0x177b, 'NotClosed'))
    return new MammothError(ErrorCode.NOT_CLOSED, 'Cycle is not closed', error);
  if (matchIdlError(0x177c, 'ZeroAmount'))
    return new MammothError(ErrorCode.ZERO_AMOUNT, 'Amount must be greater than zero', error);
  if (matchIdlError(0x177d, 'ZeroStepSize'))
    return new MammothError(ErrorCode.ZERO_STEP_SIZE, 'Step size cannot be zero for step curves', error);
  if (matchIdlError(0x177e, 'RightsWindowStillOpen'))
    return new MammothError(ErrorCode.RIGHTS_WINDOW_STILL_OPEN, 'Rights window is still open — cannot activate yet', error);
  if (matchIdlError(0x177f, 'LaunchTimeNotReached'))
    return new MammothError(ErrorCode.LAUNCH_TIME_NOT_REACHED, 'Scheduled launch time has not been reached yet', error);
  if (/\bError Code: InvalidCycleProject\b/.test(msg))
    return new MammothError(ErrorCode.INVALID_CYCLE_PROJECT, 'Cycle does not belong to project', error);
  if (/\bError Code: InvalidProjectMint\b/.test(msg))
    return new MammothError(ErrorCode.INVALID_PROJECT_MINT, 'Mint does not match project mint', error);
  if (/\bError Code: InvalidRightsProject\b/.test(msg))
    return new MammothError(ErrorCode.INVALID_RIGHTS_PROJECT, 'Rights account does not belong to project', error);
  if (/\bError Code: InvalidRightsCycle\b/.test(msg))
    return new MammothError(ErrorCode.INVALID_RIGHTS_CYCLE, 'Rights account cycle does not match active cycle', error);
  if (/\bError Code: InvalidRightsHolder\b/.test(msg))
    return new MammothError(ErrorCode.INVALID_RIGHTS_HOLDER, 'Rights account holder does not match signer', error);

  return new MammothError(ErrorCode.UNKNOWN, `Transaction failed: ${msg}`, error);
}

module.exports = { MammothError, ErrorCode, parseTxError };
