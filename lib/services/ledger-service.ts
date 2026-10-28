import { EntityManager } from 'typeorm';
import { getDb, withTransaction } from '@/lib/db/data-source';
import {
    ApprovalRequest,
    Broker,
    BrokerStatement,
    CancellationType,
    Claim,
    ClaimReserveEvent,
    EntryDirection,
    LedgerAccount,
    LedgerEntry,
    LedgerTransaction,
    Policy,
    PolicyEvent,
} from '@/lib/db/entities';
import {
    AsOfEarnedBreakdown,
    assertIntegerCents,
    calculateAsOfEarnedPosition,
    calculateCancellationRefund,
    calculateEndorsementPricing,
    calculatePolicyIssuancePricing,
    CancellationCalculationResult,
    DEFAULT_MAKER_CHECKER_THRESHOLD_CENTS,
    EndorsementPricingResult,
    IssuancePricingResult,
    PolicyFinancialSlice,
    validateAndComputeClaimAdjustment,
} from '@/lib/math/insurance-math';

// ============================================================================
// 1. CORE DOUBLE-ENTRY JOURNAL PRIMITIVE (APPEND-ONLY, ZERO UPDATE/DELETE)
// ============================================================================

export interface JournalLineInput {
    accountCode: LedgerAccount;
    direction: EntryDirection;
    amountCents: number;
    policyId?: string | null;
    brokerId?: string | null;
    claimId?: string | null;
}

export interface PostJournalInput {
    idempotencyKey: string;
    eventCategory: LedgerTransaction['event_category'];
    description: string;
    effectiveDate: string; // YYYY-MM-DD
    policyId?: string | null;
    brokerId?: string | null;
    claimId?: string | null;
    policyEventId?: string | null;
    externalReferenceId?: string | null;
    reversesTransactionId?: string | null;
    createdBy?: string;
    lines: JournalLineInput[];
}

/**
 * Posts a balanced double-entry journal transaction inside an active EntityManager transaction.
 *
 * Guarantees:
 *  1. Idempotent: If `idempotencyKey` already exists, returns the existing LedgerTransaction.
 *  2. Integer Cents: Every line amount is validated as a safe integer > 0 (0-cent lines are stripped).
 *  3. Balanced: Sum(DEBIT) === Sum(CREDIT) to the exact cent, or throws UNBALANCED_LEDGER_ENTRY.
 */
export async function postBalancedJournalTransaction(
    manager: EntityManager,
    input: PostJournalInput
): Promise<LedgerTransaction> {
    // 1. Idempotency check ("twice is one")
    const existingTx = await manager.findOne(LedgerTransaction, {
        where: { idempotency_key: input.idempotencyKey },
        relations: { entries: true },
    });
    if (existingTx) {
        return existingTx;
    }

    // 2. Filter out 0-cent lines and validate positive integer cents
    const activeLines = input.lines.filter((line) => line.amountCents !== 0);
    if (activeLines.length < 2) {
        throw new Error(
            `INVALID_JOURNAL_ENTRY: A double-entry transaction requires at least 2 non-zero lines (key: ${input.idempotencyKey}).`
        );
    }

    let totalDebitsCents = 0;
    let totalCreditsCents = 0;

    for (const line of activeLines) {
        assertIntegerCents(line.amountCents, `LedgerEntry(${line.accountCode})`);
        if (line.amountCents < 0) {
            throw new Error(
                `NEGATIVE_LEDGER_LINE_FORBIDDEN: LedgerEntry amounts must be strictly positive (> 0). Use DEBIT/CREDIT direction instead (account: ${line.accountCode}, value: ${line.amountCents}).`
            );
        }
        if (line.direction === 'DEBIT') {
            totalDebitsCents += line.amountCents;
        } else {
            totalCreditsCents += line.amountCents;
        }
    }

    if (totalDebitsCents !== totalCreditsCents) {
        throw new Error(
            `UNBALANCED_LEDGER_TRANSACTION: Debits (${totalDebitsCents} cents) !== Credits (${totalCreditsCents} cents) for key "${input.idempotencyKey}".`
        );
    }

    // 3. Create immutable header
    const tx = manager.create(LedgerTransaction, {
        idempotency_key: input.idempotencyKey,
        event_category: input.eventCategory,
        description: input.description,
        effective_date: input.effectiveDate,
        policy_id: input.policyId ?? null,
        broker_id: input.brokerId ?? null,
        claim_id: input.claimId ?? null,
        policy_event_id: input.policyEventId ?? null,
        external_reference_id: input.externalReferenceId ?? null,
        reverses_transaction_id: input.reversesTransactionId ?? null,
        created_by: input.createdBy ?? 'SYSTEM',
    });

    const savedTx = await manager.save(LedgerTransaction, tx);

    // 4. Create immutable line items
    const entries = activeLines.map((line) =>
        manager.create(LedgerEntry, {
            transaction_id: savedTx.id,
            account_code: line.accountCode,
            direction: line.direction,
            amount_cents: line.amountCents,
            policy_id: line.policyId ?? input.policyId ?? null,
            broker_id: line.brokerId ?? input.brokerId ?? null,
            claim_id: line.claimId ?? input.claimId ?? null,
            effective_date: input.effectiveDate,
        })
    );

    savedTx.entries = await manager.save(LedgerEntry, entries);
    return savedTx;
}

/**
 * Helper to build the exact mirror-image reversal lines for any existing LedgerTransaction.
 * Swaps every DEBIT -> CREDIT and CREDIT -> DEBIT with identical integer cent amounts.
 */
function buildReversalLinesFromTransaction(originalTx: LedgerTransaction): JournalLineInput[] {
    return originalTx.entries.map((entry) => ({
        accountCode: entry.account_code,
        direction: entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
        amountCents: entry.amount_cents,
        policyId: entry.policy_id,
        brokerId: entry.broker_id,
        claimId: entry.claim_id,
    }));
}

// ============================================================================
// 2. POLICY ISSUANCE & PREMIUM COLLECTION (GAUNTLETS #1, #2, #7, #11)
// ============================================================================

export interface IssueAndBindPolicyInput {
    idempotencyKey: string;
    brokerId: string;
    insuredName: string;
    insuredEin: string;
    insuredAddress: string;
    riskState: string; // e.g. 'CA', 'NY', 'TX'
    productLine?: 'COMMERCIAL_GENERAL_LIABILITY' | 'CYBER_TECH_EO';
    effectiveStartDate: string; // YYYY-MM-DD
    effectiveEndDate?: string; // Optional override; defaults to 1-year anniversary
    coverageLimitCents: number;
    deductibleCents: number;
    annualBasePremiumCents: number;
    vehiclesCovered?: string[];
    additionalInsureds?: string[];
    paymentMethodType?: 'CARD' | 'ACH_DEBIT';
    /** If already paid via Stripe PaymentIntent / Charge, binds and collects immediately */
    stripePaymentIntentId?: string | null;
    stripeChargeId?: string | null;
    collectImmediately?: boolean;
    createdBy?: string;
}

export interface IssueAndBindPolicyResult {
    policy: Policy;
    issuanceEvent: PolicyEvent;
    pricing: IssuancePricingResult;
    collectionLedgerTx: LedgerTransaction | null;
    commissionLedgerTx: LedgerTransaction | null;
}

/**
 * Issues a commercial policy, enforcing the Broker KYB gate (`kyb_status === 'APPROVED'`).
 * If `collectImmediately` is true (or `stripePaymentIntentId` is supplied), binds the policy,
 * records the `POLICY_ISSUED` event, books the cash collection journal entry (separating
 * Base Premium, State Surplus Lines Tax, Stamping Fee, and Carrier Policy Fee), and accrues
 * cash-basis Broker Commission on the collected Base Premium.
 */
export async function issueAndBindPolicy(
    input: IssueAndBindPolicyInput
): Promise<IssueAndBindPolicyResult> {
    return withTransaction(async (manager) => {
        // 1. Verify Broker exists and passes the KYB Gate!
        const broker = await manager.findOne(Broker, {
            where: { id: input.brokerId },
        });
        if (!broker) {
            throw new Error(`BROKER_NOT_FOUND: Broker ${input.brokerId} does not exist.`);
        }

        if (broker.kyb_status !== 'APPROVED') {
            throw new Error(
                `BROKER_KYB_GATE_BLOCKED: Broker "${broker.legal_name}" has KYB status "${broker.kyb_status}". Unverified brokers cannot bind policies.`
            );
        }

        // 2. Calculate deterministic issuance pricing, leap-year term days, taxes, fees & commission
        const pricing = calculatePolicyIssuancePricing({
            annualBasePremiumCents: input.annualBasePremiumCents,
            effectiveStartDate: input.effectiveStartDate,
            effectiveEndDate: input.effectiveEndDate,
            riskState: input.riskState,
            brokerCommissionRateBps: broker.commission_rate_bps,
        });

        // 3. Check idempotency if policy was already created with this key
        const existingTx = await manager.findOne(LedgerTransaction, {
            where: { idempotency_key: `collect_${input.idempotencyKey}` },
            relations: { entries: true },
        });
        if (existingTx && existingTx.policy_id) {
            const existingPolicy = await manager.findOneOrFail(Policy, {
                where: { id: existingTx.policy_id },
            });
            const existingEvent = await manager.findOneOrFail(PolicyEvent, {
                where: { policy_id: existingPolicy.id, sequence_number: 1 },
            });
            const existingCommTx = await manager.findOne(LedgerTransaction, {
                where: { idempotency_key: `comm_${input.idempotencyKey}` },
                relations: { entries: true },
            });
            return {
                policy: existingPolicy,
                issuanceEvent: existingEvent,
                pricing,
                collectionLedgerTx: existingTx,
                commissionLedgerTx: existingCommTx,
            };
        }

        // 4. Generate deterministic human-readable policy number
        const countResult = await manager.query(`SELECT count(*) FROM policies;`);
        const nextSeq = parseInt(countResult[0].count, 10) + 1;
        const yearPrefix = pricing.effectiveStartDate.slice(0, 4);
        const lineCode =
            (input.productLine ?? 'COMMERCIAL_GENERAL_LIABILITY') === 'CYBER_TECH_EO'
                ? 'CYB'
                : 'CGL';
        const policyNumber = `CORGI-${lineCode}-${yearPrefix}-${String(nextSeq).padStart(
            4,
            '0'
        )}`;

        const isBound = Boolean(input.collectImmediately || input.stripePaymentIntentId);

        // 5. Create Policy header
        const policy = manager.create(Policy, {
            policy_number: policyNumber,
            broker_id: broker.id,
            insured_name: input.insuredName,
            insured_ein: input.insuredEin,
            insured_address: input.insuredAddress,
            risk_state: input.riskState.toUpperCase(),
            product_line: input.productLine ?? 'COMMERCIAL_GENERAL_LIABILITY',
            effective_start_date: pricing.effectiveStartDate,
            effective_end_date: pricing.effectiveEndDate,
            term_days: pricing.termDays,
            status: isBound ? 'BOUND_ACTIVE' : 'QUOTED',
            coverage_limit_cents: input.coverageLimitCents,
            deductible_cents: input.deductibleCents,
            current_written_premium_cents: pricing.basePremiumCents,
            state_tax_cents: pricing.stateTaxCents,
            stamping_fee_cents: pricing.stampingFeeCents,
            carrier_policy_fee_cents: pricing.carrierPolicyFeeCents,
            total_gross_charged_cents: pricing.totalGrossChargedCents,
            stripe_payment_intent_id: input.stripePaymentIntentId ?? null,
            stripe_charge_id: input.stripeChargeId ?? null,
            payment_method_type: input.paymentMethodType ?? 'CARD',
        });

        const savedPolicy = await manager.save(Policy, policy);

        // 6. Create initial immutable PolicyEvent (Sequence #1: POLICY_ISSUED)
        const issuanceEvent = manager.create(PolicyEvent, {
            policy_id: savedPolicy.id,
            sequence_number: 1,
            event_type: 'POLICY_ISSUED',
            description: `Initial policy issuance (${pricing.termDays}-day anniversary term, ${input.riskState.toUpperCase()} tax schedule)`,
            effective_date: pricing.effectiveStartDate,
            active_days_in_term: pricing.termDays,
            annualized_premium_delta_cents: pricing.basePremiumCents,
            prorated_premium_delta_cents: pricing.basePremiumCents,
            state_tax_delta_cents: pricing.stateTaxCents,
            stamping_fee_delta_cents: pricing.stampingFeeCents,
            fee_or_penalty_delta_cents: pricing.carrierPolicyFeeCents,
            total_gross_delta_cents: pricing.totalGrossChargedCents,
            rounding_penny_variance_cents: 0,
            coverage_snapshot: {
                coverage_limit_cents: input.coverageLimitCents,
                deductible_cents: input.deductibleCents,
                insured_address: input.insuredAddress,
                vehicles_covered: input.vehiclesCovered ?? [],
                additional_insureds: input.additionalInsureds ?? [],
                annualized_base_premium_cents: pricing.basePremiumCents,
            },
            external_payment_or_refund_id:
                input.stripeChargeId ?? input.stripePaymentIntentId ?? null,
            created_by: input.createdBy ?? 'SYSTEM',
        });

        const savedEvent = await manager.save(PolicyEvent, issuanceEvent);

        let collectionLedgerTx: LedgerTransaction | null = null;
        let commissionLedgerTx: LedgerTransaction | null = null;

        // 7. If collected, post Double-Entry Cash Receipt & Cash-Basis Broker Commission Accrual
        if (isBound) {
            collectionLedgerTx = await postBalancedJournalTransaction(manager, {
                idempotencyKey: `collect_${input.idempotencyKey}`,
                eventCategory: 'PREMIUM_COLLECTION',
                description: `Collected gross issuance payment for ${savedPolicy.policy_number} (Base Premium + ${input.riskState} Tax/Stamping + Policy Fee)`,
                effectiveDate: pricing.effectiveStartDate,
                policyId: savedPolicy.id,
                brokerId: broker.id,
                policyEventId: savedEvent.id,
                externalReferenceId:
                    input.stripeChargeId ??
                    input.stripePaymentIntentId ??
                    `sim_pi_${savedPolicy.policy_number}`,
                createdBy: input.createdBy ?? 'SYSTEM',
                lines: [
                    {
                        accountCode: LedgerAccount.OPERATING_CASH_SETTLED,
                        direction: 'DEBIT',
                        amountCents: pricing.totalGrossChargedCents,
                    },
                    {
                        accountCode: LedgerAccount.UNEARNED_PREMIUM_RESERVE,
                        direction: 'CREDIT',
                        amountCents: pricing.basePremiumCents,
                    },
                    {
                        accountCode: LedgerAccount.STATE_TAX_PAYABLE,
                        direction: 'CREDIT',
                        amountCents: pricing.stateTaxCents,
                    },
                    {
                        accountCode: LedgerAccount.STATUTORY_FEE_PAYABLE,
                        direction: 'CREDIT',
                        amountCents: pricing.stampingFeeCents,
                    },
                    {
                        accountCode: LedgerAccount.POLICY_FEE_REVENUE,
                        direction: 'CREDIT',
                        amountCents: pricing.carrierPolicyFeeCents,
                    },
                ],
            });

            // Link ledger transaction ID on the initial PolicyEvent?
            // Note: PolicyEvent is protected by our UPDATE trigger! So we pass policy_event_id into
            // LedgerTransaction (which already stores `policy_event_id: savedEvent.id`).

            // Gauntlet #7: Accrue Broker Commission on COLLECTED Base Premium (excluding taxes & fees)
            if (pricing.brokerCommissionCents > 0) {
                commissionLedgerTx = await postBalancedJournalTransaction(manager, {
                    idempotencyKey: `comm_${input.idempotencyKey}`,
                    eventCategory: 'COMMISSION_ACCRUAL',
                    description: `Broker commission earned (${(
                        broker.commission_rate_bps / 100
                    ).toFixed(2)}%) on collected base premium for ${savedPolicy.policy_number}`,
                    effectiveDate: pricing.effectiveStartDate,
                    policyId: savedPolicy.id,
                    brokerId: broker.id,
                    policyEventId: savedEvent.id,
                    createdBy: input.createdBy ?? 'SYSTEM',
                    lines: [
                        {
                            accountCode: LedgerAccount.BROKER_COMMISSION_EXPENSE,
                            direction: 'DEBIT',
                            amountCents: pricing.brokerCommissionCents,
                        },
                        {
                            accountCode: LedgerAccount.BROKER_COMMISSION_PAYABLE,
                            direction: 'CREDIT',
                            amountCents: pricing.brokerCommissionCents,
                        },
                    ],
                });
            }
        }

        return {
            policy: savedPolicy,
            issuanceEvent: savedEvent,
            pricing,
            collectionLedgerTx,
            commissionLedgerTx,
        };
    });
}

// ============================================================================
// 3. MID-TERM ENDORSEMENTS (GAUNTLET #3: PRO-RATA FROM EFFECTIVE DATE)
// ============================================================================

export interface ApplyEndorsementInput {
    idempotencyKey: string;
    policyId: string;
    endorsementEffectiveDate: string; // YYYY-MM-DD (Never entry_date!)
    description: string;
    /** Annualized full-term base premium delta (positive for increase, negative for reduction) */
    annualizedBasePremiumDeltaCents: number;
    newCoverageLimitCents?: number;
    newDeductibleCents?: number;
    newInsuredAddress?: string;
    newVehiclesCovered?: string[];
    newAdditionalInsureds?: string[];
    externalPaymentOrRefundId?: string | null;
    createdBy?: string;
    /** Internal flag when invoked by Maker-Checker approval execution */
    bypassMakerChecker?: boolean;
}

export interface ApplyEndorsementResult {
    status: 'APPLIED' | 'QUEUED_FOR_APPROVAL';
    policy: Policy;
    endorsementEvent?: PolicyEvent;
    pricing: EndorsementPricingResult;
    ledgerTransaction?: LedgerTransaction;
    commissionTransaction?: LedgerTransaction | null;
    approvalRequest?: ApprovalRequest;
}

/**
 * Applies a mid-term endorsement to an active policy, priced pro-rata over the remaining term
 * from `endorsementEffectiveDate`.
 * If the gross delta exceeds the Maker-Checker threshold (and `bypassMakerChecker` is false),
 * routes the change into `approval_requests`.
 */
export async function applyMidTermEndorsement(
    input: ApplyEndorsementInput
): Promise<ApplyEndorsementResult> {
    return withTransaction(async (manager) => {
        // 1. Lock Policy row with pessimistic_write to serialize concurrent endorsements
        const policy = await manager.findOne(Policy, {
            where: { id: input.policyId },
            lock: { mode: 'pessimistic_write' },
        });
        if (!policy) {
            throw new Error(`POLICY_NOT_FOUND: Policy ${input.policyId} does not exist.`);
        }
        if (policy.status !== 'BOUND_ACTIVE') {
            throw new Error(
                `INVALID_POLICY_STATE: Cannot endorse policy ${policy.policy_number} in status "${policy.status}".`
            );
        }

        const broker = await manager.findOneOrFail(Broker, {
            where: { id: policy.broker_id },
        });

        // 2. Compute deterministic pro-rata endorsement pricing from effective_date
        const pricing = calculateEndorsementPricing({
            annualizedBasePremiumDeltaCents: input.annualizedBasePremiumDeltaCents,
            policyEffectiveStartDate: policy.effective_start_date,
            policyEffectiveEndDate: policy.effective_end_date,
            endorsementEffectiveDate: input.endorsementEffectiveDate,
            riskState: policy.risk_state,
            brokerCommissionRateBps: broker.commission_rate_bps,
        });

        // 3. Check Maker-Checker threshold for large money-out / high-delta endorsements
        if (
            !input.bypassMakerChecker &&
            Math.abs(pricing.totalGrossDeltaCents) >= DEFAULT_MAKER_CHECKER_THRESHOLD_CENTS
        ) {
            const approval = manager.create(ApprovalRequest, {
                action_type: 'ENDORSEMENT_HIGH_DELTA',
                status: 'PENDING',
                policy_id: policy.id,
                amount_cents: Math.abs(pricing.totalGrossDeltaCents),
                summary: `Mid-term endorsement on ${policy.policy_number}: ${input.description} (Effective ${input.endorsementEffectiveDate})`,
                execution_payload: { ...input, bypassMakerChecker: true },
                initiated_by_user: input.createdBy ?? 'agent@corgi-trial.internal',
                initiated_by_role: 'MAKER_OPS',
                is_agent_initiated: (input.createdBy ?? '').includes('mcp'),
            });
            const savedApproval = await manager.save(ApprovalRequest, approval);
            return {
                status: 'QUEUED_FOR_APPROVAL',
                policy,
                pricing,
                approvalRequest: savedApproval,
            };
        }

        // 4. Fetch latest PolicyEvent to determine next sequence_number and current coverage snapshot
        const existingEvents = await manager.find(PolicyEvent, {
            where: { policy_id: policy.id },
            order: { sequence_number: 'DESC' },
        });
        const latestEvent = existingEvents[0];
        const nextSequenceNumber = (latestEvent?.sequence_number ?? 1) + 1;
        const prevSnapshot = latestEvent.coverage_snapshot;

        const updatedAnnualizedBase =
            prevSnapshot.annualized_base_premium_cents + input.annualizedBasePremiumDeltaCents;
        const updatedLimitCents =
            input.newCoverageLimitCents ?? prevSnapshot.coverage_limit_cents;
        const updatedDeductibleCents =
            input.newDeductibleCents ?? prevSnapshot.deductible_cents;
        const updatedAddress = input.newInsuredAddress ?? prevSnapshot.insured_address;

        // 5. Append immutable PolicyEvent
        const endorsementEvent = manager.create(PolicyEvent, {
            policy_id: policy.id,
            sequence_number: nextSequenceNumber,
            event_type: 'ENDORSEMENT_APPLIED',
            description: input.description,
            effective_date: pricing.endorsementEffectiveDate,
            active_days_in_term: pricing.activeRemainingDays,
            annualized_premium_delta_cents: pricing.annualizedBasePremiumDeltaCents,
            prorated_premium_delta_cents: pricing.proratedBasePremiumDeltaCents,
            state_tax_delta_cents: pricing.stateTaxDeltaCents,
            stamping_fee_delta_cents: pricing.stampingFeeDeltaCents,
            fee_or_penalty_delta_cents: pricing.carrierFeeDeltaCents,
            total_gross_delta_cents: pricing.totalGrossDeltaCents,
            rounding_penny_variance_cents: pricing.roundingPennyVarianceCents,
            coverage_snapshot: {
                coverage_limit_cents: updatedLimitCents,
                deductible_cents: updatedDeductibleCents,
                insured_address: updatedAddress,
                vehicles_covered: input.newVehiclesCovered ?? prevSnapshot.vehicles_covered,
                additional_insureds:
                    input.newAdditionalInsureds ?? prevSnapshot.additional_insureds,
                annualized_base_premium_cents: updatedAnnualizedBase,
            },
            external_payment_or_refund_id: input.externalPaymentOrRefundId ?? null,
            created_by: input.createdBy ?? 'SYSTEM',
        });

        const savedEvent = await manager.save(PolicyEvent, endorsementEvent);

        // 6. Post Double-Entry Ledger Transaction for the Endorsement
        const isIncrease = pricing.totalGrossDeltaCents >= 0;
        const absGross = Math.abs(pricing.totalGrossDeltaCents);
        const absBase = Math.abs(pricing.proratedBasePremiumDeltaCents);
        const absTax = Math.abs(pricing.stateTaxDeltaCents);
        const absStamping = Math.abs(pricing.stampingFeeDeltaCents);

        const lines: JournalLineInput[] = isIncrease
            ? [
                {
                    accountCode: LedgerAccount.OPERATING_CASH_SETTLED,
                    direction: 'DEBIT',
                    amountCents: absGross,
                },
                {
                    accountCode: LedgerAccount.UNEARNED_PREMIUM_RESERVE,
                    direction: 'CREDIT',
                    amountCents: absBase,
                },
                {
                    accountCode: LedgerAccount.STATE_TAX_PAYABLE,
                    direction: 'CREDIT',
                    amountCents: absTax,
                },
                {
                    accountCode: LedgerAccount.STATUTORY_FEE_PAYABLE,
                    direction: 'CREDIT',
                    amountCents: absStamping,
                },
            ]
            : [
                {
                    accountCode: LedgerAccount.UNEARNED_PREMIUM_RESERVE,
                    direction: 'DEBIT',
                    amountCents: absBase,
                },
                {
                    accountCode: LedgerAccount.STATE_TAX_PAYABLE,
                    direction: 'DEBIT',
                    amountCents: absTax,
                },
                {
                    accountCode: LedgerAccount.STATUTORY_FEE_PAYABLE,
                    direction: 'DEBIT',
                    amountCents: absStamping,
                },
                {
                    accountCode: LedgerAccount.OPERATING_CASH_SETTLED,
                    direction: 'CREDIT',
                    amountCents: absGross,
                },
            ];

        const ledgerTransaction = await postBalancedJournalTransaction(manager, {
            idempotencyKey: `end_${input.idempotencyKey}`,
            eventCategory: 'ENDORSEMENT',
            description: `Endorsement #${nextSequenceNumber} on ${policy.policy_number} (Effective ${pricing.endorsementEffectiveDate}): ${input.description}`,
            effectiveDate: pricing.endorsementEffectiveDate,
            policyId: policy.id,
            brokerId: broker.id,
            policyEventId: savedEvent.id,
            externalReferenceId:
                input.externalPaymentOrRefundId ??
                `sim_end_${policy.policy_number}_${nextSequenceNumber}`,
            createdBy: input.createdBy ?? 'SYSTEM',
            lines,
        });

        // 7. Book Commission Accrual (if positive delta) or Commission Clawback (if return premium)
        let commissionTransaction: LedgerTransaction | null = null;
        if (pricing.brokerCommissionDeltaCents !== 0) {
            const absComm = Math.abs(pricing.brokerCommissionDeltaCents);
            const isCommIncrease = pricing.brokerCommissionDeltaCents > 0;

            commissionTransaction = await postBalancedJournalTransaction(manager, {
                idempotencyKey: `end_comm_${input.idempotencyKey}`,
                eventCategory: isCommIncrease ? 'COMMISSION_ACCRUAL' : 'COMMISSION_CLAWBACK',
                description: `${isCommIncrease ? 'Commission accrual' : 'Commission clawback'
                    } on Endorsement #${nextSequenceNumber} for ${policy.policy_number}`,
                effectiveDate: pricing.endorsementEffectiveDate,
                policyId: policy.id,
                brokerId: broker.id,
                policyEventId: savedEvent.id,
                createdBy: input.createdBy ?? 'SYSTEM',
                lines: isCommIncrease
                    ? [
                        {
                            accountCode: LedgerAccount.BROKER_COMMISSION_EXPENSE,
                            direction: 'DEBIT',
                            amountCents: absComm,
                        },
                        {
                            accountCode: LedgerAccount.BROKER_COMMISSION_PAYABLE,
                            direction: 'CREDIT',
                            amountCents: absComm,
                        },
                    ]
                    : [
                        {
                            accountCode: LedgerAccount.BROKER_COMMISSION_PAYABLE,
                            direction: 'DEBIT',
                            amountCents: absComm,
                        },
                        {
                            accountCode: LedgerAccount.BROKER_COMMISSION_EXPENSE,
                            direction: 'CREDIT',
                            amountCents: absComm,
                        },
                    ],
            });
        }

        // 8. Update cached summary figures on Policy header (Policy header is mutable state cache;
        // PolicyEvent and LedgerEntry are strictly append-only)
        policy.coverage_limit_cents = updatedLimitCents;
        policy.deductible_cents = updatedDeductibleCents;
        policy.insured_address = updatedAddress;
        policy.current_written_premium_cents += pricing.proratedBasePremiumDeltaCents;
        policy.state_tax_cents += pricing.stateTaxDeltaCents;
        policy.stamping_fee_cents += pricing.stampingFeeDeltaCents;
        policy.total_gross_charged_cents += pricing.totalGrossDeltaCents;

        const updatedPolicy = await manager.save(Policy, policy);

        return {
            status: 'APPLIED',
            policy: updatedPolicy,
            endorsementEvent: savedEvent,
            pricing,
            ledgerTransaction,
            commissionTransaction,
        };
    });
}

// ============================================================================
// 4. THE CORRECTION TEST: BACKDATED REVERSAL + RE-BOOK (GAUNTLET #4)
// ============================================================================

export interface CorrectionTestInput {
    idempotencyKey: string;
    policyId: string;
    /** ID of the erroneous PolicyEvent (e.g., an endorsement entered with the wrong effective_date) */
    erroneousPolicyEventId: string;
    /** The corrected legal effective date (YYYY-MM-DD) */
    correctedEffectiveDate: string;
    correctionReason: string;
    createdBy?: string;
}

export interface CorrectionTestResult {
    policy: Policy;
    reversedPolicyEvent: PolicyEvent;
    rebookedPolicyEvent: PolicyEvent;
    reversalLedgerTxs: LedgerTransaction[];
    rebookLedgerTx: LedgerTransaction;
    rebookCommissionTx: LedgerTransaction | null;
    newPricing: EndorsementPricingResult;
}

/**
 * Gauntlet #4 ("The Correction Test"):
 * Fixes an endorsement entered with the wrong `effective_date` using ONLY compensating
 * reversal entries and a re-booked endorsement at the corrected effective date.
 *
 * ZERO UPDATEs or DELETEs on `policy_events`, `ledger_transactions`, or `ledger_entries`.
 */
export async function executeEndorsementCorrection(
    input: CorrectionTestInput
): Promise<CorrectionTestResult> {
    return withTransaction(async (manager) => {
        const policy = await manager.findOne(Policy, {
            where: { id: input.policyId },
            lock: { mode: 'pessimistic_write' },
        });
        if (!policy) {
            throw new Error(`POLICY_NOT_FOUND: Policy ${input.policyId} does not exist.`);
        }

        const broker = await manager.findOneOrFail(Broker, {
            where: { id: policy.broker_id },
        });

        // 1. Load the original erroneous endorsement event
        const badEvent = await manager.findOne(PolicyEvent, {
            where: { id: input.erroneousPolicyEventId, policy_id: policy.id },
        });
        if (!badEvent) {
            throw new Error(
                `EVENT_NOT_FOUND: PolicyEvent ${input.erroneousPolicyEventId} not found on policy ${policy.policy_number}.`
            );
        }
        if (
            badEvent.event_type !== 'ENDORSEMENT_APPLIED' &&
            badEvent.event_type !== 'ENDORSEMENT_REBOOK'
        ) {
            throw new Error(
                `INVALID_CORRECTION_TARGET: Only ENDORSEMENT_APPLIED or ENDORSEMENT_REBOOK events can be reversed and rebooked (got ${badEvent.event_type}).`
            );
        }

        // Ensure it hasn't already been reversed
        const alreadyReversed = await manager.findOne(PolicyEvent, {
            where: { policy_id: policy.id, reverses_event_id: badEvent.id },
        });
        if (alreadyReversed) {
            throw new Error(
                `ALREADY_REVERSED: PolicyEvent #${badEvent.sequence_number} was already reversed by event #${alreadyReversed.sequence_number}.`
            );
        }

        // 2. Find all original LedgerTransactions tied to the erroneous PolicyEvent
        const originalLedgerTxs = await manager.find(LedgerTransaction, {
            where: { policy_event_id: badEvent.id },
            relations: { entries: true },
            order: { recorded_at: 'ASC' },
        });

        // 3. Determine sequence numbers
        const allEvents = await manager.find(PolicyEvent, {
            where: { policy_id: policy.id },
            order: { sequence_number: 'DESC' },
        });
        const nextSeq = (allEvents[0]?.sequence_number ?? 1) + 1;

        // 4. STEP A: Append Compensating `ENDORSEMENT_REVERSAL` PolicyEvent
        // Notice we set `effective_date: badEvent.effective_date` and exact negative deltas
        // so that any As-Of calculation or earned-premium slice cancels out the erroneous slice 100%!
        const reversalEvent = manager.create(PolicyEvent, {
            policy_id: policy.id,
            sequence_number: nextSeq,
            event_type: 'ENDORSEMENT_REVERSAL',
            description: `REVERSAL of Endorsement #${badEvent.sequence_number} (was effective ${badEvent.effective_date}): ${input.correctionReason}`,
            effective_date: badEvent.effective_date,
            active_days_in_term: badEvent.active_days_in_term,
            annualized_premium_delta_cents: -badEvent.annualized_premium_delta_cents,
            prorated_premium_delta_cents: -badEvent.prorated_premium_delta_cents,
            state_tax_delta_cents: -badEvent.state_tax_delta_cents,
            stamping_fee_delta_cents: -badEvent.stamping_fee_delta_cents,
            fee_or_penalty_delta_cents: -badEvent.fee_or_penalty_delta_cents,
            total_gross_delta_cents: -badEvent.total_gross_delta_cents,
            rounding_penny_variance_cents: -badEvent.rounding_penny_variance_cents,
            coverage_snapshot: badEvent.coverage_snapshot,
            reverses_event_id: badEvent.id,
            created_by: input.createdBy ?? 'SYSTEM',
        });

        const savedReversalEvent = await manager.save(PolicyEvent, reversalEvent);

        // 5. Post mirror-image reversing LedgerTransactions for every original transaction
        const reversalLedgerTxs: LedgerTransaction[] = [];
        for (const origTx of originalLedgerTxs) {
            const revTx = await postBalancedJournalTransaction(manager, {
                idempotencyKey: `rev_${origTx.id}_${input.idempotencyKey}`,
                eventCategory: 'CORRECTION_REVERSAL',
                description: `REVERSAL of tx ${origTx.idempotency_key} (Endorsement #${badEvent.sequence_number}): ${input.correctionReason}`,
                effectiveDate: badEvent.effective_date,
                policyId: policy.id,
                brokerId: broker.id,
                policyEventId: savedReversalEvent.id,
                reversesTransactionId: origTx.id,
                createdBy: input.createdBy ?? 'SYSTEM',
                lines: buildReversalLinesFromTransaction(origTx),
            });
            reversalLedgerTxs.push(revTx);
        }

        // 6. STEP B: Re-compute proration at the `correctedEffectiveDate` and append `ENDORSEMENT_REBOOK`
        const newPricing = calculateEndorsementPricing({
            annualizedBasePremiumDeltaCents: badEvent.annualized_premium_delta_cents,
            policyEffectiveStartDate: policy.effective_start_date,
            policyEffectiveEndDate: policy.effective_end_date,
            endorsementEffectiveDate: input.correctedEffectiveDate,
            riskState: policy.risk_state,
            brokerCommissionRateBps: broker.commission_rate_bps,
        });

        const rebookEvent = manager.create(PolicyEvent, {
            policy_id: policy.id,
            sequence_number: nextSeq + 1,
            event_type: 'ENDORSEMENT_REBOOK',
            description: `RE-BOOK of Endorsement #${badEvent.sequence_number} at corrected effective date ${input.correctedEffectiveDate}: ${badEvent.description}`,
            effective_date: newPricing.endorsementEffectiveDate,
            active_days_in_term: newPricing.activeRemainingDays,
            annualized_premium_delta_cents: newPricing.annualizedBasePremiumDeltaCents,
            prorated_premium_delta_cents: newPricing.proratedBasePremiumDeltaCents,
            state_tax_delta_cents: newPricing.stateTaxDeltaCents,
            stamping_fee_delta_cents: newPricing.stampingFeeDeltaCents,
            fee_or_penalty_delta_cents: newPricing.carrierFeeDeltaCents,
            total_gross_delta_cents: newPricing.totalGrossDeltaCents,
            rounding_penny_variance_cents: newPricing.roundingPennyVarianceCents,
            coverage_snapshot: badEvent.coverage_snapshot,
            reverses_event_id: badEvent.id,
            created_by: input.createdBy ?? 'SYSTEM',
        });

        const savedRebookEvent = await manager.save(PolicyEvent, rebookEvent);

        // 7. Post new balanced LedgerTransaction for the re-booked endorsement
        const isIncrease = newPricing.totalGrossDeltaCents >= 0;
        const absGross = Math.abs(newPricing.totalGrossDeltaCents);
        const absBase = Math.abs(newPricing.proratedBasePremiumDeltaCents);
        const absTax = Math.abs(newPricing.stateTaxDeltaCents);
        const absStamping = Math.abs(newPricing.stampingFeeDeltaCents);

        const rebookLedgerTx = await postBalancedJournalTransaction(manager, {
            idempotencyKey: `rebook_${input.idempotencyKey}`,
            eventCategory: 'CORRECTION_REBOOK',
            description: `RE-BOOK Endorsement #${savedRebookEvent.sequence_number} on ${policy.policy_number} (Corrected Effective Date ${input.correctedEffectiveDate})`,
            effectiveDate: newPricing.endorsementEffectiveDate,
            policyId: policy.id,
            brokerId: broker.id,
            policyEventId: savedRebookEvent.id,
            externalReferenceId: `sim_rebook_${policy.policy_number}_${savedRebookEvent.sequence_number}`,
            createdBy: input.createdBy ?? 'SYSTEM',
            lines: isIncrease
                ? [
                    {
                        accountCode: LedgerAccount.OPERATING_CASH_SETTLED,
                        direction: 'DEBIT',
                        amountCents: absGross,
                    },
                    {
                        accountCode: LedgerAccount.UNEARNED_PREMIUM_RESERVE,
                        direction: 'CREDIT',
                        amountCents: absBase,
                    },
                    {
                        accountCode: LedgerAccount.STATE_TAX_PAYABLE,
                        direction: 'CREDIT',
                        amountCents: absTax,
                    },
                    {
                        accountCode: LedgerAccount.STATUTORY_FEE_PAYABLE,
                        direction: 'CREDIT',
                        amountCents: absStamping,
                    },
                ]
                : [
                    {
                        accountCode: LedgerAccount.UNEARNED_PREMIUM_RESERVE,
                        direction: 'DEBIT',
                        amountCents: absBase,
                    },
                    {
                        accountCode: LedgerAccount.STATE_TAX_PAYABLE,
                        direction: 'DEBIT',
                        amountCents: absTax,
                    },
                    {
                        accountCode: LedgerAccount.STATUTORY_FEE_PAYABLE,
                        direction: 'DEBIT',
                        amountCents: absStamping,
                    },
                    {
                        accountCode: LedgerAccount.OPERATING_CASH_SETTLED,
                        direction: 'CREDIT',
                        amountCents: absGross,
                    },
                ],
        });

        let rebookCommissionTx: LedgerTransaction | null = null;
        if (newPricing.brokerCommissionDeltaCents !== 0) {
            const absComm = Math.abs(newPricing.brokerCommissionDeltaCents);
            const isCommPos = newPricing.brokerCommissionDeltaCents > 0;
            rebookCommissionTx = await postBalancedJournalTransaction(manager, {
                idempotencyKey: `rebook_comm_${input.idempotencyKey}`,
                eventCategory: isCommPos ? 'COMMISSION_ACCRUAL' : 'COMMISSION_CLAWBACK',
                description: `RE-BOOK broker commission on Endorsement #${savedRebookEvent.sequence_number} for ${policy.policy_number}`,
                effectiveDate: newPricing.endorsementEffectiveDate,
                policyId: policy.id,
                brokerId: broker.id,
                policyEventId: savedRebookEvent.id,
                createdBy: input.createdBy ?? 'SYSTEM',
                lines: isCommPos
                    ? [
                        {
                            accountCode: LedgerAccount.BROKER_COMMISSION_EXPENSE,
                            direction: 'DEBIT',
                            amountCents: absComm,
                        },
                        {
                            accountCode: LedgerAccount.BROKER_COMMISSION_PAYABLE,
                            direction: 'CREDIT',
                            amountCents: absComm,
                        },
                    ]
                    : [
                        {
                            accountCode: LedgerAccount.BROKER_COMMISSION_PAYABLE,
                            direction: 'DEBIT',
                            amountCents: absComm,
                        },
                        {
                            accountCode: LedgerAccount.BROKER_COMMISSION_EXPENSE,
                            direction: 'CREDIT',
                            amountCents: absComm,
                        },
                    ],
            });
        }

        // 8. Adjust Policy header summary by (-badEvent + rebookEvent)
        policy.current_written_premium_cents +=
            -badEvent.prorated_premium_delta_cents + newPricing.proratedBasePremiumDeltaCents;
        policy.state_tax_cents +=
            -badEvent.state_tax_delta_cents + newPricing.stateTaxDeltaCents;
        policy.stamping_fee_cents +=
            -badEvent.stamping_fee_delta_cents + newPricing.stampingFeeDeltaCents;
        policy.total_gross_charged_cents +=
            -badEvent.total_gross_delta_cents + newPricing.totalGrossDeltaCents;

        const updatedPolicy = await manager.save(Policy, policy);

        return {
            policy: updatedPolicy,
            reversedPolicyEvent: savedReversalEvent,
            rebookedPolicyEvent: savedRebookEvent,
            reversalLedgerTxs,
            rebookLedgerTx,
            rebookCommissionTx,
            newPricing,
        };
    });
}

// ============================================================================
// 5. POLICY CANCELLATION, UNEARNED REFUND & COMMISSION CLAWBACK (GAUNTLETS #5, #7)
// ============================================================================

export interface CancelPolicyInput {
    idempotencyKey: string;
    policyId: string;
    cancellationEffectiveDate: string; // YYYY-MM-DD
    cancellationMethod: CancellationType; // 'PRO_RATA' | 'SHORT_RATE'
    reason: string;
    externalRefundId?: string | null; // e.g., Live Stripe Refund ID `re_...`
    createdBy?: string;
}

export interface CancelPolicyResult {
    policy: Policy;
    cancellationEvent: PolicyEvent;
    calculation: CancellationCalculationResult;
    earnedRecognitionTx: LedgerTransaction | null;
    refundLedgerTx: LedgerTransaction | null;
    commissionClawbackTx: LedgerTransaction | null;
}

/**
 * Gauntlet #5, #7, #10, #11:
 * Cancels an active policy as of `cancellationEffectiveDate`:
 *  1. Recognizes earned premium up to `cancellationEffectiveDate` so `UNEARNED_PREMIUM_RESERVE`
 *     reflects the exact unearned balance.
 *  2. Clears the remaining `UNEARNED_PREMIUM_RESERVE` to $0.00, routing any short-rate penalty
 *     to `REVENUE:SHORT_RATE_PENALTY_REVENUE` and refunding unearned base premium + refundable
 *     state surplus lines tax out of `ASSET:OPERATING_CASH_SETTLED`.
 *  3. Claws back the broker's unearned commission (`DEBIT BROKER_COMMISSION_PAYABLE`,
 *     `CREDIT BROKER_COMMISSION_EXPENSE`).
 */
export async function cancelPolicyAndRefund(
    input: CancelPolicyInput
): Promise<CancelPolicyResult> {
    return withTransaction(async (manager) => {
        const policy = await manager.findOne(Policy, {
            where: { id: input.policyId },
            lock: { mode: 'pessimistic_write' },
        });
        if (!policy) {
            throw new Error(`POLICY_NOT_FOUND: Policy ${input.policyId} does not exist.`);
        }
        if (policy.status !== 'BOUND_ACTIVE') {
            throw new Error(
                `POLICY_ALREADY_INACTIVE: Policy ${policy.policy_number} has status "${policy.status}".`
            );
        }

        const broker = await manager.findOneOrFail(Broker, {
            where: { id: policy.broker_id },
        });

        // 1. Load all policy events to build slices
        const events = await manager.find(PolicyEvent, {
            where: { policy_id: policy.id },
            order: { sequence_number: 'ASC' },
        });

        const slices: PolicyFinancialSlice[] = events.map((e) => ({
            eventId: e.id,
            eventType: e.event_type as PolicyFinancialSlice['eventType'],
            effectiveDate: e.effective_date,
            recordedAt: e.recorded_at,
            activeDaysInTerm: e.active_days_in_term,
            proratedBasePremiumDeltaCents: e.prorated_premium_delta_cents,
            stateTaxDeltaCents: e.state_tax_delta_cents,
            stampingFeeDeltaCents: e.stamping_fee_delta_cents,
            feeOrPenaltyDeltaCents: e.fee_or_penalty_delta_cents,
            reversesEventId: e.reverses_event_id,
        }));

        // 2. Calculate exact refund, short-rate penalty, state tax refund, and commission clawback
        const calculation = calculateCancellationRefund({
            policyStartDate: policy.effective_start_date,
            policyEndDate: policy.effective_end_date,
            cancellationEffectiveDate: input.cancellationEffectiveDate,
            cancellationMethod: input.cancellationMethod,
            riskState: policy.risk_state,
            brokerCommissionRateBps: broker.commission_rate_bps,
            slices,
        });

        // 3. Check how much Earned Premium has already been recognized in the ledger for this policy
        const existingEntries = await manager.find(LedgerEntry, {
            where: {
                policy_id: policy.id,
                account_code: LedgerAccount.EARNED_PREMIUM_REVENUE,
            },
        });
        const alreadyRecognizedEarnedCents = existingEntries.reduce(
            (acc, entry) =>
                acc + (entry.direction === 'CREDIT' ? entry.amount_cents : -entry.amount_cents),
            0
        );

        const unrecognizedEarnedDeltaCents =
            calculation.earnedBasePremiumCents - alreadyRecognizedEarnedCents;

        let earnedRecognitionTx: LedgerTransaction | null = null;
        if (unrecognizedEarnedDeltaCents > 0) {
            earnedRecognitionTx = await postBalancedJournalTransaction(manager, {
                idempotencyKey: `earn_to_cancel_${input.idempotencyKey}`,
                eventCategory: 'EARNED_PREMIUM_RECOGNITION',
                description: `Pro-rata earned premium recognition through cancellation date ${input.cancellationEffectiveDate} for ${policy.policy_number}`,
                effectiveDate: input.cancellationEffectiveDate,
                policyId: policy.id,
                brokerId: broker.id,
                createdBy: input.createdBy ?? 'SYSTEM',
                lines: [
                    {
                        accountCode: LedgerAccount.UNEARNED_PREMIUM_RESERVE,
                        direction: 'DEBIT',
                        amountCents: unrecognizedEarnedDeltaCents,
                    },
                    {
                        accountCode: LedgerAccount.EARNED_PREMIUM_REVENUE,
                        direction: 'CREDIT',
                        amountCents: unrecognizedEarnedDeltaCents,
                    },
                ],
            });
        }

        // 4. Append immutable PolicyEvent (`POLICY_CANCELLED`)
        const nextSeq = (events[events.length - 1]?.sequence_number ?? 1) + 1;
        const latestSnapshot = events[events.length - 1].coverage_snapshot;

        const cancellationEvent = manager.create(PolicyEvent, {
            policy_id: policy.id,
            sequence_number: nextSeq,
            event_type: 'POLICY_CANCELLED',
            description: `${input.cancellationMethod} Cancellation effective ${input.cancellationEffectiveDate}: ${input.reason}`,
            effective_date: input.cancellationEffectiveDate,
            active_days_in_term: 0,
            annualized_premium_delta_cents: 0,
            prorated_premium_delta_cents: -calculation.refundableBasePremiumCents,
            state_tax_delta_cents: -calculation.refundableStateTaxCents,
            stamping_fee_delta_cents: 0, // Non-refundable per statutory rule
            fee_or_penalty_delta_cents: calculation.shortRatePenaltyRetainedCents,
            total_gross_delta_cents: -calculation.totalCustomerCashRefundCents,
            rounding_penny_variance_cents: calculation.roundingPennyVarianceCents,
            coverage_snapshot: latestSnapshot,
            external_payment_or_refund_id: input.externalRefundId ?? null,
            created_by: input.createdBy ?? 'SYSTEM',
        });

        const savedCancelEvent = await manager.save(PolicyEvent, cancellationEvent);

        // 5. Post Cancellation Refund Journal Entry (Clears UNEARNED_PREMIUM_RESERVE to $0.00)
        let refundLedgerTx: LedgerTransaction | null = null;
        if (calculation.unearnedBasePremiumLiabilityClearedCents > 0) {
            const refundLines: JournalLineInput[] = [
                {
                    accountCode: LedgerAccount.UNEARNED_PREMIUM_RESERVE,
                    direction: 'DEBIT',
                    amountCents: calculation.unearnedBasePremiumLiabilityClearedCents,
                },
                {
                    accountCode: LedgerAccount.STATE_TAX_PAYABLE,
                    direction: 'DEBIT',
                    amountCents: calculation.refundableStateTaxCents,
                },
                {
                    accountCode: LedgerAccount.SHORT_RATE_PENALTY_REVENUE,
                    direction: 'CREDIT',
                    amountCents: calculation.shortRatePenaltyRetainedCents,
                },
                {
                    accountCode: LedgerAccount.OPERATING_CASH_SETTLED,
                    direction: 'CREDIT',
                    amountCents: calculation.totalCustomerCashRefundCents,
                },
            ];

            refundLedgerTx = await postBalancedJournalTransaction(manager, {
                idempotencyKey: `cancel_ref_${input.idempotencyKey}`,
                eventCategory: 'CANCELLATION_REFUND',
                description: `${input.cancellationMethod} cancellation refund for ${policy.policy_number} (Effective ${input.cancellationEffectiveDate})`,
                effectiveDate: input.cancellationEffectiveDate,
                policyId: policy.id,
                brokerId: broker.id,
                policyEventId: savedCancelEvent.id,
                externalReferenceId:
                    input.externalRefundId ?? `sim_re_${policy.policy_number}`,
                createdBy: input.createdBy ?? 'SYSTEM',
                lines: refundLines,
            });
        }

        // 6. Gauntlet #7: Claw back unearned Broker Commission on the refunded base premium
        let commissionClawbackTx: LedgerTransaction | null = null;
        if (calculation.brokerCommissionClawbackCents > 0) {
            commissionClawbackTx = await postBalancedJournalTransaction(manager, {
                idempotencyKey: `cancel_claw_${input.idempotencyKey}`,
                eventCategory: 'COMMISSION_CLAWBACK',
                description: `Broker commission clawback on ${input.cancellationMethod} cancellation of ${policy.policy_number}`,
                effectiveDate: input.cancellationEffectiveDate,
                policyId: policy.id,
                brokerId: broker.id,
                policyEventId: savedCancelEvent.id,
                createdBy: input.createdBy ?? 'SYSTEM',
                lines: [
                    {
                        accountCode: LedgerAccount.BROKER_COMMISSION_PAYABLE,
                        direction: 'DEBIT',
                        amountCents: calculation.brokerCommissionClawbackCents,
                    },
                    {
                        accountCode: LedgerAccount.BROKER_COMMISSION_EXPENSE,
                        direction: 'CREDIT',
                        amountCents: calculation.brokerCommissionClawbackCents,
                    },
                ],
            });
        }

        // 7. Update Policy status cache
        policy.status =
            input.cancellationMethod === 'SHORT_RATE'
                ? 'CANCELLED_SHORT_RATE'
                : 'CANCELLED_PRO_RATA';
        policy.cancelled_effective_date = input.cancellationEffectiveDate;
        policy.cancellation_type = input.cancellationMethod;

        const updatedPolicy = await manager.save(Policy, policy);

        return {
            policy: updatedPolicy,
            cancellationEvent: savedCancelEvent,
            calculation,
            earnedRecognitionTx,
            refundLedgerTx,
            commissionClawbackTx,
        };
    });
}

// ============================================================================
// 6. AS-OF DATE RECONSTRUCTION ("SHOW POLICY AS OF MAY 3" — GAUNTLET #9)
// ============================================================================

export interface ReconstructedPolicyState {
    policyId: string;
    policyNumber: string;
    insuredName: string;
    riskState: string;
    asOfDate: string;
    effectiveStartDate: string;
    effectiveEndDate: string;
    termDays: number;
    statusAsOfDate: Policy['status'];
    coverageSnapshotAsOfDate: PolicyEvent['coverage_snapshot'];
    earnedPosition: AsOfEarnedBreakdown;
    activeEventsAsOfDate: PolicyEvent[];
    ledgerTransactionsAsOfDate: LedgerTransaction[];
}

/**
 * Gauntlet #9: Reconstructs the complete state of a policy—coverage, limits, active endorsements,
 * written/earned/unearned premium, and ledger entries—as it stood on any `asOfDate` (YYYY-MM-DD).
 *
 * Optional `asOfRecordedTimestamp` allows inspecting what the system knew at a specific wall-clock
 * point in time (before a later backdated entry was recorded).
 */
export async function reconstructPolicyAsOf(params: {
    policyId: string;
    asOfDate: string; // YYYY-MM-DD
    asOfRecordedTimestamp?: Date;
}): Promise<ReconstructedPolicyState> {
    const db = await getDb();
    const policy = await db.manager.findOne(Policy, {
        where: { id: params.policyId },
    });
    if (!policy) {
        throw new Error(`POLICY_NOT_FOUND: Policy ${params.policyId} does not exist.`);
    }

    const allEvents = await db.manager.find(PolicyEvent, {
        where: { policy_id: policy.id },
        order: { sequence_number: 'ASC' },
    });

    // Filter events that were effective on or before `asOfDate`
    // (and if `asOfRecordedTimestamp` is provided, recorded on or before that system timestamp)
    const visibleEvents = allEvents.filter((evt) => {
        const effectiveOk = evt.effective_date <= params.asOfDate;
        const recordedOk = params.asOfRecordedTimestamp
            ? new Date(evt.recorded_at).getTime() <= params.asOfRecordedTimestamp.getTime()
            : true;
        return effectiveOk && recordedOk;
    });

    if (visibleEvents.length === 0) {
        throw new Error(
            `POLICY_NOT_EFFECTIVE_YET: Policy ${policy.policy_number} had no active events as of ${params.asOfDate} (Term starts ${policy.effective_start_date}).`
        );
    }

    // Determine which events were reversed among the visible events
    const reversedEventIds = new Set(
        visibleEvents
            .filter((e) => e.event_type === 'ENDORSEMENT_REVERSAL' && e.reverses_event_id)
            .map((e) => e.reverses_event_id as string)
    );

    // Active non-reversed events determine the current coverage snapshot as of `asOfDate`
    const nonReversedEvents = visibleEvents.filter(
        (e) =>
            e.event_type !== 'ENDORSEMENT_REVERSAL' && !reversedEventIds.has(e.id)
    );
    const latestActiveEvent =
        nonReversedEvents[nonReversedEvents.length - 1] ?? visibleEvents[0];

    const cancelEvent = visibleEvents.find((e) => e.event_type === 'POLICY_CANCELLED');
    const statusAsOfDate: Policy['status'] = cancelEvent
        ? policy.cancellation_type === 'SHORT_RATE'
            ? 'CANCELLED_SHORT_RATE'
            : 'CANCELLED_PRO_RATA'
        : params.asOfDate > policy.effective_end_date
            ? 'EXPIRED'
            : 'BOUND_ACTIVE';

    const slices: PolicyFinancialSlice[] = visibleEvents.map((e) => ({
        eventId: e.id,
        eventType: e.event_type as PolicyFinancialSlice['eventType'],
        effectiveDate: e.effective_date,
        recordedAt: e.recorded_at,
        activeDaysInTerm: e.active_days_in_term,
        proratedBasePremiumDeltaCents: e.prorated_premium_delta_cents,
        stateTaxDeltaCents: e.state_tax_delta_cents,
        stampingFeeDeltaCents: e.stamping_fee_delta_cents,
        feeOrPenaltyDeltaCents: e.fee_or_penalty_delta_cents,
        reversesEventId: e.reverses_event_id,
    }));

    const earnedPosition = calculateAsOfEarnedPosition({
        policyStartDate: policy.effective_start_date,
        policyEndDate: policy.effective_end_date,
        asOfDate: params.asOfDate,
        slices,
    });

    const allLedgerTxs = await db.manager.find(LedgerTransaction, {
        where: { policy_id: policy.id },
        relations: { entries: true },
        order: { effective_date: 'ASC', recorded_at: 'ASC' },
    });

    const ledgerTransactionsAsOfDate = allLedgerTxs.filter((tx) => {
        const effOk = tx.effective_date <= params.asOfDate;
        const recOk = params.asOfRecordedTimestamp
            ? new Date(tx.recorded_at).getTime() <= params.asOfRecordedTimestamp.getTime()
            : true;
        return effOk && recOk;
    });

    return {
        policyId: policy.id,
        policyNumber: policy.policy_number,
        insuredName: policy.insured_name,
        riskState: policy.risk_state,
        asOfDate: params.asOfDate,
        effectiveStartDate: policy.effective_start_date,
        effectiveEndDate: policy.effective_end_date,
        termDays: policy.term_days,
        statusAsOfDate,
        coverageSnapshotAsOfDate: latestActiveEvent.coverage_snapshot,
        earnedPosition,
        activeEventsAsOfDate: visibleEvents,
        ledgerTransactionsAsOfDate,
    };
}

// ============================================================================
// 7. CLAIMS INTAKE, APPEND-ONLY RESERVES & MAKER-CHECKER PAYOUTS (GAUNTLET #6)
// ============================================================================

export interface CreateClaimWithReserveInput {
    idempotencyKey: string;
    policyId: string;
    dateOfLoss: string; // YYYY-MM-DD
    claimantName: string;
    lossDescription: string;
    initialReserveCents: number;
    plaidVerificationId?: string | null;
    claimantBankRouting?: string | null;
    claimantBankAccountMask?: string | null;
    claimantUsdcWalletAddress?: string | null;
    createdBy?: string;
}

/**
 * Opens a Claim against a Policy, verifying that `dateOfLoss` falls within the active policy term
 * and that `initialReserveCents <= policy.coverage_limit_cents`.
 * Posts an immutable `ClaimReserveEvent` and double-entry reserve accrual (`CLAIMS_INCURRED_EXPENSE` -> `CLAIM_LOSS_RESERVE`).
 */
export async function openClaimWithInitialReserve(
    input: CreateClaimWithReserveInput
): Promise<{
    claim: Claim;
    reserveEvent: ClaimReserveEvent;
    ledgerTx: LedgerTransaction;
}> {
    return withTransaction(async (manager) => {
        const policy = await manager.findOne(Policy, {
            where: { id: input.policyId },
            lock: { mode: 'pessimistic_write' },
        });
        if (!policy) {
            throw new Error(`POLICY_NOT_FOUND: Policy ${input.policyId} does not exist.`);
        }

        if (
            input.dateOfLoss < policy.effective_start_date ||
            input.dateOfLoss > policy.effective_end_date
        ) {
            throw new Error(
                `LOSS_OUTSIDE_POLICY_TERM: Date of loss (${input.dateOfLoss}) is outside policy term [${policy.effective_start_date}, ${policy.effective_end_date}].`
            );
        }

        if (
            policy.cancelled_effective_date &&
            input.dateOfLoss > policy.cancelled_effective_date
        ) {
            throw new Error(
                `LOSS_AFTER_CANCELLATION: Policy ${policy.policy_number} was cancelled effective ${policy.cancelled_effective_date}, prior to date of loss (${input.dateOfLoss}).`
            );
        }

        // Validate Incurred = Paid + Reserve <= Policy Coverage Limit
        const summary = validateAndComputeClaimAdjustment({
            policyCoverageLimitCents: policy.coverage_limit_cents,
            existingReserveCents: 0,
            existingPaidCents: 0,
            proposedReserveDeltaCents: input.initialReserveCents,
            proposedPaidDeltaCents: 0,
        });

        const countRes = await manager.query(`SELECT count(*) FROM claims;`);
        const nextClaimNum = parseInt(countRes[0].count, 10) + 1;
        const claimNumber = `CLM-${input.dateOfLoss.slice(0, 4)}-${String(
            nextClaimNum
        ).padStart(4, '0')}`;

        const claim = manager.create(Claim, {
            claim_number: claimNumber,
            policy_id: policy.id,
            date_of_loss: input.dateOfLoss,
            claimant_name: input.claimantName,
            loss_description: input.lossDescription,
            status: 'OPEN',
            current_reserve_cents: summary.currentReserveCents,
            total_paid_cents: 0,
            total_incurred_cents: summary.totalIncurredCents,
            claimant_account_verified: Boolean(
                input.plaidVerificationId || input.claimantUsdcWalletAddress
            ),
            plaid_verification_id: input.plaidVerificationId ?? null,
            claimant_bank_routing: input.claimantBankRouting ?? '011000015',
            claimant_bank_account_mask: input.claimantBankAccountMask ?? '1111',
            claimant_usdc_wallet_address: input.claimantUsdcWalletAddress ?? null,
        });

        const savedClaim = await manager.save(Claim, claim);

        const ledgerTx = await postBalancedJournalTransaction(manager, {
            idempotencyKey: `clm_init_${input.idempotencyKey}`,
            eventCategory: 'CLAIM_RESERVE',
            description: `Initial loss reserve posted for ${savedClaim.claim_number} on ${policy.policy_number}`,
            effectiveDate: input.dateOfLoss,
            policyId: policy.id,
            brokerId: policy.broker_id,
            claimId: savedClaim.id,
            createdBy: input.createdBy ?? 'SYSTEM',
            lines: [
                {
                    accountCode: LedgerAccount.CLAIMS_INCURRED_EXPENSE,
                    direction: 'DEBIT',
                    amountCents: input.initialReserveCents,
                },
                {
                    accountCode: LedgerAccount.CLAIM_LOSS_RESERVE,
                    direction: 'CREDIT',
                    amountCents: input.initialReserveCents,
                },
            ],
        });

        const reserveEvent = manager.create(ClaimReserveEvent, {
            claim_id: savedClaim.id,
            event_type: 'RESERVE_INITIAL',
            reserve_delta_cents: input.initialReserveCents,
            paid_delta_cents: 0,
            notes: `Initial claim reserve established: ${input.lossDescription}`,
            ledger_transaction_id: ledgerTx.id,
            created_by: input.createdBy ?? 'SYSTEM',
        });

        const savedReserveEvent = await manager.save(ClaimReserveEvent, reserveEvent);

        return {
            claim: savedClaim,
            reserveEvent: savedReserveEvent,
            ledgerTx,
        };
    });
}

/**
 * Adjusts an open claim's reserve up or down (append-only `ClaimReserveEvent`),
 * enforcing `Incurred = Paid + Reserve <= Policy Limit`.
 */
export async function adjustClaimReserve(params: {
    idempotencyKey: string;
    claimId: string;
    reserveDeltaCents: number; // Positive to increase reserve, negative to reduce reserve
    effectiveDate: string;
    notes: string;
    createdBy?: string;
}): Promise<{
    claim: Claim;
    reserveEvent: ClaimReserveEvent;
    ledgerTx: LedgerTransaction;
}> {
    return withTransaction(async (manager) => {
        const claim = await manager.findOne(Claim, {
            where: { id: params.claimId },
            lock: { mode: 'pessimistic_write' },
        });
        if (!claim) {
            throw new Error(`CLAIM_NOT_FOUND: Claim ${params.claimId} does not exist.`);
        }

        const policy = await manager.findOneOrFail(Policy, {
            where: { id: claim.policy_id },
        });

        const summary = validateAndComputeClaimAdjustment({
            policyCoverageLimitCents: policy.coverage_limit_cents,
            existingReserveCents: claim.current_reserve_cents,
            existingPaidCents: claim.total_paid_cents,
            proposedReserveDeltaCents: params.reserveDeltaCents,
            proposedPaidDeltaCents: 0,
        });

        const absDelta = Math.abs(params.reserveDeltaCents);
        const isIncrease = params.reserveDeltaCents >= 0;

        const ledgerTx = await postBalancedJournalTransaction(manager, {
            idempotencyKey: `clm_adj_${params.idempotencyKey}`,
            eventCategory: 'CLAIM_RESERVE',
            description: `Reserve ${isIncrease ? 'increase' : 'release'} on ${claim.claim_number
                }: ${params.notes}`,
            effectiveDate: params.effectiveDate,
            policyId: policy.id,
            brokerId: policy.broker_id,
            claimId: claim.id,
            createdBy: params.createdBy ?? 'SYSTEM',
            lines: isIncrease
                ? [
                    {
                        accountCode: LedgerAccount.CLAIMS_INCURRED_EXPENSE,
                        direction: 'DEBIT',
                        amountCents: absDelta,
                    },
                    {
                        accountCode: LedgerAccount.CLAIM_LOSS_RESERVE,
                        direction: 'CREDIT',
                        amountCents: absDelta,
                    },
                ]
                : [
                    {
                        accountCode: LedgerAccount.CLAIM_LOSS_RESERVE,
                        direction: 'DEBIT',
                        amountCents: absDelta,
                    },
                    {
                        accountCode: LedgerAccount.CLAIMS_INCURRED_EXPENSE,
                        direction: 'CREDIT',
                        amountCents: absDelta,
                    },
                ],
        });

        const reserveEvent = manager.create(ClaimReserveEvent, {
            claim_id: claim.id,
            event_type: 'RESERVE_ADJUSTMENT',
            reserve_delta_cents: params.reserveDeltaCents,
            paid_delta_cents: 0,
            notes: params.notes,
            ledger_transaction_id: ledgerTx.id,
            created_by: params.createdBy ?? 'SYSTEM',
        });

        const savedEvent = await manager.save(ClaimReserveEvent, reserveEvent);

        claim.current_reserve_cents = summary.currentReserveCents;
        claim.total_incurred_cents = summary.totalIncurredCents;
        const updatedClaim = await manager.save(Claim, claim);

        return {
            claim: updatedClaim,
            reserveEvent: savedEvent,
            ledgerTx,
        };
    });
}

/**
 * Initiates or executes a Claim Payout.
 *  - All claim payouts require Maker-Checker approval (`initiated_by_user !== reviewed_by_user`).
 *  - When approved and settled, the payout draws the reserve down (`reserve_delta = -payoutCents`,
 *    `paid_delta = +payoutCents`), debiting `CLAIM_LOSS_RESERVE` and crediting `OPERATING_CASH_SETTLED`.
 */
export async function initiateOrExecuteClaimPayout(params: {
    idempotencyKey: string;
    claimId: string;
    payoutAmountCents: number;
    effectiveDate: string;
    payoutRail: 'ACH_DELAYED' | 'USDC_BASE_SEPOLIA';
    notes: string;
    initiatedByUser: string;
    initiatedByRole: 'MAKER_OPS' | 'BROKER' | 'MCP_AGENT';
    /** Supplied only when Checker approves from the Approval Queue */
    approvedRequestId?: string;
    externalPayoutId?: string;
}): Promise<{
    status: 'QUEUED_FOR_CHECKER_APPROVAL' | 'PAYOUT_SETTLED';
    claim: Claim;
    approvalRequest?: ApprovalRequest;
    payoutEvent?: ClaimReserveEvent;
    ledgerTx?: LedgerTransaction;
}> {
    return withTransaction(async (manager) => {
        const claim = await manager.findOne(Claim, {
            where: { id: params.claimId },
            lock: { mode: 'pessimistic_write' },
        });
        if (!claim) {
            throw new Error(`CLAIM_NOT_FOUND: Claim ${params.claimId} does not exist.`);
        }

        const policy = await manager.findOneOrFail(Policy, {
            where: { id: claim.policy_id },
        });

        // Verify Incurred = Paid + Reserve <= Policy Limit when drawing down reserve by payoutAmountCents
        const summary = validateAndComputeClaimAdjustment({
            policyCoverageLimitCents: policy.coverage_limit_cents,
            existingReserveCents: claim.current_reserve_cents,
            existingPaidCents: claim.total_paid_cents,
            proposedReserveDeltaCents: -params.payoutAmountCents,
            proposedPaidDeltaCents: params.payoutAmountCents,
        });

        // If not yet approved by a second human Checker role, queue in ApprovalRequest!
        if (!params.approvedRequestId) {
            const approval = manager.create(ApprovalRequest, {
                action_type: 'CLAIM_PAYOUT',
                status: 'PENDING',
                policy_id: policy.id,
                claim_id: claim.id,
                amount_cents: params.payoutAmountCents,
                summary: `Claim Payout of $${(params.payoutAmountCents / 100).toFixed(2)} for ${claim.claim_number
                    } (${claim.claimant_name}) via ${params.payoutRail}`,
                execution_payload: params,
                initiated_by_user: params.initiatedByUser,
                initiated_by_role: params.initiatedByRole,
                is_agent_initiated: params.initiatedByRole === 'MCP_AGENT',
            });
            const savedApproval = await manager.save(ApprovalRequest, approval);

            claim.status = 'PENDING_APPROVAL';
            const updatedClaim = await manager.save(Claim, claim);

            return {
                status: 'QUEUED_FOR_CHECKER_APPROVAL',
                claim: updatedClaim,
                approvalRequest: savedApproval,
            };
        }

        // Approved by Checker -> Execute settlement & reserve draw-down
        const externalRef =
            params.externalPayoutId ?? `payout_${claim.claim_number}_${Date.now()}`;

        const ledgerTx = await postBalancedJournalTransaction(manager, {
            idempotencyKey: `clm_pay_${params.idempotencyKey}`,
            eventCategory: 'CLAIM_PAYOUT',
            description: `Settled claim payout for ${claim.claim_number} via ${params.payoutRail}: ${params.notes}`,
            effectiveDate: params.effectiveDate,
            policyId: policy.id,
            brokerId: policy.broker_id,
            claimId: claim.id,
            externalReferenceId: externalRef,
            createdBy: params.initiatedByUser,
            lines: [
                {
                    accountCode: LedgerAccount.CLAIM_LOSS_RESERVE,
                    direction: 'DEBIT',
                    amountCents: params.payoutAmountCents,
                },
                {
                    accountCode: LedgerAccount.OPERATING_CASH_SETTLED,
                    direction: 'CREDIT',
                    amountCents: params.payoutAmountCents,
                },
            ],
        });

        const payoutEvent = manager.create(ClaimReserveEvent, {
            claim_id: claim.id,
            event_type: 'PAYOUT_SETTLED',
            reserve_delta_cents: -params.payoutAmountCents, // Draws reserve down!
            paid_delta_cents: params.payoutAmountCents,
            notes: params.notes,
            payout_rail: params.payoutRail,
            external_payout_id: externalRef,
            ledger_transaction_id: ledgerTx.id,
            approval_request_id: params.approvedRequestId,
            created_by: params.initiatedByUser,
        });

        const savedEvent = await manager.save(ClaimReserveEvent, payoutEvent);

        claim.current_reserve_cents = summary.currentReserveCents;
        claim.total_paid_cents = summary.totalPaidCents;
        claim.total_incurred_cents = summary.totalIncurredCents;
        claim.status =
            summary.currentReserveCents === 0 ? 'CLOSED_PAID' : 'PAID_PARTIAL';

        const updatedClaim = await manager.save(Claim, claim);

        return {
            status: 'PAYOUT_SETTLED',
            claim: updatedClaim,
            payoutEvent: savedEvent,
            ledgerTx,
        };
    });
}

/**
 * Handles an asynchronous Claim Payout Return / ACH Bounce (e.g., R01 Insufficient Funds, R03 No Account).
 * Appends a compensating `PAYOUT_RETURNED` event that restores the Claim Loss Reserve and debits Cash back.
 */
export async function recordClaimPayoutReturn(params: {
    idempotencyKey: string;
    claimId: string;
    returnedAmountCents: number;
    returnCode: string; // e.g., 'R01_INSUFFICIENT_FUNDS' | 'R03_NO_ACCOUNT'
    effectiveDate: string;
    externalPayoutId: string;
}): Promise<{
    claim: Claim;
    returnEvent: ClaimReserveEvent;
    ledgerTx: LedgerTransaction;
}> {
    return withTransaction(async (manager) => {
        const claim = await manager.findOne(Claim, {
            where: { id: params.claimId },
            lock: { mode: 'pessimistic_write' },
        });
        if (!claim) {
            throw new Error(`CLAIM_NOT_FOUND: Claim ${params.claimId} does not exist.`);
        }

        const policy = await manager.findOneOrFail(Policy, {
            where: { id: claim.policy_id },
        });

        // Returning a payout restores the reserve (+returnedAmountCents) and reduces paid (-returnedAmountCents)
        const summary = validateAndComputeClaimAdjustment({
            policyCoverageLimitCents: policy.coverage_limit_cents,
            existingReserveCents: claim.current_reserve_cents,
            existingPaidCents: claim.total_paid_cents,
            proposedReserveDeltaCents: params.returnedAmountCents,
            proposedPaidDeltaCents: -params.returnedAmountCents,
        });

        const ledgerTx = await postBalancedJournalTransaction(manager, {
            idempotencyKey: `clm_ret_${params.idempotencyKey}`,
            eventCategory: 'CLAIM_RETURN',
            description: `Payout return (${params.returnCode}) on ${claim.claim_number} — reserve restored`,
            effectiveDate: params.effectiveDate,
            policyId: policy.id,
            brokerId: policy.broker_id,
            claimId: claim.id,
            externalReferenceId: params.externalPayoutId,
            createdBy: 'WEBHOOK_CONSUMER',
            lines: [
                {
                    accountCode: LedgerAccount.OPERATING_CASH_SETTLED,
                    direction: 'DEBIT',
                    amountCents: params.returnedAmountCents,
                },
                {
                    accountCode: LedgerAccount.CLAIM_LOSS_RESERVE,
                    direction: 'CREDIT',
                    amountCents: params.returnedAmountCents,
                },
            ],
        });

        const returnEvent = manager.create(ClaimReserveEvent, {
            claim_id: claim.id,
            event_type: 'PAYOUT_RETURNED',
            reserve_delta_cents: params.returnedAmountCents,
            paid_delta_cents: -params.returnedAmountCents,
            notes: `Asynchronous rail return (${params.returnCode}) for transfer ${params.externalPayoutId}. Reserve automatically restored.`,
            return_code: params.returnCode,
            external_payout_id: params.externalPayoutId,
            ledger_transaction_id: ledgerTx.id,
            created_by: 'WEBHOOK_CONSUMER',
        });

        const savedEvent = await manager.save(ClaimReserveEvent, returnEvent);

        claim.current_reserve_cents = summary.currentReserveCents;
        claim.total_paid_cents = summary.totalPaidCents;
        claim.total_incurred_cents = summary.totalIncurredCents;
        claim.status = 'OPEN';

        const updatedClaim = await manager.save(Claim, claim);

        return {
            claim: updatedClaim,
            returnEvent: savedEvent,
            ledgerTx,
        };
    });
}

// ============================================================================
// 8. MAKER-CHECKER APPROVAL EXECUTION (NON-NEGOTIABLE #6 & #8)
// ============================================================================

/**
 * Approves or rejects a pending `ApprovalRequest`.
 * Enforces:
 *  1. `reviewedByUser !== request.initiated_by_user` (Initiator can NEVER approve their own action).
 *  2. `reviewedByRole === 'CHECKER_LEAD'` (Autonomous MCP agents or Makers cannot approve).
 */
export async function reviewApprovalRequest(params: {
    approvalRequestId: string;
    decision: 'APPROVED' | 'REJECTED';
    reviewedByUser: string;
    reviewedByRole: 'CHECKER_LEAD' | 'MAKER_OPS' | 'MCP_AGENT';
    reviewNotes?: string;
}): Promise<{
    approvalRequest: ApprovalRequest;
    executionResult?: unknown;
}> {
    const db = await getDb();
    const request = await db.manager.findOne(ApprovalRequest, {
        where: { id: params.approvalRequestId },
    });

    if (!request) {
        throw new Error(`APPROVAL_NOT_FOUND: Request ${params.approvalRequestId} not found.`);
    }
    if (request.status !== 'PENDING') {
        throw new Error(
            `APPROVAL_ALREADY_FINALIZED: Request ${request.id} is already "${request.status}".`
        );
    }

    // Maker-Checker Rule #1: Only CHECKER_LEAD human role can approve/reject
    if (params.reviewedByRole !== 'CHECKER_LEAD') {
        throw new Error(
            `MAKER_CHECKER_ROLE_VIOLATION: Role "${params.reviewedByRole}" is not authorized to review approval requests. Requires CHECKER_LEAD.`
        );
    }

    // Maker-Checker Rule #2: Initiator can NEVER approve their own transaction
    if (
        params.reviewedByUser.trim().toLowerCase() ===
        request.initiated_by_user.trim().toLowerCase()
    ) {
        throw new Error(
            `MAKER_CHECKER_SELF_APPROVAL_FORBIDDEN: Initiator (${request.initiated_by_user}) cannot approve or reject their own request.`
        );
    }

    request.status = params.decision;
    request.reviewed_by_user = params.reviewedByUser;
    request.reviewed_by_role = params.reviewedByRole;
    request.review_notes = params.reviewNotes ?? null;
    request.reviewed_at = new Date();

    const savedRequest = await db.manager.save(ApprovalRequest, request);

    if (params.decision === 'REJECTED') {
        return { approvalRequest: savedRequest };
    }

    // Execute the deferred payload now that Checker has signed off
    let executionResult: unknown = null;
    if (request.action_type === 'CLAIM_PAYOUT') {
        const payload = request.execution_payload as Parameters<
            typeof initiateOrExecuteClaimPayout
        >[0];
        executionResult = await initiateOrExecuteClaimPayout({
            ...payload,
            approvedRequestId: savedRequest.id,
        });
    } else if (request.action_type === 'ENDORSEMENT_HIGH_DELTA') {
        const payload = request.execution_payload as unknown as ApplyEndorsementInput;
        executionResult = await applyMidTermEndorsement({
            ...payload,
            bypassMakerChecker: true,
        });
    }

    return {
        approvalRequest: savedRequest,
        executionResult,
    };
}

// ============================================================================
// 9. MONTHLY BROKER STATEMENT GENERATOR (GAUNTLET #8: IMMUTABLE CLOSED MONTHS)
// ============================================================================

/**
 * Gauntlet #8: Generates or retrieves a monthly Broker Commission Statement (`YYYY-MM`).
 *  - Ties directly to `LedgerEntry` rows for the broker to the exact cent.
 *  - Once closed (`closeMonth: true`), the statement snapshot is saved in `broker_statements`
 *    with `is_closed = true`. Re-running a closed month returns the locked snapshot forever!
 */
export async function generateOrGetBrokerStatement(params: {
    brokerId: string;
    statementMonth: string; // 'YYYY-MM', e.g., '2026-10'
    closeMonth?: boolean;
}): Promise<BrokerStatement> {
    return withTransaction(async (manager) => {
        // 1. If the month is already closed for this broker, return the immutable stored document forever!
        const existingClosed = await manager.findOne(BrokerStatement, {
            where: {
                broker_id: params.brokerId,
                statement_month: params.statementMonth,
                is_closed: true,
            },
        });
        if (existingClosed) {
            return existingClosed;
        }

        const broker = await manager.findOneOrFail(Broker, {
            where: { id: params.brokerId },
        });

        // 2. Query all LedgerTransactions for this broker whose effective_date falls in `YYYY-MM`
        const startOfMonth = `${params.statementMonth}-01`;
        const endOfMonth = `${params.statementMonth}-31`;

        const allBrokerTxs = await manager.find(LedgerTransaction, {
            where: { broker_id: broker.id },
            relations: { entries: true },
            order: { effective_date: 'ASC', recorded_at: 'ASC' },
        });

        const monthTxs = allBrokerTxs.filter(
            (tx) => tx.effective_date >= startOfMonth && tx.effective_date <= endOfMonth
        );

        const policies = await manager.find(Policy, {
            where: { broker_id: broker.id },
        });
        const policyMap = new Map(policies.map((p) => [p.id, p.policy_number]));

        let grossPremiumCollectedCents = 0;
        let premiumRefundedCents = 0;
        let commissionEarnedCents = 0;
        let commissionClawedBackCents = 0;

        const lineItemsSnapshot: BrokerStatement['line_items_snapshot'] = [];

        for (const tx of monthTxs) {
            const policyNumber = tx.policy_id
                ? policyMap.get(tx.policy_id) ?? 'UNKNOWN'
                : 'N/A';

            let txPremiumDelta = 0;
            let txCommissionDelta = 0;

            for (const entry of tx.entries) {
                if (entry.account_code === LedgerAccount.UNEARNED_PREMIUM_RESERVE) {
                    if (entry.direction === 'CREDIT') {
                        grossPremiumCollectedCents += entry.amount_cents;
                        txPremiumDelta += entry.amount_cents;
                    } else if (
                        tx.event_category !== 'EARNED_PREMIUM_RECOGNITION' &&
                        entry.direction === 'DEBIT'
                    ) {
                        premiumRefundedCents += entry.amount_cents;
                        txPremiumDelta -= entry.amount_cents;
                    }
                }

                if (entry.account_code === LedgerAccount.BROKER_COMMISSION_PAYABLE) {
                    if (entry.direction === 'CREDIT') {
                        commissionEarnedCents += entry.amount_cents;
                        txCommissionDelta += entry.amount_cents;
                    } else {
                        commissionClawedBackCents += entry.amount_cents;
                        txCommissionDelta -= entry.amount_cents;
                    }
                }
            }

            if (txPremiumDelta !== 0 || txCommissionDelta !== 0) {
                lineItemsSnapshot.push({
                    policy_number: policyNumber,
                    event_type: tx.event_category,
                    effective_date: tx.effective_date,
                    premium_delta_cents: txPremiumDelta,
                    commission_delta_cents: txCommissionDelta,
                    ledger_transaction_id: tx.id,
                });
            }
        }

        const netPayoutDueCents = commissionEarnedCents - commissionClawedBackCents;

        const statement = manager.create(BrokerStatement, {
            broker_id: broker.id,
            statement_month: params.statementMonth,
            gross_premium_collected_cents: grossPremiumCollectedCents,
            premium_refunded_cents: premiumRefundedCents,
            commission_earned_cents: commissionEarnedCents,
            commission_clawed_back_cents: commissionClawedBackCents,
            net_payout_due_cents: netPayoutDueCents,
            line_items_snapshot: lineItemsSnapshot,
            is_closed: Boolean(params.closeMonth),
        });

        if (params.closeMonth) {
            return manager.save(BrokerStatement, statement);
        }

        return statement;
    });
}