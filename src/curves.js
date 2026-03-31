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
  return Math.floor(sol * LAMPORTS_PER_SOL);
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

  const basePriceSol = lamportsToSol(basePrice);
  const mintedN = Number(minted);
  const supplyCapN = Number(supplyCap);

  if (curveType.step !== undefined) {
    const stepSizeN = Number(stepSize);
    const stepIncrSol = lamportsToSol(stepIncrement);
    const stepIndex = stepSizeN > 0 ? Math.floor(mintedN / stepSizeN) : 0;
    return basePriceSol + stepIndex * stepIncrSol;
  }

  if (curveType.linear !== undefined) {
    const endPriceSol = lamportsToSol(endPrice || 0);
    const t = supplyCapN > 0 ? mintedN / supplyCapN : 0;
    return basePriceSol + (endPriceSol - basePriceSol) * t;
  }

  if (curveType.expLite !== undefined) {
    const k = Number(growthFactorK || 0) / 1000; // stored as k*1000 on-chain
    const t = supplyCapN > 0 ? mintedN / supplyCapN : 0;
    return basePriceSol * Math.exp(k * t);
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

  const fee = solIn * (feeBps / 10000);
  let budget = solIn - fee;

  const basePriceSol = lamportsToSol(basePrice);
  const stepSizeN = Number(stepSize);
  const stepIncrSol = lamportsToSol(stepIncrement);
  const mintedN = Number(minted);
  const supplyCapN = Number(supplyCap);
  const remaining = supplyCapN - mintedN;

  // ── Step curve: walk through step boundaries ──────────────────────────────
  if (curveType?.step !== undefined && stepSizeN > 0) {
    let tokensSold = mintedN;
    let tokensOut = 0;

    while (budget > 0 && tokensSold < supplyCapN) {
      const stepIndex = Math.floor(tokensSold / stepSizeN);
      const priceNow = basePriceSol + stepIndex * stepIncrSol;
      const tokensThisStep = Math.min(
        stepSizeN - (tokensSold % stepSizeN),
        supplyCapN - tokensSold
      );
      const costForStep = tokensThisStep * priceNow;

      if (budget >= costForStep) {
        budget -= costForStep;
        tokensSold += tokensThisStep;
        tokensOut += tokensThisStep;
      } else {
        const partial = Math.floor(budget / priceNow);
        tokensOut += partial;
        tokensSold += partial;
        budget = 0;
      }
    }

    const effectivePrice = tokensOut > 0 ? (solIn - fee) / tokensOut : basePriceSol;
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

  // ── Linear / ExpLite: use approximate average price ───────────────────────
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
 *
 * @param {object} params
 * @param {number} params.sold — tokens already sold
 * @param {number} params.supplyCap — total cycle supply cap
 * @param {number} params.startPrice — base price in SOL
 * @param {number} params.growthFactorK — k value (not multiplied by 1000 here — pass real k e.g. 2.5)
 * @returns {number} price in SOL
 */
function expLiteCurvePriceAt({ sold, supplyCap, startPrice, growthFactorK }) {
  const t = supplyCap > 0 ? sold / supplyCap : 0;
  return startPrice * Math.exp(growthFactorK * t);
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
