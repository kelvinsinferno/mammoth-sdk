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

  // Insufficient funds
  if (
    msg.includes('0x1') ||
    msg.includes('insufficient funds') ||
    msg.includes('insufficient lamports')
  ) {
    return new MammothError(ErrorCode.INVALID_PARAMS, 'Insufficient SOL balance', error);
  }

  // Network / RPC errors
  if (msg.includes('timeout') || msg.includes('network') || msg.includes('fetch failed')) {
    return new MammothError(ErrorCode.NETWORK_ERROR, 'Network error — please retry', error);
  }

  // Custom program errors — map IDL error codes
  if (msg.includes('6000') || msg.includes('Unauthorized'))
    return new MammothError(ErrorCode.UNAUTHORIZED, 'Not authorized for this instruction', error);
  if (msg.includes('6001') || msg.includes('HardCapAlreadySet'))
    return new MammothError(ErrorCode.HARD_CAP_ALREADY_SET, 'Hard cap already set — irreversible', error);
  if (msg.includes('6002') || msg.includes('NotElasticMode'))
    return new MammothError(ErrorCode.NOT_ELASTIC_MODE, 'Hard cap only settable in Elastic supply mode', error);
  if (msg.includes('6003') || msg.includes('NotRightsWindow'))
    return new MammothError(ErrorCode.NOT_RIGHTS_WINDOW, 'Cycle is not in Rights Window status', error);
  if (msg.includes('6004') || msg.includes('RightsWindowExpired'))
    return new MammothError(ErrorCode.RIGHTS_WINDOW_EXPIRED, 'Rights window has expired', error);
  if (msg.includes('6005') || msg.includes('ExceedsRightsAllocation'))
    return new MammothError(ErrorCode.EXCEEDS_RIGHTS_ALLOCATION, 'Exceeds your rights allocation', error);
  if (msg.includes('6006') || msg.includes('NotActive'))
    return new MammothError(ErrorCode.NOT_ACTIVE, 'Cycle is not in Active status', error);
  if (msg.includes('6007') || msg.includes('SupplyCapExceeded'))
    return new MammothError(ErrorCode.SUPPLY_CAP_EXCEEDED, 'Cycle supply cap has been reached', error);
  if (msg.includes('6008') || msg.includes('CycleParamsImmutable'))
    return new MammothError(ErrorCode.CYCLE_PARAMS_IMMUTABLE, 'Cycle params are immutable once opened', error);
  if (msg.includes('6009') || msg.includes('ElasticRequiresRights'))
    return new MammothError(ErrorCode.ELASTIC_REQUIRES_RIGHTS, 'Elastic supply mode requires rights-based issuance', error);
  if (msg.includes('6010') || msg.includes('MathOverflow'))
    return new MammothError(ErrorCode.MATH_OVERFLOW, 'Arithmetic overflow in on-chain computation', error);
  if (msg.includes('6011') || msg.includes('NotClosed'))
    return new MammothError(ErrorCode.NOT_CLOSED, 'Cycle is not closed', error);
  if (msg.includes('6012') || msg.includes('ZeroAmount'))
    return new MammothError(ErrorCode.ZERO_AMOUNT, 'Amount must be greater than zero', error);
  if (msg.includes('6013') || msg.includes('ZeroStepSize'))
    return new MammothError(ErrorCode.ZERO_STEP_SIZE, 'Step size cannot be zero for step curves', error);
  if (msg.includes('6014') || msg.includes('RightsWindowStillOpen'))
    return new MammothError(ErrorCode.RIGHTS_WINDOW_STILL_OPEN, 'Rights window is still open — cannot activate yet', error);
  if (msg.includes('6015') || msg.includes('LaunchTimeNotReached'))
    return new MammothError(ErrorCode.LAUNCH_TIME_NOT_REACHED, 'Scheduled launch time has not been reached yet', error);

  return new MammothError(ErrorCode.UNKNOWN, `Transaction failed: ${msg}`, error);
}

module.exports = { MammothError, ErrorCode, parseTxError };
