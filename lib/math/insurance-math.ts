/**
 * CORGI POLICY ADMINISTRATION — CORE DETERMINISTIC INSURANCE MATH ENGINE
 *
 * Non-Negotiable Rules Enforced:
 *  1. Money is NEVER a float. All monetary inputs and outputs are integer USD cents.
 *  2. Rounding uses deterministic Banker's Rounding (Round-Half-to-Even) via pure integer
 *     remainder arithmetic (no IEEE-754 float drift).
 *  3. Policy terms are 1 calendar anniversary year (365 or 366 days across leap day Feb 29).
 *  4. Taxes and statutory fees are calculated from effective-dated state schedules, ride the
 *     same payment, NEVER pollute base/earned premium, and obey statutory refundability rules.
 *  5. Both PRO_RATA and SHORT_RATE cancellations are supported.
 */

export type CancellationMethod = 'PRO_RATA' | 'SHORT_RATE';

// ============================================================================
// TIER 2: EFFECTIVE-DATED STATE TAX & STATUTORY FEE SCHEDULES (GAUNTLET #11)
// ============================================================================

export interface StateTaxScheduleRule {
    stateCode: string;
    stateName: string;
    effectiveFrom: string; // Inclusive YYYY-MM-DD
    effectiveTo: string | null; // Inclusive YYYY-MM-DD, or null if currently active
    /** State Surplus Lines / Premium Tax in basis points (100 bps = 1.00%) */
    premiumTaxBps: number;
    /** State Stamping / Filing Fee in basis points (e.g., 18 bps = 0.18%) */
    stampingFeeBps: number;
    /** Flat Carrier Policy / Inspection Fee in integer cents */
    carrierPolicyFeeCents: number;
    /** Statutory refundability rules on mid-term cancellation */
    isPremiumTaxRefundableOnCancel: boolean;
    isStampingFeeRefundableOnCancel: boolean;
    isCarrierFeeRefundableOnCancel: boolean;
    regulatoryCitation: string;
}

/**
 * Effective-dated US commercial lines statutory tax & fee schedules.
 * Notice California (CA) includes the real SLA (Surplus Line Association) stamping fee
 * rate change across effective dates to prove historical/backdated rate lookup works.
 */
export const DEFAULT_STATE_TAX_SCHEDULES: StateTaxScheduleRule[] = [
    {
        stateCode: 'CA',
        stateName: 'California',
        effectiveFrom: '2020-01-01',
        effectiveTo: '2025-12-31',
        premiumTaxBps: 300, // 3.00% CA Surplus Lines Tax
        stampingFeeBps: 25, // 0.25% SLA Stamping Fee (pre-2026 rate)
        carrierPolicyFeeCents: 15000, // $150.00 flat policy fee
        isPremiumTaxRefundableOnCancel: true, // Pro-rata refundable with unearned premium
        isStampingFeeRefundableOnCancel: false, // Earned in full at issuance / endorsement
        isCarrierFeeRefundableOnCancel: false, // Fully earned at issuance
        regulatoryCitation: 'CA Ins. Code § 1775.5 (3.0% Tax) & SLA CA Pre-2026 Schedule (0.25%)',
    },
    {
        stateCode: 'CA',
        stateName: 'California',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        premiumTaxBps: 300, // 3.00% CA Surplus Lines Tax
        stampingFeeBps: 18, // 0.18% SLA Stamping Fee (effective Jan 1, 2026+)
        carrierPolicyFeeCents: 15000, // $150.00 flat policy fee
        isPremiumTaxRefundableOnCancel: true,
        isStampingFeeRefundableOnCancel: false,
        isCarrierFeeRefundableOnCancel: false,
        regulatoryCitation: 'CA Ins. Code § 1775.5 (3.0% Tax) & SLA CA 2026 Schedule (0.18%)',
    },
    {
        stateCode: 'NY',
        stateName: 'New York',
        effectiveFrom: '2020-01-01',
        effectiveTo: null,
        premiumTaxBps: 360, // 3.60% NY Excess Line Tax
        stampingFeeBps: 15, // 0.15% ELANY Stamping Fee
        carrierPolicyFeeCents: 20000, // $200.00 flat policy fee
        isPremiumTaxRefundableOnCancel: true,
        isStampingFeeRefundableOnCancel: false,
        isCarrierFeeRefundableOnCancel: false,
        regulatoryCitation: 'NY Ins. Law § 2118 & ELANY Stamping Schedule',
    },
    {
        stateCode: 'TX',
        stateName: 'Texas',
        effectiveFrom: '2020-01-01',
        effectiveTo: null,
        premiumTaxBps: 485, // 4.85% TX Surplus Lines Tax
        stampingFeeBps: 4, // 0.04% SLTX Stamping Fee
        carrierPolicyFeeCents: 12500, // $125.00 flat policy fee
        isPremiumTaxRefundableOnCancel: true,
        isStampingFeeRefundableOnCancel: false,
        isCarrierFeeRefundableOnCancel: false,
        regulatoryCitation: 'TX Ins. Code § 225.004 & SLTX Schedule',
    },
];

/** Default ISO Short-Rate Cancellation Penalty = 10.00% (1000 bps) of Unearned Base Premium */
export const DEFAULT_SHORT_RATE_PENALTY_BPS = 1000;

/** Default Maker-Checker Approval Threshold = $2,500.00 (250,000 cents) */
export const DEFAULT_MAKER_CHECKER_THRESHOLD_CENTS = Number(
    process.env.APPROVAL_THRESHOLD_CENTS ?? 250000
);

// ============================================================================
// TIER 3: DETERMINISTIC INTEGER & DATE PRIMITIVES (GAUNTLETS #2 & #10)
// ============================================================================

/**
 * Asserts that a monetary cent value is a finite safe integer (never a float or NaN).
 */
export function assertIntegerCents(value: number, label: string): void {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error(
            `FLOAT_MONEY_VIOLATION: ${label} must be an exact safe integer in cents, received: ${value}`
        );
    }
}

/**
 * Deterministic Banker's Rounding (Round-Half-to-Even) for exact integer division:
 * Computes roundHalfToEven(numerator / denominator) using 100% integer BigInt math.
 *
 * Why BigInt internally?
 * Avoids any floating-point intermediate representation when multiplying large commercial
 * policy limits/premiums by days or basis points, and handles exact 0.5 midpoints deterministically.
 */
export function divideAndRoundHalfToEven(numerator: number, denominator: number): {
    roundedCents: number;
    exactFloorCents: number;
    remainderNumerator: number;
    wasRoundedUp: boolean;
} {
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
        throw new Error(
            `INVALID_DIVISION_INPUT: numerator (${numerator}) must be safe integer and denominator (${denominator}) > 0`
        );
    }

    const sign = numerator < 0 ? -1n : 1n;
    const absNum = BigInt(Math.abs(numerator));
    const den = BigInt(denominator);

    const quotient = absNum / den;
    const remainder = absNum % den;
    const doubledRemainder = remainder * 2n;

    let roundedAbs = quotient;
    let wasRoundedUp = false;

    if (doubledRemainder > den) {
        // Strictly greater than 0.5 -> round away from zero
        roundedAbs = quotient + 1n;
        wasRoundedUp = true;
    } else if (doubledRemainder === den) {
        // Exact 0.5 tie -> round to nearest EVEN integer (Banker's Rounding)
        if (quotient % 2n !== 0n) {
            roundedAbs = quotient + 1n;
            wasRoundedUp = true;
        }
    }

    return {
        roundedCents: Number(sign * roundedAbs),
        exactFloorCents: Number(sign * quotient),
        remainderNumerator: Number(sign * remainder),
        wasRoundedUp,
    };
}

/**
 * Helper to apply basis points (10,000 bps = 100%) using Banker's Rounding.
 */
export function applyBasisPoints(amountCents: number, bps: number): number {
    assertIntegerCents(amountCents, 'amountCents');
    assertIntegerCents(bps, 'bps');
    if (amountCents === 0 || bps === 0) return 0;
    return divideAndRoundHalfToEven(amountCents * bps, 10000).roundedCents;
}

/**
 * Parses a strictly formatted 'YYYY-MM-DD' string into a UTC midnight timestamp (ms).
 * Immune to local server timezone offsets (e.g., IST +5:30 vs GMT).
 */
export function parseIsoDateUtcMs(dateStr: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
    if (!match) {
        throw new Error(`INVALID_DATE_FORMAT: Expected YYYY-MM-DD, received "${dateStr}"`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const ms = Date.UTC(year, month - 1, day);
    const verify = new Date(ms);
    if (
        verify.getUTCFullYear() !== year ||
        verify.getUTCMonth() !== month - 1 ||
        verify.getUTCDate() !== day
    ) {
        throw new Error(`INVALID_CALENDAR_DATE: "${dateStr}" does not exist on the calendar.`);
    }
    return ms;
}

const MS_PER_CALENDAR_DAY = 86_400_000;

/**
 * Computes exact calendar days between startDate ('YYYY-MM-DD') and endDate ('YYYY-MM-DD').
 * Gauntlet #2: Automatically respects 365 vs 366 days when the window crosses Feb 29 in a leap year.
 */
export function daysBetweenUtc(startDate: string, endDate: string): number {
    const startMs = parseIsoDateUtcMs(startDate);
    const endMs = parseIsoDateUtcMs(endDate);
    return Math.round((endMs - startMs) / MS_PER_CALENDAR_DAY);
}

/**
 * Gauntlet #2: Computes the exact 1-year anniversary end date for a policy starting on `startDate`.
 * Example:
 *  - '2028-03-01' -> '2029-03-01' (365 days)
 *  - '2027-03-01' -> '2028-03-01' (366 days, includes Feb 29, 2028)
 *  - '2028-02-29' (Leap Day start) -> '2029-02-28' (standard US insurance anniversary convention)
 */
export function calculateOneYearAnniversaryTerm(startDate: string): {
    effectiveStartDate: string;
    effectiveEndDate: string;
    termDays: number;
    containsLeapDay: boolean;
} {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate.trim());
    if (!match) {
        throw new Error(`INVALID_START_DATE: Expected YYYY-MM-DD, received "${startDate}"`);
    }
    const startYear = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    const endYear = startYear + 1;
    let endDay = day;

    // Handle policies written on Feb 29 of a leap year -> anniversary is Feb 28 of following non-leap year
    if (month === 2 && day === 29) {
        endDay = 28;
    }

    const effectiveEndDate = `${String(endYear).padStart(4, '0')}-${String(month).padStart(
        2,
        '0'
    )}-${String(endDay).padStart(2, '0')}`;

    const termDays = daysBetweenUtc(startDate, effectiveEndDate);

    return {
        effectiveStartDate: startDate,
        effectiveEndDate,
        termDays,
        containsLeapDay: termDays === 366,
    };
}

// ============================================================================
// STATE TAX & FEE LOOKUP ENGINE (GAUNTLET #11)
// ============================================================================

/**
 * Resolves the active statutory StateTaxScheduleRule for a given US state and effective date.
 */
export function resolveStateTaxRule(
    stateCode: string,
    effectiveDate: string,
    customSchedules: StateTaxScheduleRule[] = DEFAULT_STATE_TAX_SCHEDULES
): StateTaxScheduleRule {
    const normalizedState = stateCode.trim().toUpperCase();
    const targetMs = parseIsoDateUtcMs(effectiveDate);

    const matchingRule = customSchedules.find((rule) => {
        if (rule.stateCode.toUpperCase() !== normalizedState) return false;
        const fromMs = parseIsoDateUtcMs(rule.effectiveFrom);
        const toMs = rule.effectiveTo ? parseIsoDateUtcMs(rule.effectiveTo) : Number.POSITIVE_INFINITY;
        return targetMs >= fromMs && targetMs <= toMs;
    });

    if (!matchingRule) {
        // Fallback to latest rule for that state or CA default if state not seeded
        const fallback =
            customSchedules.find((r) => r.stateCode.toUpperCase() === normalizedState && !r.effectiveTo) ??
            DEFAULT_STATE_TAX_SCHEDULES[1];
        return fallback;
    }

    return matchingRule;
}

// ============================================================================
// 1. POLICY ISSUANCE PRICING & COMMISSION BREAKDOWN (GAUNTLETS #1, #2, #7, #11)
// ============================================================================

export interface IssuancePricingInput {
    annualBasePremiumCents: number;
    effectiveStartDate: string;
    effectiveEndDate?: string; // Optional override; defaults to 1-year anniversary
    riskState: string;
    brokerCommissionRateBps: number; // From Broker entity (e.g. 1250 = 12.50%)
    customTaxSchedules?: StateTaxScheduleRule[];
}

export interface IssuancePricingResult {
    effectiveStartDate: string;
    effectiveEndDate: string;
    termDays: number;
    containsLeapDay: boolean;
    basePremiumCents: number;
    stateTaxCents: number;
    stampingFeeCents: number;
    carrierPolicyFeeCents: number;
    totalGrossChargedCents: number;
    /** Commission earned once basePremiumCents is collected (excludes taxes & fees) */
    brokerCommissionCents: number;
    brokerCommissionRateBps: number;
    appliedTaxRule: StateTaxScheduleRule;
}

/**
 * Computes initial policy issuance pricing, statutory taxes/fees, and broker commission.
 * Taxes and fees ride the customer payment (`totalGrossChargedCents`) but NEVER pollute
 * `basePremiumCents` or broker commission.
 */
export function calculatePolicyIssuancePricing(
    input: IssuancePricingInput
): IssuancePricingResult {
    assertIntegerCents(input.annualBasePremiumCents, 'annualBasePremiumCents');
    assertIntegerCents(input.brokerCommissionRateBps, 'brokerCommissionRateBps');

    if (input.annualBasePremiumCents <= 0) {
        throw new Error('Annual base premium must be strictly positive (> 0 cents).');
    }

    const term = input.effectiveEndDate
        ? {
            effectiveStartDate: input.effectiveStartDate,
            effectiveEndDate: input.effectiveEndDate,
            termDays: daysBetweenUtc(input.effectiveStartDate, input.effectiveEndDate),
            containsLeapDay: daysBetweenUtc(input.effectiveStartDate, input.effectiveEndDate) === 366,
        }
        : calculateOneYearAnniversaryTerm(input.effectiveStartDate);

    if (term.termDays <= 0) {
        throw new Error(
            `INVALID_TERM: effectiveEndDate (${term.effectiveEndDate}) must be after effectiveStartDate (${term.effectiveStartDate}).`
        );
    }

    const taxRule = resolveStateTaxRule(
        input.riskState,
        term.effectiveStartDate,
        input.customTaxSchedules
    );

    const stateTaxCents = applyBasisPoints(input.annualBasePremiumCents, taxRule.premiumTaxBps);
    const stampingFeeCents = applyBasisPoints(input.annualBasePremiumCents, taxRule.stampingFeeBps);
    const carrierPolicyFeeCents = taxRule.carrierPolicyFeeCents;

    const totalGrossChargedCents =
        input.annualBasePremiumCents + stateTaxCents + stampingFeeCents + carrierPolicyFeeCents;

    // Gauntlet #7: Commission is earned strictly on Base Premium (never on state taxes or fees)
    const brokerCommissionCents = applyBasisPoints(
        input.annualBasePremiumCents,
        input.brokerCommissionRateBps
    );

    return {
        effectiveStartDate: term.effectiveStartDate,
        effectiveEndDate: term.effectiveEndDate,
        termDays: term.termDays,
        containsLeapDay: term.containsLeapDay,
        basePremiumCents: input.annualBasePremiumCents,
        stateTaxCents,
        stampingFeeCents,
        carrierPolicyFeeCents,
        totalGrossChargedCents,
        brokerCommissionCents,
        brokerCommissionRateBps: input.brokerCommissionRateBps,
        appliedTaxRule: taxRule,
    };
}

// ============================================================================
// 2. MID-TERM ENDORSEMENT PRORATION ENGINE (GAUNTLETS #2, #3, #10, #11)
// ============================================================================

export interface EndorsementPricingInput {
    /** Annualized full-term base premium delta (positive for limit increase, negative for reduction) */
    annualizedBasePremiumDeltaCents: number;
    /** Policy's original term boundaries */
    policyEffectiveStartDate: string;
    policyEffectiveEndDate: string;
    /** Gauntlet #3: Priced strictly from the endorsement effective_date, NEVER entry/recorded date */
    endorsementEffectiveDate: string;
    riskState: string;
    brokerCommissionRateBps: number;
    customTaxSchedules?: StateTaxScheduleRule[];
}

export interface EndorsementPricingResult {
    endorsementEffectiveDate: string;
    termDays: number;
    activeRemainingDays: number;
    annualizedBasePremiumDeltaCents: number;
    proratedBasePremiumDeltaCents: number;
    stateTaxDeltaCents: number;
    stampingFeeDeltaCents: number;
    /** Endorsements do not re-charge the one-time issuance carrier policy fee */
    carrierFeeDeltaCents: number;
    totalGrossDeltaCents: number;
    brokerCommissionDeltaCents: number;
    /**
     * Gauntlet #10: Exact rounding penny variance between unrounded daily math and Banker's rounded integer cents.
     * Stored on PolicyEvent for audit transparency.
     */
    roundingPennyVarianceCents: number;
    appliedTaxRule: StateTaxScheduleRule;
}

/**
 * Gauntlet #3: Computes pro-rated endorsement premium delta over the remaining term
 * from `endorsementEffectiveDate` to `policyEffectiveEndDate`.
 * Backdating `endorsementEffectiveDate` changes `activeRemainingDays` and therefore changes the math!
 */
export function calculateEndorsementPricing(
    input: EndorsementPricingInput
): EndorsementPricingResult {
    assertIntegerCents(input.annualizedBasePremiumDeltaCents, 'annualizedBasePremiumDeltaCents');
    assertIntegerCents(input.brokerCommissionRateBps, 'brokerCommissionRateBps');

    const termDays = daysBetweenUtc(input.policyEffectiveStartDate, input.policyEffectiveEndDate);
    if (termDays <= 0) {
        throw new Error('Policy termDays must be strictly positive.');
    }

    const startToEffective = daysBetweenUtc(
        input.policyEffectiveStartDate,
        input.endorsementEffectiveDate
    );
    const activeRemainingDays = daysBetweenUtc(
        input.endorsementEffectiveDate,
        input.policyEffectiveEndDate
    );

    if (startToEffective < 0 || activeRemainingDays <= 0) {
        throw new Error(
            `ENDORSEMENT_DATE_OUT_OF_BOUNDS: Endorsement effective date (${input.endorsementEffectiveDate}) must fall within policy term [${input.policyEffectiveStartDate}, ${input.policyEffectiveEndDate}).`
        );
    }

    // Pro-rate annualized delta over (activeRemainingDays / termDays) using Banker's Rounding
    const prorationDiv = divideAndRoundHalfToEven(
        input.annualizedBasePremiumDeltaCents * activeRemainingDays,
        termDays
    );
    const proratedBasePremiumDeltaCents = prorationDiv.roundedCents;

    // Verify complementary slice (days before effective date) to expose any 1-cent split residual
    const complementDiv = divideAndRoundHalfToEven(
        input.annualizedBasePremiumDeltaCents * (termDays - activeRemainingDays),
        termDays
    );
    const roundingPennyVarianceCents =
        input.annualizedBasePremiumDeltaCents -
        (proratedBasePremiumDeltaCents + complementDiv.roundedCents);

    // Look up statutory state tax rule as of the endorsement's effective date!
    const taxRule = resolveStateTaxRule(
        input.riskState,
        input.endorsementEffectiveDate,
        input.customTaxSchedules
    );

    const stateTaxDeltaCents = applyBasisPoints(
        proratedBasePremiumDeltaCents,
        taxRule.premiumTaxBps
    );

    // Statutory rule: If endorsement reduces premium (< 0) and stamping fee is non-refundable,
    // stamping fee delta is 0 (state stamping offices do not refund stamping fees on return premiums).
    const stampingFeeDeltaCents =
        proratedBasePremiumDeltaCents < 0 && !taxRule.isStampingFeeRefundableOnCancel
            ? 0
            : applyBasisPoints(proratedBasePremiumDeltaCents, taxRule.stampingFeeBps);

    const carrierFeeDeltaCents = 0; // Flat issuance policy fee is charged once at issuance

    const totalGrossDeltaCents =
        proratedBasePremiumDeltaCents +
        stateTaxDeltaCents +
        stampingFeeDeltaCents +
        carrierFeeDeltaCents;

    const brokerCommissionDeltaCents = applyBasisPoints(
        proratedBasePremiumDeltaCents,
        input.brokerCommissionRateBps
    );

    return {
        endorsementEffectiveDate: input.endorsementEffectiveDate,
        termDays,
        activeRemainingDays,
        annualizedBasePremiumDeltaCents: input.annualizedBasePremiumDeltaCents,
        proratedBasePremiumDeltaCents,
        stateTaxDeltaCents,
        stampingFeeDeltaCents,
        carrierFeeDeltaCents,
        totalGrossDeltaCents,
        brokerCommissionDeltaCents,
        roundingPennyVarianceCents,
        appliedTaxRule: taxRule,
    };
}

// ============================================================================
// 3. DAILY EARNED VS. UNEARNED PREMIUM & AS-OF RECONSTRUCTION (GAUNTLETS #1, #9, #10)
// ============================================================================

export interface PolicyFinancialSlice {
    eventId: string;
    eventType:
    | 'POLICY_ISSUED'
    | 'ENDORSEMENT_APPLIED'
    | 'ENDORSEMENT_REVERSAL'
    | 'ENDORSEMENT_REBOOK'
    | 'POLICY_CANCELLED';
    effectiveDate: string; // YYYY-MM-DD
    recordedAt: Date | string;
    activeDaysInTerm: number;
    proratedBasePremiumDeltaCents: number;
    stateTaxDeltaCents: number;
    stampingFeeDeltaCents: number;
    feeOrPenaltyDeltaCents: number;
    reversesEventId?: string | null;
}

export interface AsOfEarnedBreakdown {
    asOfDate: string;
    totalWrittenBasePremiumCents: number;
    earnedBasePremiumCents: number;
    unearnedBasePremiumCents: number;
    totalStateTaxCents: number;
    totalStampingFeeCents: number;
    totalCarrierFeeCents: number;
    roundingPennyAbsorbedCents: number;
    sliceDetails: Array<{
        eventId: string;
        eventType: string;
        effectiveDate: string;
        writtenDeltaCents: number;
        activeSliceDays: number;
        elapsedSliceDays: number;
        earnedSliceCents: number;
        unearnedSliceCents: number;
    }>;
}

/**
 * Gauntlet #1 & #9: Computes exact Written, Earned, and Unearned base premium as of any date `asOfDate`.
 *
 * How Each Slice Earns:
 *  - Issuance slice earns uniformly over [policyStartDate, policyEndDate] (termDays).
 *  - Endorsement slice (applied at `E_eff`) was already pro-rated for [E_eff, policyEndDate]
 *    (`activeSliceDays`), so it earns uniformly over its active window [E_eff, policyEndDate]!
 *  - If a Reversal + Re-book occurred (The Correction Test), the reversal slice negates the
 *    original erroneous slice dollar-for-dollar and day-for-day, while the re-booked slice
 *    earns accurately from the corrected effective date.
 */
export function calculateAsOfEarnedPosition(params: {
    policyStartDate: string;
    policyEndDate: string;
    asOfDate: string;
    slices: PolicyFinancialSlice[];
}): AsOfEarnedBreakdown {
    const { policyStartDate, policyEndDate, asOfDate, slices } = params;
    const asOfMs = parseIsoDateUtcMs(asOfDate);
    const endMs = parseIsoDateUtcMs(policyEndDate);

    let totalWrittenBasePremiumCents = 0;
    let totalEarnedAcrossSlices = 0;
    let totalStateTaxCents = 0;
    let totalStampingFeeCents = 0;
    let totalCarrierFeeCents = 0;

    const sliceDetails: AsOfEarnedBreakdown['sliceDetails'] = [];

    for (const slice of slices) {
        // Only include events whose effective_date is <= asOfDate
        // (Note: For The Correction Test, if a reversal reverses an event that was effective <= asOfDate,
        // the reversal carries the same effectiveDate as the reversed event so they cancel out cleanly!)
        const sliceStartMs = parseIsoDateUtcMs(slice.effectiveDate);
        if (sliceStartMs > asOfMs) {
            continue;
        }

        // Cancellation events are handled by calculateCancellationRefund; skip in pre-cancel earning calc
        if (slice.eventType === 'POLICY_CANCELLED') {
            continue;
        }

        const activeSliceDays =
            slice.activeDaysInTerm > 0
                ? slice.activeDaysInTerm
                : daysBetweenUtc(slice.effectiveDate, policyEndDate);

        // Elapsed days within [slice.effectiveDate, policyEndDate] up to asOfDate
        const rawElapsedDays = Math.round(
            (Math.min(asOfMs, endMs) - sliceStartMs) / MS_PER_CALENDAR_DAY
        );
        const elapsedSliceDays = Math.max(0, Math.min(activeSliceDays, rawElapsedDays));

        const earnedSliceCents =
            activeSliceDays > 0
                ? divideAndRoundHalfToEven(
                    slice.proratedBasePremiumDeltaCents * elapsedSliceDays,
                    activeSliceDays
                ).roundedCents
                : slice.proratedBasePremiumDeltaCents;

        const unearnedSliceCents = slice.proratedBasePremiumDeltaCents - earnedSliceCents;

        totalWrittenBasePremiumCents += slice.proratedBasePremiumDeltaCents;
        totalEarnedAcrossSlices += earnedSliceCents;
        totalStateTaxCents += slice.stateTaxDeltaCents;
        totalStampingFeeCents += slice.stampingFeeDeltaCents;
        totalCarrierFeeCents += slice.feeOrPenaltyDeltaCents;

        sliceDetails.push({
            eventId: slice.eventId,
            eventType: slice.eventType,
            effectiveDate: slice.effectiveDate,
            writtenDeltaCents: slice.proratedBasePremiumDeltaCents,
            activeSliceDays,
            elapsedSliceDays,
            earnedSliceCents,
            unearnedSliceCents,
        });
    }

    // Gauntlet #10: Ensure Earned + Unearned === Total Written identically (zero zombie liability)
    const earnedBasePremiumCents = Math.max(
        0,
        Math.min(totalWrittenBasePremiumCents, totalEarnedAcrossSlices)
    );
    const unearnedBasePremiumCents = totalWrittenBasePremiumCents - earnedBasePremiumCents;
    const roundingPennyAbsorbedCents = totalEarnedAcrossSlices - earnedBasePremiumCents;

    return {
        asOfDate,
        totalWrittenBasePremiumCents,
        earnedBasePremiumCents,
        unearnedBasePremiumCents,
        totalStateTaxCents,
        totalStampingFeeCents,
        totalCarrierFeeCents,
        roundingPennyAbsorbedCents,
        sliceDetails,
    };
}

// ============================================================================
// 4. CANCELLATION REFUND & COMMISSION CLAWBACK ENGINE (GAUNTLETS #5, #7, #10, #11)
// ============================================================================

export interface CancellationCalculationInput {
    policyStartDate: string;
    policyEndDate: string;
    cancellationEffectiveDate: string;
    cancellationMethod: CancellationMethod; // 'PRO_RATA' | 'SHORT_RATE'
    riskState: string;
    brokerCommissionRateBps: number;
    shortRatePenaltyBps?: number; // Defaults to 1000 bps (10.00% of unearned premium)
    slices: PolicyFinancialSlice[];
    customTaxSchedules?: StateTaxScheduleRule[];
}

export interface CancellationCalculationResult {
    cancellationEffectiveDate: string;
    cancellationMethod: CancellationMethod;
    totalWrittenBasePremiumCents: number;
    earnedBasePremiumCents: number;
    /** Total unearned liability to clear from LIABILITY:UNEARNED_PREMIUM_RESERVE */
    unearnedBasePremiumLiabilityClearedCents: number;
    /** If SHORT_RATE, carrier retains 10% penalty of unearned premium as revenue */
    shortRatePenaltyRetainedCents: number;
    /** Actual base premium refunded to policyholder (= unearned - shortRatePenalty) */
    refundableBasePremiumCents: number;
    /** State surplus lines tax refunded pro-rata on refundable base premium */
    refundableStateTaxCents: number;
    /** Stamping fee refund (0 in CA/NY/TX per statutory non-refundable rule) */
    refundableStampingFeeCents: number;
    /** Carrier policy fee refund (0 per non-refundable rule) */
    refundableCarrierFeeCents: number;
    /** Total cash to refund over LIVE Stripe Refund API */
    totalCustomerCashRefundCents: number;
    /** Broker commission clawed back on refunded base premium */
    brokerCommissionClawbackCents: number;
    roundingPennyVarianceCents: number;
    appliedTaxRule: StateTaxScheduleRule;
}

/**
 * Gauntlet #5, #7, #10, #11:
 * Computes the exact mid-term cancellation refund, short-rate penalty (if applicable),
 * refundable state tax vs. non-refundable stamping/carrier fees, and broker commission clawback.
 */
export function calculateCancellationRefund(
    input: CancellationCalculationInput
): CancellationCalculationResult {
    const startMs = parseIsoDateUtcMs(input.policyStartDate);
    const endMs = parseIsoDateUtcMs(input.policyEndDate);
    const cancelMs = parseIsoDateUtcMs(input.cancellationEffectiveDate);

    if (cancelMs < startMs || cancelMs > endMs) {
        throw new Error(
            `CANCELLATION_DATE_OUT_OF_BOUNDS: Cancellation effective date (${input.cancellationEffectiveDate}) must be within [${input.policyStartDate}, ${input.policyEndDate}].`
        );
    }

    // 1. Compute earned vs. unearned position as of the cancellation effective date
    const position = calculateAsOfEarnedPosition({
        policyStartDate: input.policyStartDate,
        policyEndDate: input.policyEndDate,
        asOfDate: input.cancellationEffectiveDate,
        slices: input.slices,
    });

    const unearnedLiabilityCents = position.unearnedBasePremiumCents;

    // 2. Apply Pro-Rata vs. Short-Rate rule (Gauntlet #5)
    const penaltyBps =
        input.cancellationMethod === 'SHORT_RATE'
            ? input.shortRatePenaltyBps ?? DEFAULT_SHORT_RATE_PENALTY_BPS
            : 0;

    const shortRatePenaltyRetainedCents = applyBasisPoints(unearnedLiabilityCents, penaltyBps);
    const refundableBasePremiumCents = unearnedLiabilityCents - shortRatePenaltyRetainedCents;

    // 3. Apply State Statutory Tax & Fee Refundability Rules (Gauntlet #11)
    const taxRule = resolveStateTaxRule(
        input.riskState,
        input.cancellationEffectiveDate,
        input.customTaxSchedules
    );

    const refundableStateTaxCents = taxRule.isPremiumTaxRefundableOnCancel
        ? applyBasisPoints(refundableBasePremiumCents, taxRule.premiumTaxBps)
        : 0;

    const refundableStampingFeeCents = taxRule.isStampingFeeRefundableOnCancel
        ? applyBasisPoints(refundableBasePremiumCents, taxRule.stampingFeeBps)
        : 0;

    const refundableCarrierFeeCents = taxRule.isCarrierFeeRefundableOnCancel
        ? position.totalCarrierFeeCents
        : 0;

    const totalCustomerCashRefundCents =
        refundableBasePremiumCents +
        refundableStateTaxCents +
        refundableStampingFeeCents +
        refundableCarrierFeeCents;

    // 4. Gauntlet #7: Claw back broker commission strictly on the refunded base premium
    const brokerCommissionClawbackCents = applyBasisPoints(
        refundableBasePremiumCents,
        input.brokerCommissionRateBps
    );

    return {
        cancellationEffectiveDate: input.cancellationEffectiveDate,
        cancellationMethod: input.cancellationMethod,
        totalWrittenBasePremiumCents: position.totalWrittenBasePremiumCents,
        earnedBasePremiumCents: position.earnedBasePremiumCents,
        unearnedBasePremiumLiabilityClearedCents: unearnedLiabilityCents,
        shortRatePenaltyRetainedCents,
        refundableBasePremiumCents,
        refundableStateTaxCents,
        refundableStampingFeeCents,
        refundableCarrierFeeCents,
        totalCustomerCashRefundCents,
        brokerCommissionClawbackCents,
        roundingPennyVarianceCents: position.roundingPennyAbsorbedCents,
        appliedTaxRule: taxRule,
    };
}

// ============================================================================
// 5. CLAIMS RESERVE & PAYOUT INVARIANT ENGINE (GAUNTLET #6)
// ============================================================================

export interface ClaimsPositionSummary {
    currentReserveCents: number;
    totalPaidCents: number;
    totalIncurredCents: number; // Incurred = Paid + Reserve
    policyCoverageLimitCents: number;
    remainingAvailableLimitCents: number;
}

/**
 * Gauntlet #6: Enforces Incurred = Paid + Reserve <= Policy Limit.
 * Payments draw the reserve down (`reserveDelta = -payoutCents`, `paidDelta = +payoutCents`).
 * If a payout bounces (ACH Return R01/R03), it restores the reserve (`reserveDelta = +payoutCents`, `paidDelta = -payoutCents`).
 */
export function validateAndComputeClaimAdjustment(params: {
    policyCoverageLimitCents: number;
    existingReserveCents: number;
    existingPaidCents: number;
    proposedReserveDeltaCents: number;
    proposedPaidDeltaCents: number;
}): ClaimsPositionSummary {
    assertIntegerCents(params.policyCoverageLimitCents, 'policyCoverageLimitCents');
    assertIntegerCents(params.existingReserveCents, 'existingReserveCents');
    assertIntegerCents(params.existingPaidCents, 'existingPaidCents');
    assertIntegerCents(params.proposedReserveDeltaCents, 'proposedReserveDeltaCents');
    assertIntegerCents(params.proposedPaidDeltaCents, 'proposedPaidDeltaCents');

    const newReserveCents = params.existingReserveCents + params.proposedReserveDeltaCents;
    const newPaidCents = params.existingPaidCents + params.proposedPaidDeltaCents;

    if (newReserveCents < 0) {
        throw new Error(
            `CLAIM_RESERVE_UNDERFLOW: Adjustment would reduce outstanding claim reserve below $0.00 (${newReserveCents} cents). Increase reserve before paying above current reserve.`
        );
    }

    if (newPaidCents < 0) {
        throw new Error(
            `CLAIM_PAID_UNDERFLOW: Total paid cannot be negative (${newPaidCents} cents).`
        );
    }

    const totalIncurredCents = newReserveCents + newPaidCents;

    if (totalIncurredCents > params.policyCoverageLimitCents) {
        throw new Error(
            `POLICY_LIMIT_EXCEEDED: Proposed adjustment brings Total Incurred ($${(
                totalIncurredCents / 100
            ).toFixed(2)}) above Policy Coverage Limit ($${(
                params.policyCoverageLimitCents / 100
            ).toFixed(2)}). Nothing pays or reserves past the limit.`
        );
    }

    return {
        currentReserveCents: newReserveCents,
        totalPaidCents: newPaidCents,
        totalIncurredCents,
        policyCoverageLimitCents: params.policyCoverageLimitCents,
        remainingAvailableLimitCents: params.policyCoverageLimitCents - totalIncurredCents,
    };
}

/**
 * Formats integer cents into a clean USD display string (e.g., 500050 -> "$5,000.50").
 * Strictly for UI/PDF presentation — never used in arithmetic.
 */
export function formatUsdCents(cents: number): string {
    const isNegative = cents < 0;
    const absCents = Math.abs(Math.trunc(cents));
    const dollars = Math.floor(absCents / 100);
    const remCents = absCents % 100;
    const formattedDollars = dollars.toLocaleString('en-US');
    const formattedCents = String(remCents).padStart(2, '0');
    return `${isNegative ? '-' : ''}$${formattedDollars}.${formattedCents}`;
}