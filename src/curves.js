/**
 * curves.js — Pure curve math for Mammoth Protocol
 *
 * All functions are pure and synchronous — no on-chain dependencies.
 * These mirror the on-chain curve logic so agents and UIs can compute
 * prices and quotes without making RPC calls.
 *
 * Prices are always expressed in SOL (float). Lamport conversions are
 * provided as helpers.
 */

'use strict';

const { LAMPORTS_PER_SOL } = require('./constants');

// ─── Unit helpers ─────────────────────────────────────────────────────────────

/**
 * Convert lamports (on-chain u64) to SOL (float).
 *
 * @param {number|bigint|import('@coral-xyz/anchor').BN} lamports
 * @returns {number}
 */
function lamportsToSol(lamports) {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/**
 * Convert SOL (float) to lamports as an integer.
 *
 * @param {number} sol
 * @returns {number}
 */
function solToLamports(sol) {
  // FIX M2: Validate input before conversion
  if (typeof sol !== 'number' || !Number.isFinite(sol) || sol < 0) {
    throw new Error(`solToLamports: sol must be a non-negative finite number, got ${sol}`);
  }
  // FIX SDK-9: Use Math.round to handle float representation edge cases
  // e.g., 0.1 * 1e9 = 100000000.00000001 — floor would lose 1 lamport
  return Math.round(sol * LAMPORTS_PER_SOL);
}

// FIX M1 (round 10): Module-level BN→Number helper with precision warning.
// Used by computePrice and computeBuyQuote for u64 fields that may exceed 2^53.
function _toSafeNumber(v, name) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) && typeof v !== 'number') {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[mammoth-sdk] ${name}=${v} exceeds Number.MAX_SAFE_INTEGER; curve math may lose precision`);
    }
  }
  return n;
}

// ─── Price computation ────────────────────────────────────────────────────────

/**
 * Compute the current token price (in SOL) given a CycleState account object.
 * The cycleState object uses camelCase field names as returned by Anchor 0.30+.
 *
 * @param {object} cycleState — on-chain CycleState (camelCase from Anchor fetch)
 * @param {object} cycleState.curveType — { step: {} } | { linear: {} } | { expLite: {} }
 * @param {number|bigint} cycleState.basePrice — lamports
 * @param {number|bigint} cycleState.stepSize — base units
 * @param {number|bigint} cycleState.stepIncrement — lamports per step
 * @param {number|bigint} cycleState.minted — tokens minted so far
 * @param {number|bigint} cycleState.supplyCap — total cycle supply cap
 * @param {number|bigint} [cycleState.endPrice] — lamports, for linear curve
 * @param {number|bigint} [cycleState.growthFactorK] — k * 1000, for expLite curve
 * @param {number|bigint} [cycleState.rightsReservedAtActivation] — (used by computeBuyQuote) tokens reserved from public buyers; snapshotted at activation
 * @returns {number} current price in SOL
 */
function computePrice(cycleState) {
  if (!cycleState) return 0;

  const {
    curveType,
    basePrice,
    stepSize,
    stepIncrement,
    minted,
    supplyCap,
    endPrice,
    growthFactorK,
  } = cycleState;

  // FIX H1/H2: Precision warning on large u64 values (uses module-level _toSafeNumber)
  const basePriceSol = lamportsToSol(basePrice);
  const mintedN = _toSafeNumber(minted, 'minted');
  const supplyCapN = _toSafeNumber(supplyCap, 'supplyCap');

  if (curveType.step !== undefined) {
    const stepSizeN = Number(stepSize);
    const stepIncrSol = lamportsToSol(stepIncrement);
    const stepIndex = stepSizeN > 0 ? Math.floor(mintedN / stepSizeN) : 0;
    return basePriceSol + stepIndex * stepIncrSol;
  }

  if (curveType.linear !== undefined) {
    const endPriceSol = lamportsToSol(endPrice || 0);
    const t = supplyCapN > 0 ? mintedN / supplyCapN : 0;
    // FIX L6: Match contract's saturating_sub — spread clamped to 0 if end < base
    const spread = Math.max(0, endPriceSol - basePriceSol);
    return basePriceSol + spread * t;
  }

  if (curveType.expLite !== undefined) {
    // FIX (post re-audit): Match the contract's actual formula — NOT true exp.
    // Contract: pct_consumed = minted * 10000 / supply_cap
    //           price = base + (base * k * pct_consumed / 10000 / 10000)
    // k is stored as a raw u64 (not multiplied), so we use it directly.
    if (supplyCapN === 0) return basePriceSol;
    const k = Number(growthFactorK || 0);
    const basePriceLamports = Number(basePrice);
    const pctConsumed = Math.floor(mintedN * 10000 / supplyCapN);
    const growth = Math.floor(basePriceLamports * k * pctConsumed / 10000 / 10000);
    return lamportsToSol(basePriceLamports + growth);
  }

  // Fallback for unknown curve types
  return basePriceSol;
}

/**
 * Compute a buy quote: how many tokens a buyer receives for `solIn` SOL
 * given the current cycle state, accounting for fees and step boundaries.
 *
 * Returns a full quote object including fee, effective price, and post-purchase state.
 *
 * @param {object} cycleState — on-chain CycleState (camelCase)
 * @param {number} solIn — SOL amount the buyer wants to spend
 * @param {number} [feeBps=200] — protocol fee in basis points (default 2%)
 * @returns {{
 *   tokensOut: number,
 *   effectivePrice: number,
 *   fee: number,
 *   newPrice: number,
 *   nextStepIn: number|null,
 *   remainingAfter: number,
 *   soldAfter: number
 * }|null} null if inputs are invalid
 */
function computeBuyQuote(cycleState, solIn, feeBps = 200) {
  if (!cycleState || solIn <= 0) return null;

  const {
    curveType,
    basePrice,
    stepSize,
    stepIncrement,
    minted,
    supplyCap,
  } = cycleState;

  // FIX M4 (round 5): Match contract's fee-on-cost semantics.
  // Contract: total_cost = compute_total_cost(amount); fee = total_cost * feeBps / 10000;
  //           user pays total_cost (fee + net_cost carved out from that).
  // So user's full solIn covers total_cost. We find max amount where total_cost(amount) <= solIn.
  // Fee displayed = total_cost * feeBps / 10000 (computed post-binary-search).
  const solInLamports = Math.round(solIn * LAMPORTS_PER_SOL);
  let budget = solIn; // full amount — fee is inside total_cost on-chain
  // fee and feeLamports computed after we know total cost
  let feeLamports = 0;
  let fee = 0;

  const basePriceSol = lamportsToSol(basePrice);
  const stepSizeN = Number(stepSize);
  const stepIncrSol = lamportsToSol(stepIncrement);
  const mintedN = Number(minted);
  const supplyCapN = Number(supplyCap);

  // FIX C1 (round 8): Use rightsReservedAtActivation (snapshotted) instead of
  // rightsAllocated (cumulative). Contract now freezes reservation at activate_cycle.
  // Previous formula (supplyCap - max(0, rightsAllocated - minted)) eroded as public
  // buys grew minted. The snapshot is constant post-activation and matches on-chain.
  // FIX M8-1 (round 9): Remove legacy rightsAllocated fallback. That field is
  // cumulative (grows with claims), NOT a reservation. Using it would re-introduce
  // the erosion bug. Default to 0 if field absent (pre-activation state).
  // FIX M1 (round 10): Use _toSafeNumber with precision warning on u64 fields.
  // FIX H3 (round 10): Robust enum variant check — use `in` operator instead of Object.keys[0].
  let statusKey = null;
  if (cycleState.status) {
    if ('active' in cycleState.status) statusKey = 'active';
    else if ('closed' in cycleState.status) statusKey = 'closed';
    else if ('rightsWindow' in cycleState.status) statusKey = 'rightsWindow';
    else if ('pending' in cycleState.status) statusKey = 'pending';
  }
  let rightsReservedN = 0;
  if (statusKey === 'active' || statusKey === 'closed') {
    rightsReservedN = cycleState.rightsReservedAtActivation != null
      ? _toSafeNumber(cycleState.rightsReservedAtActivation, 'rightsReservedAtActivation') : 0;
  } else if (statusKey === 'rightsWindow') {
    // Pre-activation: use total Merkle commitment if set (upper bound on reservation)
    rightsReservedN = cycleState.rightsCommitted != null
      ? _toSafeNumber(cycleState.rightsCommitted, 'rightsCommitted') : 0;
  }
  const publicCap = Math.max(0, supplyCapN - rightsReservedN);
  const remaining = Math.max(0, publicCap - mintedN);

  // ── Step curve: walk through step boundaries ──────────────────────────────
  if (curveType?.step !== undefined && stepSizeN > 0) {
    let tokensSold = mintedN;
    let tokensOut = 0;

    while (budget > 0 && tokensSold < publicCap) {
      const stepIndex = Math.floor(tokensSold / stepSizeN);
      const priceNow = basePriceSol + stepIndex * stepIncrSol;
      const tokensThisStep = Math.min(
        stepSizeN - (tokensSold % stepSizeN),
        publicCap - tokensSold
      );
      const costForStep = tokensThisStep * priceNow;

      if (budget >= costForStep) {
        budget -= costForStep;
        tokensSold += tokensThisStep;
        tokensOut += tokensThisStep;
      } else {
        const partial = Math.floor(budget / priceNow);
        // FIX SDK-15: Track actual spend so effectivePrice is accurate
        budget -= partial * priceNow;
        tokensOut += partial;
        tokensSold += partial;
        break; // out of budget
      }
    }

    // FIX M4 (round 5) / M-R5-1 (round 6): Compute total_cost in SOL, convert to lamports
    // once to avoid repeated float rounding. Fee math now fully integer like other branches.
    const totalCost = solIn - budget;
    const totalCostLamports = Math.round(totalCost * LAMPORTS_PER_SOL);
    feeLamports = Math.floor(totalCostLamports * feeBps / 10000);
    fee = feeLamports / LAMPORTS_PER_SOL;
    const effectivePrice = tokensOut > 0 ? totalCost / tokensOut : basePriceSol;
    const newMinted = mintedN + tokensOut;
    const newStepIndex = stepSizeN > 0 ? Math.floor(newMinted / stepSizeN) : 0;
    const newPrice = basePriceSol + newStepIndex * stepIncrSol;
    const nextStepIn = stepSizeN - (newMinted % stepSizeN);

    return {
      tokensOut: Math.floor(tokensOut),
      effectivePrice,
      fee,
      newPrice,
      nextStepIn,
      remainingAfter: remaining - tokensOut,
      soldAfter: tokensSold,
    };
  }

  // ── Linear curve: walk BPS buckets matching contract's compute_total_cost ──
  if (curveType?.linear !== undefined) {
    if (supplyCapN === 0) return null;
    const basePriceL = Number(basePrice);
    const endPriceL = Number(cycleState.endPrice || 0);
    // FIX L6: Match contract's saturating_sub
    const spread = Math.max(0, endPriceL - basePriceL);

    // FIX H-R4-2 (final audit): Replicate contract's compute_total_cost bucket walk.
    // Price is piecewise-constant across BPS buckets of size supplyCap/10000.
    const priceAtLamports = (sold) => {
      return basePriceL + Math.floor(spread * sold / supplyCapN);
    };
    const costFor = (nTokens) => {
      if (nTokens <= 0) return 0;
      let sold = mintedN;
      const endSold = mintedN + nTokens;
      let total = 0;
      while (sold < endSold) {
        const price = priceAtLamports(sold);
        const pctConsumed = Math.floor(sold * 10000 / supplyCapN);
        const nextPct = pctConsumed + 1;
        const nextBoundary = Math.min(
          Math.ceil(nextPct * supplyCapN / 10000),
          supplyCapN
        );
        const tokensInBucket = Math.max(1, Math.min(endSold, nextBoundary) - sold);
        total += price * tokensInBucket;
        sold += tokensInBucket;
      }
      return total;
    };

    const budgetLamports = Math.floor(budget * LAMPORTS_PER_SOL);

    let lo = 0, hi = remaining;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (costFor(mid) <= budgetLamports) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const tokensOut = lo;
    const spentLamports = costFor(tokensOut);

    // FIX M4 (round 5): Compute fee from total_cost (matches contract)
    feeLamports = Math.floor(spentLamports * feeBps / 10000);
    fee = feeLamports / LAMPORTS_PER_SOL;

    const effectivePrice = tokensOut > 0
      ? (spentLamports / LAMPORTS_PER_SOL) / tokensOut
      : basePriceSol;
    const newPrice = priceAtLamports(mintedN + tokensOut) / LAMPORTS_PER_SOL;

    return {
      tokensOut,
      effectivePrice,
      fee,
      newPrice,
      nextStepIn: null,
      remainingAfter: remaining - tokensOut,
      soldAfter: mintedN + tokensOut,
    };
  }

  // ── ExpLite curve: bucket-by-bucket integration matching contract ─────
  if (curveType?.expLite !== undefined) {
    if (supplyCapN === 0) return null;
    const k = Number(cycleState.growthFactorK || 0);
    const basePriceLamports = Number(basePrice);

    // Contract formula: price(sold) = base + floor(base*k*floor(sold*10000/cap)/10000/10000)
    // Price is piecewise-constant across BPS buckets of size floor(supplyCap/10000).
    // FIX C2: Walk bucket-by-bucket, summing exact lamport cost. This mirrors
    // the contract's actual behavior and avoids midpoint underestimation.
    const priceAtLamports = (sold) => {
      const pct = Math.floor(sold * 10000 / supplyCapN);
      const growth = Math.floor(basePriceLamports * k * pct / 10000 / 10000);
      return basePriceLamports + growth;
    };

    const budgetLamports = Math.floor(budget * LAMPORTS_PER_SOL);
    let sold = mintedN;
    let tokensOut = 0;
    let spentLamports = 0;
    let remainingBudget = budgetLamports;

    // FIX H-R6-3 (round 7): Use publicCap as upper bound (H-2 rights reservation).
    // Previously used supplyCapN, letting buyers consume tokens reserved for rights.
    while (sold < publicCap && remainingBudget > 0) {
      const priceL = priceAtLamports(sold);
      if (priceL <= 0) break;
      // Find end of current BPS bucket — next boundary where price changes
      const currentPct = Math.floor(sold * 10000 / supplyCapN);
      // Next BPS boundary: ceil((currentPct+1) * supplyCap / 10000)
      const nextBoundary = Math.min(
        Math.ceil((currentPct + 1) * supplyCapN / 10000),
        publicCap  // Clamp to publicCap instead of supplyCapN
      );
      const tokensAvail = nextBoundary - sold;
      const maxAtThisPrice = Math.floor(remainingBudget / priceL);
      const buyHere = Math.min(tokensAvail, maxAtThisPrice);
      if (buyHere <= 0) break;
      sold += buyHere;
      tokensOut += buyHere;
      const costHere = buyHere * priceL;
      spentLamports += costHere;
      remainingBudget -= costHere;
    }

    // FIX M4 (round 5): Fee from total_cost
    feeLamports = Math.floor(spentLamports * feeBps / 10000);
    fee = feeLamports / LAMPORTS_PER_SOL;

    const effectivePrice = tokensOut > 0
      ? (spentLamports / LAMPORTS_PER_SOL) / tokensOut
      : basePriceSol;
    const newPrice = priceAtLamports(mintedN + tokensOut) / LAMPORTS_PER_SOL;

    return {
      tokensOut,
      effectivePrice,
      fee,
      newPrice,
      nextStepIn: null,
      remainingAfter: remaining - tokensOut,
      soldAfter: mintedN + tokensOut,
    };
  }

  // ── Fallback for unknown curve types ──────────────────────────────────
  const currentPrice = computePrice(cycleState);
  if (currentPrice <= 0) return null;
  const tokensOut = Math.min(Math.floor(budget / currentPrice), remaining);

  return {
    tokensOut,
    effectivePrice: currentPrice,
    fee,
    newPrice: currentPrice,
    nextStepIn: null,
    remainingAfter: remaining - tokensOut,
    soldAfter: mintedN + tokensOut,
  };
}

/**
 * Compute the step curve price at a specific sold quantity (offline, no cycleState needed).
 *
 * @param {object} params
 * @param {number} params.sold — tokens already sold
 * @param {number} params.startPrice — base price in SOL
 * @param {number} params.stepSize — tokens per step
 * @param {number} params.stepIncrement — SOL price increase per step
 * @returns {number} price in SOL at `sold` quantity
 */
function stepCurvePriceAt({ sold, startPrice, stepSize, stepIncrement }) {
  const stepIndex = stepSize > 0 ? Math.floor(sold / stepSize) : 0;
  return startPrice + stepIndex * stepIncrement;
}

/**
 * Compute the linear curve price at a specific sold quantity (offline).
 *
 * @param {object} params
 * @param {number} params.sold — tokens already sold
 * @param {number} params.supplyCap — total cycle supply cap
 * @param {number} params.startPrice — price at t=0 in SOL
 * @param {number} params.endPrice — price at t=1 (supplyCap) in SOL
 * @returns {number} price in SOL
 */
function linearCurvePriceAt({ sold, supplyCap, startPrice, endPrice }) {
  const t = supplyCap > 0 ? sold / supplyCap : 0;
  return startPrice + (endPrice - startPrice) * t;
}

/**
 * Compute the ExpLite curve price at a specific sold quantity (offline).
 * Matches the on-chain contract's formula (BPS-linear, not true exponential).
 *
 * @param {object} params
 * @param {number} params.sold — tokens already sold
 * @param {number} params.supplyCap — total cycle supply cap
 * @param {number} params.startPrice — base price in SOL
 * @param {number} params.growthFactorK — raw k value as stored on-chain
 * @returns {number} price in SOL
 */
function expLiteCurvePriceAt({ sold, supplyCap, startPrice, growthFactorK }) {
  if (supplyCap <= 0) return startPrice;
  // Match contract: price = base + base * k * pct_bps / 10000 / 10000
  const pctBps = Math.floor(sold * 10000 / supplyCap);
  const growthFactor = growthFactorK * pctBps / 10000 / 10000;
  return startPrice * (1 + growthFactor);
}

module.exports = {
  lamportsToSol,
  solToLamports,
  computePrice,
  computeBuyQuote,
  stepCurvePriceAt,
  linearCurvePriceAt,
  expLiteCurvePriceAt,
};
