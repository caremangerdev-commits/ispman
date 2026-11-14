// Splitting a card fee between the operator and the customer.
//
// THE ONLY PLACE THIS ARITHMETIC LIVES. The portal shows it, the checkout
// charges it and the webhook unwinds it, and all three have to agree to the
// cent or a customer is told one number and charged another.
//
// WHAT A SURCHARGE IS. A gateway charges the operator a fee on every payment:
// a percentage plus a fixed amount (Dime's published online rate is 3.7% +
// JMD 45.53). By default the operator absorbs it — the customer pays their
// bill and nothing more, which is what every company here did before this
// existed. A company may instead ask the customer to carry some share of it,
// which means charging the customer MORE than their bill.
//
// BEFORE USING IT. Passing a card fee to the customer is a surcharge. Dime's
// own calculator assumes merchants do it; Mastercard has said publicly in
// Jamaica that merchants are wrong to make customers pay more for using a
// card, and acquiring agreements commonly forbid it. That is the operator's
// decision to take with their acquirer, in writing. This module does the
// arithmetic; it does not say the arithmetic is allowed.
//
// THE GROSS-UP, which is the part that is easy to get wrong. The fee is
// charged on the TOTAL, and the total includes the surcharge, so you cannot
// simply add a share of the fee on the bill. Solve for the total instead:
//
//   fee(T) = r·T + k
//   T      = B + s·fee(T)
//   T      = (B + s·k) / (1 − s·r)
//
// where B is the bill, r the percentage rate, k the fixed fee and s the
// customer's share. Adding s·fee(B) instead leaves the operator quietly paying
// a little more than their agreed share on every single payment — small per
// payment, and exactly the sort of gap that turns into an argument.

/** A company's gateway fee, as its own agreement states it. */
export type CardFee = {
  /** Percentage, as a percentage: 3.7 means 3.7%. */
  rate: number
  /** Fixed amount per transaction, in the company's currency. */
  fixed: number
  /** How much of the fee the CUSTOMER carries, 0–100. */
  customerShare: number
}

export type SurchargeBreakdown = {
  /** What buys service. The customer's account is credited exactly this. */
  bill: number
  /** What the customer pays on top. Zero when the operator absorbs the fee. */
  surcharge: number
  /** What the card is charged: bill + surcharge. */
  total: number
  /** What the gateway is expected to take out of the total. */
  expectedFee: number
  /** What the operator is expected to bank: total − expectedFee. */
  expectedNet: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The fee a gateway takes on a given charge, from the operator's stated rate.
 * An ESTIMATE — the gateway's own figure is what gets recorded afterwards.
 */
export function feeOn(total: number, fee: Pick<CardFee, 'rate' | 'fixed'>): number {
  if (!(total > 0)) return 0
  return round2((fee.rate / 100) * total + fee.fixed)
}

/**
 * Splits a bill into what the customer pays and what buys service.
 *
 * Returns a zero surcharge — the customer pays exactly their bill — whenever
 * the company has not set this up or has chosen to absorb the fee. That is the
 * default and the safe answer: an unset or unreadable rate must never become a
 * guessed charge on somebody's card.
 */
export function splitCardFee(bill: number, fee: CardFee | null): SurchargeBreakdown {
  const none: SurchargeBreakdown = {
    bill: round2(bill),
    surcharge: 0,
    total: round2(bill),
    expectedFee: 0,
    expectedNet: round2(bill),
  }
  if (!(bill > 0)) return { ...none, bill: 0, total: 0, expectedNet: 0 }
  if (!fee) return none

  const share = Math.min(100, Math.max(0, fee.customerShare)) / 100
  const rate = Math.max(0, fee.rate) / 100
  const fixed = Math.max(0, fee.fixed)

  // No rate on record, or nothing to pass on: the operator carries it.
  if (share === 0 || (rate === 0 && fixed === 0)) {
    const expectedFee = feeOn(bill, fee)
    return { ...none, expectedFee, expectedNet: round2(bill - expectedFee) }
  }

  // A share×rate at or above 1 would divide by zero or go negative. It cannot
  // happen with a sane rate (the column is capped at 20%), but a charge that
  // ran away because of a bad number is not a failure worth risking: fall back
  // to the operator absorbing it.
  const denominator = 1 - share * rate
  if (!(denominator > 0.5)) {
    const expectedFee = feeOn(bill, fee)
    return { ...none, expectedFee, expectedNet: round2(bill - expectedFee) }
  }

  const total = round2((bill + share * fixed) / denominator)
  const surcharge = round2(total - bill)
  const expectedFee = feeOn(total, fee)

  return {
    bill: round2(bill),
    surcharge,
    total,
    expectedFee,
    expectedNet: round2(total - expectedFee),
  }
}

/**
 * The bill a payment bought, given what was charged and the surcharge agreed
 * at the time. Used by the webhook: the customer's account is credited this,
 * never the full amount, or they would earn credit for a fee they just paid.
 *
 * The surcharge is taken from what was agreed AT CHECKOUT and carried through
 * the gateway, not recomputed here — the company's settings may have changed
 * between the customer agreeing and the payment landing, and what they agreed
 * to is what they are held to.
 */
export function billPortion(amountCharged: number, surchargeAgreed: number | null): number {
  const s = Number(surchargeAgreed)
  if (!Number.isFinite(s) || s <= 0) return round2(amountCharged)
  // Never let a bad surcharge swallow the payment.
  if (s >= amountCharged) return round2(amountCharged)
  return round2(amountCharged - s)
}
