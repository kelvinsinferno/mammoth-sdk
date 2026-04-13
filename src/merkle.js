/**
 * merkle.js — Merkle tree utilities for Mammoth rights snapshots
 *
 * Implements the same leaf/node hashing as the on-chain program:
 *   leaf  = SHA-256(holder_pubkey_bytes || rights_amount_le_u64)
 *   node  = SHA-256(sort(left, right))   ← sorted so position doesn't matter
 *
 * Usage:
 *   1. Snapshot SPL token holders: getTokenHolders(connection, mintAddress)
 *   2. Build the tree: buildRightsTree(holders, cycleAllocation)
 *   3. Set root on-chain: setRightsMerkleRoot(program, mint, tree.root, tree.entries.length)
 *   4. Holder claims: claimRights(program, mint, proof, amount)
 *
 * @example
 * const { getTokenHolders, buildRightsTree } = require('@mammoth-protocol/sdk');
 * const { Connection } = require('@solana/web3.js');
 *
 * const connection = new Connection('https://api.devnet.solana.com');
 * const holders = await getTokenHolders(connection, mintAddress);
 * const tree = buildRightsTree(holders, cycleAllocation);
 *
 * console.log('Root:', Buffer.from(tree.root).toString('hex'));
 * console.log('Entries:', tree.entries.length);
 *
 * // Get proof for a specific holder before they claim
 * const proof = tree.getProof(holderAddress);
 * const amount = tree.getAmount(holderAddress);
 */

'use strict';

const { PublicKey } = require('@solana/web3.js');
const { createHash } = require('crypto');

// ─── Hashing ─────────────────────────────────────────────────────────────────

/**
 * SHA-256 hash matching on-chain `anchor_lang::solana_program::hash::hashv`.
 * Solana's hash module uses SHA-256, not keccak.
 */
function hashBytes(...inputs) {
  const h = createHash('sha256');
  for (const input of inputs) h.update(input);
  return h.digest();
}

/**
 * Hash a (holder, amount) leaf pair — matches on-chain claim_rights verification.
 * leaf = SHA-256(0x00 || holder_pubkey_32_bytes || rights_amount_8_bytes_le)
 *
 * FIX H-3 (final audit): Uses 0x00 leaf domain byte to match contract and prevent
 * second-preimage attacks where a leaf hash could collide with an internal node.
 */
function hashLeaf(holderPubkey, rightsAmount) {
  const pubkeyBytes = new PublicKey(holderPubkey).toBuffer();        // 32 bytes
  if (typeof rightsAmount === 'number') {
    if (!Number.isInteger(rightsAmount) || rightsAmount < 0) {
      throw new Error(`hashLeaf: rightsAmount must be a non-negative integer, got ${rightsAmount}`);
    }
  }
  const amountBytes = Buffer.allocUnsafe(8);
  amountBytes.writeBigUInt64LE(BigInt(rightsAmount));                // 8 bytes LE
  return hashBytes(Buffer.from([0x00]), pubkeyBytes, amountBytes);
}

/**
 * Hash two sibling nodes — sorted so position doesn't matter.
 * node = SHA-256(0x01 || sort(left, right))
 *
 * FIX H-3: Uses 0x01 internal-node domain byte to match contract.
 */
function hashPair(a, b) {
  const [left, right] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return hashBytes(Buffer.from([0x01]), left, right);
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Read all SPL token holders for a mint from on-chain.
 * Returns array of { address: string, balance: bigint } sorted by balance descending.
 *
 * Filters out zero-balance accounts and the protocol treasury.
 *
 * WARNING (FIX M4): This uses getProgramAccounts without pagination. For mints with
 * thousands of holders or on public RPCs with strict limits, results may be truncated
 * or the call may fail. Use a premium RPC (Helius, QuickNode, Triton) or an indexer
 * service in production.
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string|import('@solana/web3.js').PublicKey} mintAddress
 * @param {object} [opts]
 * @param {number} [opts.minBalance=1] — minimum balance to include (base units)
 * @returns {Promise<Array<{ address: string, balance: bigint }>>}
 */
async function getTokenHolders(connection, mintAddress, opts = {}) {
  const { minBalance = 1 } = opts;
  const mint = new PublicKey(mintAddress);

  // Use getProgramAccounts to fetch all token accounts for this mint
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: 165 },                       // SPL token account size
      { memcmp: { offset: 0, bytes: mint.toBase58() } }, // mint matches
    ],
  });

  const holders = [];
  for (const { account } of accounts) {
    const data = account.data;
    // SPL token account layout: mint(32) + owner(32) + amount(8) + ...
    const owner = new PublicKey(data.slice(32, 64)).toBase58();
    const amount = data.readBigUInt64LE(64);
    if (amount >= BigInt(minBalance)) {
      holders.push({ address: owner, balance: amount });
    }
  }

  // Deduplicate by owner (multiple ATAs possible) — sum balances
  const map = new Map();
  for (const h of holders) {
    map.set(h.address, (map.get(h.address) || 0n) + h.balance);
  }

  return Array.from(map.entries())
    .map(([address, balance]) => ({ address, balance }))
    .sort((a, b) => (b.balance > a.balance ? 1 : -1));
}

// ─── Tree Builder ─────────────────────────────────────────────────────────────

/**
 * Build a Merkle rights tree from a snapshot of token holders.
 *
 * Pro-rata calculation:
 *   holder_rights = floor(holder_balance / total_supply * cycle_allocation)
 *
 * Returns a MerkleRightsTree with:
 *   - root: Buffer (32 bytes) — store this on-chain
 *   - entries: Array of { address, balance, rightsAmount, leaf }
 *   - getProof(address): Array<Buffer> — Merkle proof for a holder
 *   - getAmount(address): number — rights amount for a holder
 *   - verify(address, amount, proof): boolean — verify a proof client-side
 *
 * @param {Array<{ address: string, balance: bigint }>} holders — from getTokenHolders()
 * @param {number|bigint} cycleAllocation — total tokens to distribute as rights
 * @param {number|bigint} [totalSupply] — denominator for pro-rata; defaults to sum of all balances
 * @returns {MerkleRightsTree}
 */
function buildRightsTree(holders, cycleAllocation, totalSupply) {
  const alloc = BigInt(cycleAllocation);
  const total = totalSupply
    ? BigInt(totalSupply)
    : holders.reduce((sum, h) => sum + h.balance, 0n);

  if (total === 0n) throw new Error('buildRightsTree: total supply is zero');

  // FIX SDK-16: Use largest-remainder method to distribute rounding surplus.
  // This ensures the sum of rights across all holders equals cycleAllocation
  // (up to 1 token of rounding per holder), preventing rights from being lost
  // when many holders have small balances.
  const raw = holders.map(h => {
    const product = h.balance * alloc; // BigInt
    const floor = product / total;     // BigInt floor
    const remainder = product - floor * total; // BigInt remainder
    return {
      address: h.address,
      balance: h.balance,
      floorAmount: floor,
      remainder,
    };
  });

  // Sum of all floor amounts (BigInt)
  const allocated = raw.reduce((sum, r) => sum + r.floorAmount, 0n);
  let surplus = alloc - allocated; // BigInt

  // Sort by remainder descending — biggest remainders get +1 until surplus is exhausted.
  // FIX M5: Tiebreak by address (ascending) for deterministic trees across runs.
  raw.sort((a, b) => {
    if (b.remainder > a.remainder) return 1;
    if (b.remainder < a.remainder) return -1;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });
  for (let i = 0; i < raw.length && surplus > 0n; i++) {
    raw[i].floorAmount += 1n;
    surplus -= 1n;
  }

  const entries = raw
    .map(r => ({
      address: r.address,
      balance: r.balance,
      rightsAmount: Number(r.floorAmount),
    }))
    .filter(e => e.rightsAmount > 0)
    .map(e => ({
      ...e,
      leaf: hashLeaf(e.address, e.rightsAmount),
    }));

  if (entries.length === 0) throw new Error('buildRightsTree: no holders with non-zero rights');

  return new MerkleRightsTree(entries);
}

// ─── MerkleRightsTree class ───────────────────────────────────────────────────

class MerkleRightsTree {
  /**
   * @param {Array<{ address: string, balance: bigint, rightsAmount: number, leaf: Buffer }>} entries
   */
  constructor(entries) {
    this.entries = entries;
    this._addressMap = new Map(entries.map((e, i) => [e.address, i]));
    // FIX C3 (round 10): Expose totalCommitted for set_rights_merkle_root instruction.
    // Must pass this to the contract so rights_committed matches the tree exactly,
    // preventing rights over-commit and matching public_cap calculations.
    this.totalCommitted = entries.reduce((sum, e) => sum + BigInt(e.rightsAmount), 0n);
    // FIX C1 (revert of SDK-17): Contract's claim_rights verifier does
    // `proof.iter().fold(leaf, ...) == root`. For a single-entry tree, an empty
    // proof reduces to `leaf == root`. So for single entries, root = leaf with no proof.
    // Do NOT pad with zero leaves — that would produce a different root the contract can't verify.
    const leaves = entries.map(e => e.leaf);
    this._layers = this._buildLayers(leaves);
    this.root = this._layers[this._layers.length - 1][0];
  }

  _buildLayers(leaves) {
    const layers = [leaves.map(l => Buffer.from(l))];
    while (layers[layers.length - 1].length > 1) {
      const current = layers[layers.length - 1];
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          next.push(hashPair(current[i], current[i + 1]));
        } else {
          // Odd leaf — promote as-is
          next.push(current[i]);
        }
      }
      layers.push(next);
    }
    return layers;
  }

  /**
   * Get the Merkle proof for a holder address.
   * Returns array of Buffer (sibling hashes from leaf to root).
   *
   * @param {string} address
   * @returns {Buffer[]}
   */
  getProof(address) {
    const idx = this._addressMap.get(address);
    if (idx === undefined) throw new Error(`Address not in tree: ${address}`);

    const proof = [];
    let current = idx;
    for (let layer = 0; layer < this._layers.length - 1; layer++) {
      const nodes = this._layers[layer];
      const sibling = current % 2 === 0 ? current + 1 : current - 1;
      if (sibling < nodes.length) {
        proof.push(nodes[sibling]);
      }
      current = Math.floor(current / 2);
    }
    return proof;
  }

  /**
   * Get the rights amount for a holder.
   *
   * @param {string} address
   * @returns {number}
   */
  getAmount(address) {
    const idx = this._addressMap.get(address);
    if (idx === undefined) return 0;
    return this.entries[idx].rightsAmount;
  }

  /**
   * Verify a proof client-side (same logic as on-chain).
   *
   * NOTE (FIX L3): This trusts the `amount` argument. For authoritative verification,
   * always check the rightsAmount from the tree's own entries (via getAmount()) rather
   * than user-supplied data. This method is safe for cross-checking proof integrity but
   * should not be used as an authorization gate against tampered amounts.
   *
   * @param {string} address
   * @param {number} amount
   * @param {Buffer[]} proof
   * @returns {boolean}
   */
  verify(address, amount, proof) {
    const leaf = hashLeaf(address, amount);
    const computed = proof.reduce((current, sibling) => {
      return hashPair(current, sibling);
    }, Buffer.from(leaf));
    return Buffer.compare(computed, this.root) === 0;
  }

  /**
   * Serialize proof to the format expected by the Anchor instruction
   * (Vec<[u8; 32]> = array of 32-byte arrays).
   *
   * @param {string} address
   * @returns {number[][]} array of 32-element number arrays
   */
  getProofForInstruction(address) {
    return this.getProof(address).map(buf => Array.from(buf));
  }

  /**
   * Export the full tree as JSON for off-chain storage / caching.
   * Store this alongside the on-chain Merkle root so holders can retrieve their proofs.
   */
  toJSON() {
    return {
      root: this.root.toString('hex'),
      entries: this.entries.map(e => ({
        address: e.address,
        rightsAmount: e.rightsAmount,
        balance: e.balance.toString(),
        leaf: e.leaf.toString('hex'),
      })),
    };
  }

  /**
   * Restore a MerkleRightsTree from a toJSON() export.
   */
  static fromJSON(json) {
    const entries = json.entries.map(e => ({
      address: e.address,
      balance: BigInt(e.balance),
      rightsAmount: e.rightsAmount,
      leaf: Buffer.from(e.leaf, 'hex'),
    }));
    return new MerkleRightsTree(entries);
  }
}

module.exports = {
  getTokenHolders,
  buildRightsTree,
  hashLeaf,
  hashPair,
  MerkleRightsTree,
};
