/**
 * queries.js — Read-only on-chain queries for Mammoth Protocol
 *
 * All functions accept an Anchor Program instance and return parsed data.
 * No wallet is required for any query — these are safe to call from
 * read-only agents, dashboards, and monitoring scripts.
 */

'use strict';

const { PublicKey } = require('@solana/web3.js');
const { LAMPORTS_PER_SOL } = require('./constants');
const { getProjectStatePDA, getCycleStatePDA, getHolderRightsPDA } = require('./pdas');
const { MammothError, ErrorCode } = require('./errors');

/**
 * Fetch all ProjectState accounts from on-chain.
 *
 * WARNING: For production deployments with many projects, use an indexer
 * (Helius, Shyft) instead. This call uses getProgramAccounts which may hit
 * RPC response size limits (~50MB) at scale.
 *
 * @param {import('@coral-xyz/anchor').Program} program — Anchor program instance
 * @param {object} [opts]
 * @param {number} [opts.limit] — max results to return (default: no limit)
 * @param {number} [opts.offset=0] — skip first N results
 * @returns {Promise<Array<{publicKey: PublicKey, account: object}>>}
 * @throws {MammothError} on RPC failure
 */
async function fetchAllProjects(program, opts = {}) {
  try {
    const { limit, offset = 0 } = opts;
    // FIX SDK-13: Support pagination via limit/offset slice.
    // Note: this still fetches all accounts from RPC; true pagination requires
    // memcmp filters or an indexer. This at least bounds returned data size.
    const all = await program.account.projectState.all();
    const start = offset;
    const end = limit ? start + limit : all.length;
    return all.slice(start, end);
  } catch (err) {
    throw new MammothError(
      ErrorCode.NETWORK_ERROR,
      `Failed to fetch all projects: ${err.message}. For production, use an indexer.`,
      err
    );
  }
}

/**
 * Fetch a single ProjectState by mint address.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress — token mint address
 * @returns {Promise<{publicKey: PublicKey, account: object}|null>} null if not found
 * @throws {MammothError} on unexpected RPC failure
 */
async function fetchProject(program, mintAddress) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const [pda] = getProjectStatePDA(mintPubkey);
    const account = await program.account.projectState.fetch(pda);
    return { publicKey: pda, account };
  } catch (err) {
    if (err.message && err.message.includes('Account does not exist')) {
      return null;
    }
    throw new MammothError(
      ErrorCode.NETWORK_ERROR,
      `Failed to fetch project: ${err.message}`,
      err
    );
  }
}

/**
 * Fetch a CycleState by mint address and cycle index.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress — token mint address
 * @param {number} cycleIndex — 0-based cycle index
 * @returns {Promise<{publicKey: PublicKey, account: object}|null>} null if not found
 * @throws {MammothError} on RPC failure
 */
async function fetchCycle(program, mintAddress, cycleIndex) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const [cyclePda] = getCycleStatePDA(projectStatePda, cycleIndex);
    const account = await program.account.cycleState.fetch(cyclePda);
    return { publicKey: cyclePda, account };
  } catch (err) {
    if (err.message && err.message.includes('Account does not exist')) {
      return null;
    }
    throw new MammothError(
      ErrorCode.NETWORK_ERROR,
      `Failed to fetch cycle: ${err.message}`,
      err
    );
  }
}

/**
 * Fetch the active (current) cycle for a project.
 * Reads the project state to find currentCycle, then fetches that cycle.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress
 * @returns {Promise<{publicKey: PublicKey, account: object, cycleIndex: number}|null>}
 * @throws {MammothError}
 */
async function fetchActiveCycle(program, mintAddress) {
  const project = await fetchProject(program, mintAddress);
  if (!project) return null;

  const currentCycleIndex = typeof project.account.currentCycle === 'number'
    ? project.account.currentCycle
    : project.account.currentCycle.toNumber();
  if (currentCycleIndex === 0) return null; // No cycles opened yet

  const cycleIndex = currentCycleIndex - 1; // currentCycle is 1-based count; last opened is index-1
  const cycle = await fetchCycle(program, mintAddress, cycleIndex);
  if (!cycle) return null;

  return { ...cycle, cycleIndex };
}

/**
 * Fetch HolderRights for a specific holder on a specific cycle.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress — token mint
 * @param {number} cycleIndex — cycle index
 * @param {string|PublicKey} holderAddress — holder's wallet address
 * @returns {Promise<{publicKey: PublicKey, account: object}|null>} null if no rights exist
 * @throws {MammothError}
 */
async function fetchHolderRights(program, mintAddress, cycleIndex, holderAddress) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const holderPubkey = new PublicKey(holderAddress);
    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const [cycleStatePda] = getCycleStatePDA(projectStatePda, cycleIndex);
    const [rightsPda] = getHolderRightsPDA(cycleStatePda, holderPubkey);
    const account = await program.account.holderRights.fetch(rightsPda);
    return { publicKey: rightsPda, account };
  } catch (err) {
    if (err.message && (
      err.message.includes('Account does not exist') ||
      err.message.includes('has no data')
    )) {
      return null; // No rights — not an error condition
    }
    throw new MammothError(
      ErrorCode.NETWORK_ERROR,
      `Failed to fetch holder rights: ${err.message}`,
      err
    );
  }
}

/**
 * Get the SOL balance of any address.
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string|PublicKey} address
 * @returns {Promise<number>} balance in SOL (float)
 * @throws {MammothError}
 */
async function getBalance(connection, address) {
  try {
    const pubkey = new PublicKey(address);
    const lamports = await connection.getBalance(pubkey, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    throw new MammothError(
      ErrorCode.NETWORK_ERROR,
      `Failed to get balance: ${err.message}`,
      err
    );
  }
}

/**
 * Fetch the AuthorityConfig account for a project.
 * Returns null if no authority config has been initialized.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress
 * @returns {Promise<{publicKey: PublicKey, account: object}|null>}
 */
async function fetchAuthorityConfig(program, mintAddress) {
  try {
    const mint = new PublicKey(mintAddress);
    const [projectStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('project'), mint.toBuffer()],
      program.programId
    );
    const [authorityConfigPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('authority'), projectStatePDA.toBuffer()],
      program.programId
    );
    const account = await program.account.authorityConfig.fetch(authorityConfigPDA);
    return { publicKey: authorityConfigPDA, account };
  } catch (err) {
    // FIX SDK-21: Only swallow "account does not exist" errors
    // FIX H-R5-3 (round 6): Legacy accounts predating can_set_merkle_root field will
    // fail to deserialize. Return null so the client can either re-init or treat as missing.
    const msg = err?.message || String(err);
    if (/Account does not exist|Could not find/i.test(msg)) {
      return null;
    }
    if (/Failed to deserialize|AccountDidNotDeserialize|invalid account data|Reached end of buffer|Unexpected length of input|unexpected end/i.test(msg)) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[mammoth-sdk] AuthorityConfig deserialization failed — likely a legacy account. Run update_authority to migrate.`);
      }
      return null;
    }
    throw err;
  }
}

module.exports = {
  fetchAllProjects,
  fetchProject,
  fetchCycle,
  fetchActiveCycle,
  fetchHolderRights,
  getBalance,
  fetchAuthorityConfig,
};
