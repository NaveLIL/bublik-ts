export interface OnceOnlySettlementEffects {
  walletCredit: number;
  governmentCredit: number;
}

/** Side effects that are legal only for the process that won the durable claim. */
export function getOnceOnlySettlementEffects(
  claimWon: boolean,
  payout: number,
  governmentIncome: number,
): OnceOnlySettlementEffects {
  if (!claimWon) return { walletCredit: 0, governmentCredit: 0 };
  if (!Number.isSafeInteger(payout) || payout < 0) throw new Error('invalid_payout');
  if (!Number.isSafeInteger(governmentIncome) || governmentIncome < 0) {
    throw new Error('invalid_government_income');
  }
  return { walletCredit: payout, governmentCredit: governmentIncome };
}

/** A market fee is refundable only after this transaction won pending -> terminal CAS. */
export function getMarketRefundAmount(feePaid: number, transitionWon: boolean): number {
  if (!Number.isSafeInteger(feePaid) || feePaid < 0) throw new Error('invalid_market_fee');
  return transitionWon ? feePaid : 0;
}

export function getCleanWallet(wallet: number, dirtyAmount: number): number {
  return Math.max(0, wallet - Math.max(0, dirtyAmount));
}

export function clampDirtyAmount(wallet: number, dirtyAmount: number): number {
  return Math.min(Math.max(0, wallet), Math.max(0, dirtyAmount));
}
