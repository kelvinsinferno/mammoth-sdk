/**
 * instructions.js — Mammoth Protocol instruction builders
 *
 * Low-level instruction builders that map directly to on-chain program instructions.
 * These are used internally by MammothClient. You can also use them directly if you
 * need fine-grained control over transactions.
 *
 * All functions accept an Anchor Program instance + params and return a transaction
 * signature string (or result object on createProject).
 */

'use strict';

const { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair } = require('@solana/web3.js');
const { BN } = require('@coral-xyz/anchor');
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const {
  getProjectStatePDA,
  getCycleStatePDA,
  getHolderRightsPDA,
  getProtocolConfigPDA,
  getProtocolTreasuryPDA,
  getReservePDA,
} = require('./pdas');
const { parseTxError, MammothError, ErrorCode } = require('./errors');
const { solToLamports } = require('./curves');

// ─── createProject ────────────────────────────────────────────────────────────

/**
 * Create a new Mammoth project on-chain.
 * Generates a new mint keypair internally unless one is provided.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {object} params
 * @param {object}  params.supplyMode — { fixed: {} } | { elastic: {} }
 * @param {BN|number} params.totalSupply — total token supply in base units (6 decimals)
 * @param {number}  params.publicAllocationBps — BPS allocated for public sale (e.g. 6000 = 60%)
 * @param {number}  params.creatorBps — creator SOL revenue share BPS
 * @param {number}  params.reserveBps — reserve SOL split BPS
 * @param {number}  params.sinkBps — sink SOL split BPS
 * @param {BN|null} [params.launchAt=null] — Unix timestamp (BN) to lock until, or null
 * @param {Keypair} [params.mintKeypair] — optional existing mint keypair (generated if omitted)
 * @returns {Promise<{tx: string, mint: string, projectState: PublicKey}>}
 * @throws {MammothError}
 */
async function createProject(program, params) {
  try {
    const {
      supplyMode = { fixed: {} },
      totalSupply,
      publicAllocationBps,
      creatorBps,
      reserveBps,
      sinkBps,
      launchAt = null,
      operatorType = { human: {} }, // FIX SDK-6: Pass operatorType to on-chain instruction
      mintKeypair: providedMintKeypair,
    } = params;

    if (!totalSupply) {
      throw new MammothError(ErrorCode.INVALID_PARAMS, 'totalSupply is required');
    }

    // FIX SDK-12: Validate BPS sums client-side — matches on-chain validation
    if (creatorBps + reserveBps + sinkBps !== 10000) {
      throw new MammothError(
        ErrorCode.INVALID_PARAMS,
        `creatorBps + reserveBps + sinkBps must sum to 10000, got ${creatorBps + reserveBps + sinkBps}`
      );
    }
    if (publicAllocationBps < 0 || publicAllocationBps > 10000) {
      throw new MammothError(ErrorCode.INVALID_PARAMS, 'publicAllocationBps must be 0-10000');
    }

    const mintKeypair = providedMintKeypair || Keypair.generate();
    const mintPubkey = mintKeypair.publicKey;
    const creatorPubkey = program.provider.publicKey;

    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const [protocolTreasuryPda] = getProtocolTreasuryPDA();
    const [protocolConfigPda] = getProtocolConfigPDA();

    const protocolTreasuryToken = getAssociatedTokenAddressSync(mintPubkey, protocolTreasuryPda, true);
    const creatorToken = getAssociatedTokenAddressSync(mintPubkey, creatorPubkey, false);
    const projectEscrowToken = getAssociatedTokenAddressSync(mintPubkey, projectStatePda, true);

    const totalSupplyBN = BN.isBN(totalSupply) ? totalSupply : new BN(totalSupply);

    const tx = await program.methods
      .createProject(
        supplyMode,
        totalSupplyBN,
        publicAllocationBps,
        creatorBps,
        reserveBps,
        sinkBps,
        launchAt,
        operatorType
      )
      .accounts({
        mint: mintPubkey,
        projectState: projectStatePda,
        protocolTreasury: protocolTreasuryPda,
        protocolTreasuryToken,
        creatorToken,
        projectEscrowToken,
        protocolConfig: protocolConfigPda,
        creator: creatorPubkey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: 'confirmed' });

    return { tx, mint: mintPubkey.toBase58(), projectState: projectStatePda };
  } catch (err) {
    throw parseTxError(err);
  }
}

// ─── openCycle ────────────────────────────────────────────────────────────────

/**
 * Open a new issuance cycle for a project.
 * Creator-only instruction. Cycle index is derived from project state.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress — the project's token mint
 * @param {object} params
 * @param {'step'|'linear'|'expLite'} params.curveType — pricing curve
 * @param {number} params.supplyCap — total tokens to sell this cycle (base units)
 * @param {number} params.startPrice — starting price in SOL
 * @param {number} [params.rightsWindowDuration=0] — rights window duration in seconds (0 = no rights window)
 * @param {number} [params.stepSize=0] — tokens per step (step curve only)
 * @param {number} [params.stepIncrement=0] — SOL price increase per step (step curve only)
 * @param {number} [params.endPrice=0] — ending price in SOL (linear curve only)
 * @param {number} [params.growthFactorK=0] — growth factor k (expLite curve; passed as raw u64 to contract). Contract formula: price = base + base*k*pct_bps/10000/10000. Typical values: 5000-20000 for moderate growth.
 * @param {BN|number|null} [params.activatesAt=null] — optional Unix timestamp (seconds). When set, the on-chain program rejects buy_tokens / exercise_rights / claim_rights until clock >= activates_at. The rights window is shifted to open at activates_at and close at activates_at + rightsWindowDuration. Enables scheduled launches for any cycle (1st or Nth) with a single signature now — activate_cycle is permissionless and auto-triggers once T passes.
 * @returns {Promise<{tx: string, cycleIndex: number, cycleState: PublicKey}>}
 * @throws {MammothError}
 */
async function openCycle(program, mintAddress, params) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const creatorPubkey = program.provider.publicKey;

    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const projectState = await program.account.projectState.fetch(projectStatePda);
    const nextCycleIndex = projectState.currentCycle; // currentCycle is count of opened cycles; next = same value (0-based index)
    const [cycleStatePda] = getCycleStatePDA(projectStatePda, nextCycleIndex);

    const {
      curveType: curveTypeStr,
      supplyCap,
      startPrice,
      rightsWindowDuration = 0,
      stepSize = 0,
      stepIncrement = 0,
      endPrice = 0,
      growthFactorK = 0,
      activatesAt = null,
    } = params;

    const curveType =
      curveTypeStr === 'step' ? { step: {} }
      : curveTypeStr === 'linear' ? { linear: {} }
      : { expLite: {} };

    const activatesAtBN = activatesAt == null
      ? null
      : (BN.isBN(activatesAt) ? activatesAt : new BN(activatesAt));

    const projectEscrowToken = getAssociatedTokenAddressSync(mintPubkey, projectStatePda, true);

    const tx = await program.methods
      .openCycle(
        curveType,
        new BN(supplyCap),
        new BN(solToLamports(startPrice)),
        new BN(rightsWindowDuration),
        new BN(stepSize),
        new BN(solToLamports(stepIncrement)),
        new BN(solToLamports(endPrice)),
        new BN(growthFactorK), // raw u64 — contract divides by 10000*10000 internally
        activatesAtBN
      )
      .accounts({
        projectState: projectStatePda,
        cycleState: cycleStatePda,
        projectEscrowToken,
        mint: mintPubkey,
        caller: creatorPubkey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: 'confirmed' });

    return { tx, cycleIndex: nextCycleIndex, cycleState: cycleStatePda };
  } catch (err) {
    throw parseTxError(err);
  }
}

// ─── closeCycle ───────────────────────────────────────────────────────────────

/**
 * Close the active cycle for a project. Creator-only.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress
 * @returns {Promise<{tx: string}>}
 * @throws {MammothError}
 */
async function closeCycle(program, mintAddress) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const creatorPubkey = program.provider.publicKey;

    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const projectState = await program.account.projectState.fetch(projectStatePda);
    const _cc = typeof projectState.currentCycle === 'number'
      ? projectState.currentCycle
      : projectState.currentCycle.toNumber();
    const cycleIndex = _cc - 1;

    if (cycleIndex < 0) {
      throw new MammothError(ErrorCode.NOT_ACTIVE, 'No open cycle to close');
    }

    const [cycleStatePda] = getCycleStatePDA(projectStatePda, cycleIndex);
    const [reservePda] = getReservePDA(projectStatePda);

    const tx = await program.methods
      .closeCycle()
      .accounts({
        projectState: projectStatePda,
        cycleState: cycleStatePda,
        reserve: reservePda,
        creator: creatorPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: 'confirmed' });

    return { tx };
  } catch (err) {
    throw parseTxError(err);
  }
}

// ─── setHardCap ───────────────────────────────────────────────────────────────

/**
 * Set a hard cap on total supply for an Elastic supply project. Irreversible.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress
 * @param {number|BN} hardCapAmount — hard cap in base units (6 decimals)
 * @returns {Promise<{tx: string}>}
 * @throws {MammothError}
 */
async function setHardCap(program, mintAddress, hardCapAmount) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const creatorPubkey = program.provider.publicKey;
    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const hardCapBN = BN.isBN(hardCapAmount) ? hardCapAmount : new BN(hardCapAmount);

    const tx = await program.methods
      .setHardCap(hardCapBN)
      .accounts({
        projectState: projectStatePda,
        creator: creatorPubkey,
      })
      .rpc({ commitment: 'confirmed' });

    return { tx };
  } catch (err) {
    throw parseTxError(err);
  }
}

// ─── buyTokens ────────────────────────────────────────────────────────────────

/**
 * Buy tokens from the active cycle of a project.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress
 * @param {number|BN} amount — number of tokens to buy (base units)
 * @returns {Promise<{tx: string, amount: number}>}
 * @throws {MammothError}
 */
async function buyTokens(program, mintAddress, amount, maxSolCost) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const buyerPubkey = program.provider.publicKey;

    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const projectState = await program.account.projectState.fetch(projectStatePda);
    // FIX H4/H5: currentCycle may be u8 (number) or BN — normalize
    const currentCycle = typeof projectState.currentCycle === 'number'
      ? projectState.currentCycle
      : projectState.currentCycle.toNumber();
    const cycleIndex = currentCycle - 1;

    if (cycleIndex < 0) {
      throw new MammothError(ErrorCode.NOT_ACTIVE, 'No active cycle for this project');
    }

    const [cycleStatePda] = getCycleStatePDA(projectStatePda, cycleIndex);
    const [protocolConfigPda] = getProtocolConfigPDA();
    const [protocolTreasuryPda] = getProtocolTreasuryPDA();
    const buyerToken = getAssociatedTokenAddressSync(mintPubkey, buyerPubkey);

    const amountBN = BN.isBN(amount) ? amount : new BN(amount);
    // FIX TOCTOU: If maxSolCost not provided, use u64::MAX (disabled slippage check).
    // Callers SHOULD provide a cap computed from computeBuyQuote for safety.
    const maxCostBN = maxSolCost != null
      ? (BN.isBN(maxSolCost) ? maxSolCost : new BN(maxSolCost))
      : new BN('18446744073709551615'); // u64::MAX

    const tx = await program.methods
      .buyTokens(amountBN, maxCostBN)
      .accounts({
        projectState: projectStatePda,
        cycleState: cycleStatePda,
        protocolConfig: protocolConfigPda,
        protocolTreasury: protocolTreasuryPda,
        buyerToken,
        mint: mintPubkey,
        buyer: buyerPubkey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: 'confirmed' });

    return { tx, amount: Number(amount) };
  } catch (err) {
    throw parseTxError(err);
  }
}

// ─── exerciseRights ───────────────────────────────────────────────────────────

/**
 * Exercise previously allocated rights during the RightsWindow.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress
 * @param {number|BN} amount — token amount to exercise (base units)
 * @returns {Promise<{tx: string, amount: number}>}
 * @throws {MammothError}
 */
async function exerciseRights(program, mintAddress, amount, maxSolCost) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const holderPubkey = program.provider.publicKey;

    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const projectState = await program.account.projectState.fetch(projectStatePda);
    const _cc = typeof projectState.currentCycle === 'number'
      ? projectState.currentCycle
      : projectState.currentCycle.toNumber();
    const cycleIndex = _cc - 1;

    if (cycleIndex < 0) {
      throw new MammothError(ErrorCode.NOT_RIGHTS_WINDOW, 'No active cycle for rights exercise');
    }

    const [cycleStatePda] = getCycleStatePDA(projectStatePda, cycleIndex);
    const [holderRightsPda] = getHolderRightsPDA(cycleStatePda, holderPubkey);
    const [protocolConfigPda] = getProtocolConfigPDA();
    const [protocolTreasuryPda] = getProtocolTreasuryPDA();
    const holderToken = getAssociatedTokenAddressSync(mintPubkey, holderPubkey);
    // FIX H2 (round 10): Include project_escrow_token — required by contract for token transfer
    const projectEscrowToken = getAssociatedTokenAddressSync(mintPubkey, projectStatePda, true);

    const amountBN = BN.isBN(amount) ? amount : new BN(amount);
    // FIX TOCTOU: slippage cap
    const maxCostBN = maxSolCost != null
      ? (BN.isBN(maxSolCost) ? maxSolCost : new BN(maxSolCost))
      : new BN('18446744073709551615');

    const tx = await program.methods
      .exerciseRights(amountBN, maxCostBN)
      .accounts({
        projectState: projectStatePda,
        cycleState: cycleStatePda,
        holderRights: holderRightsPda,
        protocolConfig: protocolConfigPda,
        protocolTreasury: protocolTreasuryPda,
        projectEscrowToken,
        holderToken,
        mint: mintPubkey,
        holder: holderPubkey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: 'confirmed' });

    return { tx, amount: Number(amount) };
  } catch (err) {
    throw parseTxError(err);
  }
}

// ─── activateCycle ────────────────────────────────────────────────────────────

/**
 * Activate a cycle that has passed its RightsWindow. Permissionless.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {string|PublicKey} mintAddress
 * @param {number} cycleIndex — index of the cycle to activate
 * @returns {Promise<{tx: string}>}
 * @throws {MammothError}
 */
async function activateCycle(program, mintAddress, cycleIndex) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const [cycleStatePda] = getCycleStatePDA(projectStatePda, cycleIndex);

    const tx = await program.methods
      .activateCycle()
      .accounts({
        projectState: projectStatePda,
        cycleState: cycleStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: 'confirmed' });

    return { tx };
  } catch (err) {
    throw parseTxError(err);
  }
}

/**
 * Initialize AuthorityConfig for a project — delegate operations to an AI agent or operator.
 * Principal (creator) sets what the operator can do autonomously.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {object} params
 * @param {string} params.mintAddress
 * @param {string} params.operator — operator wallet address (base58)
 * @param {boolean} [params.canOpenCycle=true]
 * @param {boolean} [params.canCloseCycle=false]
 * @param {boolean} [params.canSetHardCap=false] — DANGEROUS — off by default
 * @param {boolean} [params.canRouteTreasury=false]
 * @param {number} [params.spendingLimitLamports=0] — 0 = no limit
 * @returns {Promise<{signature: string}>}
 */
async function initializeAuthority(program, params) {
  try {
    const mintPubkey = new PublicKey(params.mintAddress);
    const operatorPubkey = new PublicKey(params.operator);

    // Derive project_state PDA
    const [projectStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('project'), mintPubkey.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .initializeAuthority(
        operatorPubkey,
        params.canOpenCycle ?? true,
        params.canCloseCycle ?? false,
        params.canSetHardCap ?? false,
        params.canRouteTreasury ?? false,
        new BN(params.spendingLimitLamports ?? 0)
      )
      .accounts({
        projectState: projectStatePDA,
        principal: program.provider.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: 'confirmed' });

    return { signature: tx };
  } catch (err) {
    throw parseTxError(err);
  }
}

/**
 * Update an existing AuthorityConfig. Principal-only.
 *
 * @param {import('@coral-xyz/anchor').Program} program
 * @param {object} params — same fields as initializeAuthority
 * @returns {Promise<{signature: string}>}
 */
async function updateAuthority(program, params) {
  try {
    const mintPubkey = new PublicKey(params.mintAddress);
    const operatorPubkey = new PublicKey(params.operator);

    const [projectStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('project'), mintPubkey.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .updateAuthority(
        operatorPubkey,
        params.canOpenCycle ?? true,
        params.canCloseCycle ?? false,
        params.canSetHardCap ?? false,
        params.canRouteTreasury ?? false,
        new BN(params.spendingLimitLamports ?? 0)
      )
      .accounts({
        projectState: projectStatePDA,
        principal: program.provider.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: 'confirmed' });

    return { signature: tx };
  } catch (err) {
    throw parseTxError(err);
  }
}

/**
 * FIX C2 (round 10): Set Merkle root for rights distribution.
 * @param {Program} program
 * @param {string|PublicKey} mintAddress
 * @param {Buffer|Uint8Array|number[]} merkleRoot — 32-byte root from MerkleRightsTree
 * @param {number} holderCount — informational
 * @param {number|BN|bigint} totalCommitted — total rights amount committed by tree (MerkleRightsTree.totalCommitted)
 * @returns {Promise<{signature: string}>}
 */
async function setRightsMerkleRoot(program, mintAddress, merkleRoot, holderCount, totalCommitted) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const projectState = await program.account.projectState.fetch(projectStatePda);
    const _cc = typeof projectState.currentCycle === 'number'
      ? projectState.currentCycle
      : projectState.currentCycle.toNumber();
    const cycleIndex = _cc - 1;
    if (cycleIndex < 0) {
      throw new MammothError(ErrorCode.NOT_RIGHTS_WINDOW, 'No cycle open');
    }
    const [cycleStatePda] = getCycleStatePDA(projectStatePda, cycleIndex);
    const rootArray = Array.isArray(merkleRoot) ? merkleRoot : Array.from(merkleRoot);
    if (rootArray.length !== 32) {
      throw new MammothError(ErrorCode.INVALID_PARAMS, `merkleRoot must be 32 bytes, got ${rootArray.length}`);
    }
    const committedBN = BN.isBN(totalCommitted)
      ? totalCommitted
      : new BN(typeof totalCommitted === 'bigint' ? totalCommitted.toString() : totalCommitted);
    const tx = await program.methods
      .setRightsMerkleRoot(rootArray, holderCount, committedBN)
      .accounts({
        projectState: projectStatePda,
        cycleState: cycleStatePda,
        authorityConfig: null,
        caller: program.provider.publicKey,
      })
      .rpc({ commitment: 'confirmed' });
    return { signature: tx };
  } catch (err) {
    throw parseTxError(err);
  }
}

/**
 * FIX H6 (round 10): Rotate project creator to a new wallet.
 */
async function rotateCreator(program, mintAddress, newCreator) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const [projectStatePda] = getProjectStatePDA(mintPubkey);
    const newCreatorPubkey = new PublicKey(newCreator);
    const tx = await program.methods
      .rotateCreator(newCreatorPubkey)
      .accounts({
        projectState: projectStatePda,
        currentCreator: program.provider.publicKey,
      })
      .rpc({ commitment: 'confirmed' });
    return { signature: tx };
  } catch (err) {
    throw parseTxError(err);
  }
}

module.exports = {
  createProject,
  openCycle,
  closeCycle,
  setHardCap,
  buyTokens,
  exerciseRights,
  activateCycle,
  initializeAuthority,
  updateAuthority,
  setRightsMerkleRoot,
  rotateCreator,
};
