/**
 * pdas.js — Mammoth Protocol PDA derivation helpers
 *
 * All functions are synchronous and pure — no network calls required.
 * Returns [PublicKey, bump] tuples consistent with findProgramAddressSync.
 */

'use strict';

const { PublicKey } = require('@solana/web3.js');
const { PROGRAM_ID } = require('./constants');

/**
 * Derive the ProtocolConfig PDA.
 * Seed: ["protocol_config"]
 *
 * @returns {[PublicKey, number]} [pda, bump]
 */
function getProtocolConfigPDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('protocol_config')],
    PROGRAM_ID
  );
}

/**
 * Derive the ProtocolTreasury PDA.
 * Seed: ["protocol_treasury"]
 *
 * @returns {[PublicKey, number]} [pda, bump]
 */
function getProtocolTreasuryPDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('protocol_treasury')],
    PROGRAM_ID
  );
}

/**
 * Derive the ProjectState PDA for a given mint.
 * Seed: ["project", mint_pubkey]
 *
 * @param {PublicKey} mintPubkey — the token mint public key
 * @returns {[PublicKey, number]} [pda, bump]
 * @throws {MammothError} if mintPubkey is not a valid PublicKey
 */
function getProjectStatePDA(mintPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('project'), mintPubkey.toBuffer()],
    PROGRAM_ID
  );
}

/**
 * Derive the CycleState PDA for a given project and cycle index.
 * Seed: ["cycle", project_state_pda, cycle_index_byte]
 *
 * @param {PublicKey} projectStatePda — the ProjectState PDA
 * @param {number} cycleIndex — 0-based cycle index (u8, max 255)
 * @returns {[PublicKey, number]} [pda, bump]
 */
function getCycleStatePDA(projectStatePda, cycleIndex) {
  // FIX SDK-5: Validate cycleIndex is a valid u8 — prevents silent PDA collision
  if (cycleIndex < 0 || cycleIndex > 255 || !Number.isInteger(cycleIndex)) {
    throw new Error(`cycleIndex must be an integer 0-255, got ${cycleIndex}`);
  }
  return PublicKey.findProgramAddressSync(
    [Buffer.from('cycle'), projectStatePda.toBuffer(), Buffer.from([cycleIndex])],
    PROGRAM_ID
  );
}

/**
 * Derive the HolderRights PDA for a specific holder on a cycle.
 * Seed: ["rights", cycle_state_pda, holder_pubkey]
 *
 * @param {PublicKey} cycleStatePda — the CycleState PDA
 * @param {PublicKey} holderPubkey — the holder's wallet public key
 * @returns {[PublicKey, number]} [pda, bump]
 */
function getHolderRightsPDA(cycleStatePda, holderPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('rights'), cycleStatePda.toBuffer(), holderPubkey.toBuffer()],
    PROGRAM_ID
  );
}

/**
 * Derive the Reserve PDA for a project.
 * Seed: ["reserve", project_state_pda]
 *
 * @param {PublicKey} projectStatePda — the ProjectState PDA
 * @returns {[PublicKey, number]} [pda, bump]
 */
function getReservePDA(projectStatePda) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('reserve'), projectStatePda.toBuffer()],
    PROGRAM_ID
  );
}

/**
 * Resolve all PDAs for a given mint in one call.
 * Useful for building full instruction account maps.
 *
 * @param {PublicKey} mintPubkey
 * @param {number} cycleIndex — current or target cycle index
 * @param {PublicKey} [holderPubkey] — optional, for HolderRights derivation
 * @returns {{
 *   protocolConfig: PublicKey,
 *   protocolTreasury: PublicKey,
 *   projectState: PublicKey,
 *   cycleState: PublicKey,
 *   reserve: PublicKey,
 *   holderRights: PublicKey|null
 * }}
 */
function resolveAllPDAs(mintPubkey, cycleIndex, holderPubkey = null) {
  // FIX L7: Validate mintPubkey is a PublicKey
  if (!mintPubkey || typeof mintPubkey.toBuffer !== 'function') {
    throw new Error('resolveAllPDAs: mintPubkey must be a PublicKey instance');
  }
  const [protocolConfig] = getProtocolConfigPDA();
  const [protocolTreasury] = getProtocolTreasuryPDA();
  const [projectState] = getProjectStatePDA(mintPubkey);
  const [cycleState] = getCycleStatePDA(projectState, cycleIndex);
  const [reserve] = getReservePDA(projectState);
  const holderRights = holderPubkey
    ? getHolderRightsPDA(cycleState, holderPubkey)[0]
    : null;

  return { protocolConfig, protocolTreasury, projectState, cycleState, reserve, holderRights };
}

module.exports = {
  getProtocolConfigPDA,
  getProtocolTreasuryPDA,
  getProjectStatePDA,
  getCycleStatePDA,
  getHolderRightsPDA,
  getReservePDA,
  resolveAllPDAs,
};
