import 'reflect-metadata';
import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToMany,
    JoinColumn,
    Index,
} from 'typeorm';

// ============================================================================
// SHARED DOMAIN ENUMS & LEDGER CHART OF ACCOUNTS
// ============================================================================

/**
 * Standard Double-Entry Chart of Accounts for US Commercial Insurance Carrier.
 * Every LedgerEntry.account_code uses one of these deterministic accounts.
 */
export enum LedgerAccount {
    // ASSET ACCOUNTS (Normal Balance: DEBIT)
    OPERATING_CASH_SETTLED = 'ASSET:OPERATING_CASH_SETTLED', // Real settled cash in Stripe/Bank
    ACH_PENDING_RECEIVABLE = 'ASSET:ACH_PENDING_RECEIVABLE', // In-flight premium collection
    CLAIM_PAYOUT_IN_TRANSIT = 'ASSET:CLAIM_PAYOUT_IN_TRANSIT', // Delayed payout rail in-flight
    COMMISSION_CLAWBACK_RECEIVABLE = 'ASSET:COMMISSION_CLAWBACK_RECEIVABLE', // Owed back by broker on refund

    // LIABILITY ACCOUNTS (Normal Balance: CREDIT)
    UNEARNED_PREMIUM_RESERVE = 'LIABILITY:UNEARNED_PREMIUM_RESERVE', // Unearned portion owed back if cancelled
    STATE_TAX_PAYABLE = 'LIABILITY:STATE_TAX_PAYABLE', // State surplus lines / premium tax collected
    STATUTORY_FEE_PAYABLE = 'LIABILITY:STATUTORY_FEE_PAYABLE', // Stamping / filing fees collected
    BROKER_COMMISSION_PAYABLE = 'LIABILITY:BROKER_COMMISSION_PAYABLE', // Owed to broker on statement
    CLAIM_LOSS_RESERVE = 'LIABILITY:CLAIM_LOSS_RESERVE', // Outstanding reserve for open claims
    REFUND_PAYABLE_CLEARING = 'LIABILITY:REFUND_PAYABLE_CLEARING', // Pending Stripe refund clearing

    // REVENUE ACCOUNTS (Normal Balance: CREDIT)
    EARNED_PREMIUM_REVENUE = 'REVENUE:EARNED_PREMIUM_REVENUE', // Recognized daily pro-rata premium
    POLICY_FEE_REVENUE = 'REVENUE:POLICY_FEE_REVENUE', // Fully earned carrier policy fees
    SHORT_RATE_PENALTY_REVENUE = 'REVENUE:SHORT_RATE_PENALTY_REVENUE', // Penalty retained on insured short-rate cancel

    // EXPENSE ACCOUNTS (Normal Balance: DEBIT)
    BROKER_COMMISSION_EXPENSE = 'EXPENSE:BROKER_COMMISSION_EXPENSE', // Commission cost
    CLAIMS_INCURRED_EXPENSE = 'EXPENSE:CLAIMS_INCURRED_EXPENSE', // Loss expense when reserves/payouts book
    ROUNDING_VARIANCE_EXPENSE = 'EXPENSE:ROUNDING_VARIANCE_EXPENSE', // Deterministic penny absorption account
}

export type EntryDirection = 'DEBIT' | 'CREDIT';

export type KybStatus = 'PENDING' | 'APPROVED' | 'REVIEW_REQUIRED' | 'FAILED';

export type PolicyStatus =
    | 'QUOTED'
    | 'BOUND_ACTIVE'
    | 'PAYMENT_DELINQUENT'
    | 'CANCELLED_PRO_RATA'
    | 'CANCELLED_SHORT_RATE'
    | 'EXPIRED';

export type PolicyEventType =
    | 'POLICY_ISSUED'
    | 'ENDORSEMENT_APPLIED'
    | 'ENDORSEMENT_REVERSAL' // Compensating entry for "The Correction Test"
    | 'ENDORSEMENT_REBOOK'   // Replacement entry at corrected effective_date
    | 'POLICY_CANCELLED'
    | 'POLICY_REINSTATED';

export type CancellationType = 'PRO_RATA' | 'SHORT_RATE';

export type ClaimStatus =
    | 'OPEN'
    | 'PENDING_APPROVAL'
    | 'PAYOUT_IN_FLIGHT'
    | 'PAID_PARTIAL'
    | 'CLOSED_PAID'
    | 'CLOSED_NO_PAY';

export type ClaimEventType =
    | 'RESERVE_INITIAL'
    | 'RESERVE_ADJUSTMENT'
    | 'PAYOUT_INITIATED'
    | 'PAYOUT_SETTLED'
    | 'PAYOUT_RETURNED'; // e.g., ACH R01 / R03 bounce restores reserve!

export type ApprovalActionType =
    | 'ENDORSEMENT_HIGH_DELTA'
    | 'CLAIM_PAYOUT'
    | 'CANCELLATION_REFUND'
    | 'MCP_AGENT_WRITE';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

// ============================================================================
// 1. DOUBLE-ENTRY IMMUTABLE LEDGER (ZERO UPDATE / ZERO DELETE)
// ============================================================================

/**
 * IMMUTABLE LEDGER TRANSACTION HEADER
 * Protected by PostgreSQL trigger: UPDATE and DELETE are strictly forbidden.
 * Every external money event, daily earning recognition, endorsement, or correction
 * creates one LedgerTransaction with >= 2 balanced LedgerEntries (Sum DEBIT == Sum CREDIT).
 */
@Entity('ledger_transactions')
export class LedgerTransaction {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    /**
     * Ensures idempotency ("twice is one").
     * e.g., "stripe_evt_123", "issue_pol_abc", "reverse_end_xyz"
     */
    @Index({ unique: true })
    @Column({ type: 'varchar', length: 255, unique: true })
    idempotency_key!: string;

    @Column({ type: 'varchar', length: 100 })
    event_category!:
        | 'ISSUANCE'
        | 'PREMIUM_COLLECTION'
        | 'ENDORSEMENT'
        | 'CORRECTION_REVERSAL'
        | 'CORRECTION_REBOOK'
        | 'CANCELLATION_REFUND'
        | 'COMMISSION_ACCRUAL'
        | 'COMMISSION_CLAWBACK'
        | 'CLAIM_RESERVE'
        | 'CLAIM_PAYOUT'
        | 'CLAIM_RETURN'
        | 'EARNED_PREMIUM_RECOGNITION';

    @Column({ type: 'text' })
    description!: string;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    policy_id!: string | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    broker_id!: string | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    claim_id!: string | null;

    @Column({ type: 'uuid', nullable: true })
    policy_event_id!: string | null;

    /**
     * External provider reference (e.g., Stripe PaymentIntent ID `pi_...`, Refund ID `re_...`,
     * Payout Transfer ID, or Base Sepolia USDC Tx Hash `0x...`) used by Reconciliation Engine.
     */
    @Index()
    @Column({ type: 'varchar', length: 255, nullable: true })
    external_reference_id!: string | null;

    /**
     * If this transaction is a compensating reversal (The Correction Test or ACH Return),
     * points to the original LedgerTransaction ID it reverses.
     */
    @Column({ type: 'uuid', nullable: true })
    reverses_transaction_id!: string | null;

    /**
     * BI-TEMPORAL TIMESTAMP 1: The legal/financial effective date of the event (UTC YYYY-MM-DD).
     * Used for "As-Of Date" queries and backdated endorsement proration.
     */
    @Index()
    @Column({ type: 'date' })
    effective_date!: string;

    /**
     * BI-TEMPORAL TIMESTAMP 2: Exact wall-clock timestamp when this row was written to Postgres.
     * Never modified.
     */
    @Index()
    @CreateDateColumn({ type: 'timestamptz' })
    recorded_at!: Date;

    @Column({ type: 'varchar', length: 120, default: 'SYSTEM' })
    created_by!: string;

    @OneToMany(() => LedgerEntry, (entry) => entry.transaction, {
        cascade: ['insert'],
        eager: true,
    })
    entries!: LedgerEntry[];
}

/**
 * IMMUTABLE DOUBLE-ENTRY LINE ITEM
 * Protected by PostgreSQL trigger: UPDATE and DELETE are strictly forbidden.
 * Amounts are strictly positive integer cents (BIGINT).
 */
@Entity('ledger_entries')
export class LedgerEntry {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @Column({ type: 'uuid' })
    transaction_id!: string;

    @ManyToOne(() => LedgerTransaction, (tx) => tx.entries, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'transaction_id' })
    transaction!: LedgerTransaction;

    @Index()
    @Column({ type: 'varchar', length: 100 })
    account_code!: LedgerAccount;

    @Column({ type: 'varchar', length: 10 })
    direction!: EntryDirection; // 'DEBIT' | 'CREDIT'

    /**
     * Always positive integer cents (> 0).
     * Parsed automatically into safe JS number by pg.types.setTypeParser(20) in data-source.ts.
     */
    @Column({ type: 'bigint' })
    amount_cents!: number;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    policy_id!: string | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    broker_id!: string | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    claim_id!: string | null;

    /** Denormalized from header for fast indexed As-Of Date SQL aggregations */
    @Index()
    @Column({ type: 'date' })
    effective_date!: string;

    @CreateDateColumn({ type: 'timestamptz' })
    recorded_at!: Date;
}

// ============================================================================
// 2. BROKER KYB & COMMISSION ACCOUNTING
// ============================================================================

/**
 * BROKER ENTITY
 * Gated by live KYB (Stripe Identity / Persona).
 * Unverified brokers (`kyb_status !== 'APPROVED'`) can view quotes but CANNOT bind policies.
 */
@Entity('brokers')
export class Broker {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 255 })
    legal_name!: string;

    @Column({ type: 'varchar', length: 255 })
    dba_name!: string;

    @Column({ type: 'varchar', length: 20 })
    ein!: string; // US Employer Identification Number (XX-XXXXXXX)

    @Column({ type: 'varchar', length: 255 })
    contact_email!: string;

    @Column({ type: 'varchar', length: 2 })
    license_state!: string; // e.g., 'CA', 'NY', 'TX'

    /**
     * Live KYB state: 'PENDING' | 'APPROVED' | 'REVIEW_REQUIRED' | 'FAILED'
     * Both pending and failed states must be demonstrated in the UI.
     */
    @Column({ type: 'varchar', length: 30, default: 'PENDING' })
    kyb_status!: KybStatus;

    /** Live provider verification session ID (e.g., Stripe Identity `vs_...` or Persona `inq_...`) */
    @Column({ type: 'varchar', length: 255, nullable: true })
    kyb_provider_session_id!: string | null;

    @Column({ type: 'varchar', length: 50, default: 'STRIPE_IDENTITY_LIVE' })
    kyb_provider_name!: string;

    @Column({ type: 'text', nullable: true })
    kyb_failure_reason!: string | null;

    /**
     * Commission rate in basis points (bps).
     * e.g., 1250 bps = 12.50%.
     * Commission is earned on COLLECTED Base Premium (excluding taxes & fees)
     * and clawed back pro-rata when unearned premium is refunded.
     */
    @Column({ type: 'integer', default: 1250 })
    commission_rate_bps!: number;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at!: Date;
}

/**
 * IMMUTABLE MONTHLY BROKER COMMISSION STATEMENT
 * Re-running a closed month produces the exact same document forever.
 */
@Entity('broker_statements')
export class BrokerStatement {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @Column({ type: 'uuid' })
    broker_id!: string;

    /** Format: 'YYYY-MM' (e.g., '2026-10') */
    @Index()
    @Column({ type: 'varchar', length: 7 })
    statement_month!: string;

    @Column({ type: 'bigint' })
    gross_premium_collected_cents!: number;

    @Column({ type: 'bigint' })
    premium_refunded_cents!: number;

    @Column({ type: 'bigint' })
    commission_earned_cents!: number;

    @Column({ type: 'bigint' })
    commission_clawed_back_cents!: number;

    /** Net Due to Broker = commission_earned_cents - commission_clawed_back_cents */
    @Column({ type: 'bigint' })
    net_payout_due_cents!: number;

    /** Snapshot of all line items tying directly to LedgerEntry IDs */
    @Column({ type: 'jsonb' })
    line_items_snapshot!: Array<{
        policy_number: string;
        event_type: string;
        effective_date: string;
        premium_delta_cents: number;
        commission_delta_cents: number;
        ledger_transaction_id: string;
    }>;

    @Column({ type: 'boolean', default: true })
    is_closed!: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    generated_at!: Date;
}

// ============================================================================
// 3. POLICY ADMINISTRATION & APPEND-ONLY POLICY EVENTS (AS-OF RECONSTRUCTION)
// ============================================================================

/**
 * POLICY ENTITY
 * Represents the commercial insurance contract header.
 * All historical changes live in `PolicyEvent` so "Show policy as of May 3" is 100% exact.
 */
@Entity('policies')
export class Policy {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 50, unique: true })
    policy_number!: string; // e.g., "CORGI-CGL-2026-0001"

    @Index()
    @Column({ type: 'uuid' })
    broker_id!: string;

    @ManyToOne(() => Broker)
    @JoinColumn({ name: 'broker_id' })
    broker!: Broker;

    // Insured Business Info
    @Column({ type: 'varchar', length: 255 })
    insured_name!: string;

    @Column({ type: 'varchar', length: 20 })
    insured_ein!: string;

    @Column({ type: 'varchar', length: 255 })
    insured_address!: string;

    @Column({ type: 'varchar', length: 2 })
    risk_state!: string; // e.g., 'CA' (3.0% tax + 0.25% stamping fee), 'NY', 'TX'

    @Column({ type: 'varchar', length: 50, default: 'COMMERCIAL_GENERAL_LIABILITY' })
    product_line!: 'COMMERCIAL_GENERAL_LIABILITY' | 'CYBER_TECH_EO';

    /**
     * Gauntlet #2: A policy term is 1 calendar year (anniversary to anniversary),
     * e.g., '2028-03-01' to '2029-03-01' (365 or 366 days depending on leap day Feb 29).
     */
    @Column({ type: 'date' })
    effective_start_date!: string;

    @Column({ type: 'date' })
    effective_end_date!: string;

    /** Cached exact calendar days in this specific anniversary term (365 or 366) */
    @Column({ type: 'integer' })
    term_days!: number;

    @Column({ type: 'varchar', length: 40, default: 'QUOTED' })
    status!: PolicyStatus;

    // Current Active Coverage & Pricing Figures (Always equal to sum of active PolicyEvents)
    @Column({ type: 'bigint' })
    coverage_limit_cents!: number; // e.g., $1,000,000.00 = 100000000

    @Column({ type: 'bigint' })
    deductible_cents!: number; // e.g., $5,000.00 = 500000

    /**
     * Gauntlet #11: Taxes and fees are NEVER mixed into base_premium_cents.
     * Daily pro-rata earned premium math runs strictly on current_written_premium_cents.
     */
    @Column({ type: 'bigint' })
    current_written_premium_cents!: number;

    @Column({ type: 'bigint' })
    state_tax_cents!: number;

    @Column({ type: 'bigint' })
    stamping_fee_cents!: number;

    @Column({ type: 'bigint' })
    carrier_policy_fee_cents!: number; // Non-refundable flat carrier fee

    /** Total Customer Charge = premium + state_tax + stamping_fee + carrier_policy_fee */
    @Column({ type: 'bigint' })
    total_gross_charged_cents!: number;

    // Live Payment & Bank Verification References
    @Column({ type: 'varchar', length: 255, nullable: true })
    stripe_payment_intent_id!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    stripe_charge_id!: string | null;

    @Column({ type: 'varchar', length: 50, default: 'CARD' })
    payment_method_type!: 'CARD' | 'ACH_DEBIT';

    /** Verified Plaid bank account token for ACH refunds / claim payouts */
    @Column({ type: 'varchar', length: 255, nullable: true })
    verified_bank_account_id!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    verified_bank_owner_name!: string | null;

    @Column({ type: 'date', nullable: true })
    cancelled_effective_date!: string | null;

    @Column({ type: 'varchar', length: 30, nullable: true })
    cancellation_type!: CancellationType | null;

    @OneToMany(() => PolicyEvent, (evt) => evt.policy)
    events!: PolicyEvent[];

    @CreateDateColumn({ type: 'timestamptz' })
    created_at!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at!: Date;
}

/**
 * IMMUTABLE POLICY EVENT (ENDORSEMENTS, CORRECTIONS, CANCELLATIONS)
 * Protected by PostgreSQL trigger: UPDATE and DELETE are strictly forbidden.
 * Powers:
 *  - Gauntlet #3 (Endorsement pro-rata math from effective_date)
 *  - Gauntlet #4 (The Correction Test: Reversal + Re-book)
 *  - Gauntlet #9 (As-Of Reconstruction on any past date)
 */
@Entity('policy_events')
export class PolicyEvent {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @Column({ type: 'uuid' })
    policy_id!: string;

    @ManyToOne(() => Policy, (policy) => policy.events, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'policy_id' })
    policy!: Policy;

    /** Strictly sequential event number per policy (1 = Issuance, 2 = Endorsement #1, etc.) */
    @Column({ type: 'integer' })
    sequence_number!: number;

    @Column({ type: 'varchar', length: 40 })
    event_type!: PolicyEventType;

    @Column({ type: 'text' })
    description!: string; // e.g., "Raise General Liability limit to $2M and add delivery vehicle"

    /**
     * BI-TEMPORAL DATE 1: When the change takes legal effect for coverage & proration math.
     */
    @Index()
    @Column({ type: 'date' })
    effective_date!: string;

    /**
     * BI-TEMPORAL DATE 2: When Operations/Broker entered this event into the system.
     */
    @Index()
    @CreateDateColumn({ type: 'timestamptz' })
    recorded_at!: Date;

    /** Days active in term from effective_date to policy effective_end_date */
    @Column({ type: 'integer' })
    active_days_in_term!: number;

    /** Annualized full-term premium change before proration (can be negative on coverage reduction) */
    @Column({ type: 'bigint', default: 0 })
    annualized_premium_delta_cents!: number;

    /** Pro-rated base premium delta charged/refunded for remaining term days */
    @Column({ type: 'bigint' })
    prorated_premium_delta_cents!: number;

    /** State surplus lines tax delta on this event */
    @Column({ type: 'bigint', default: 0 })
    state_tax_delta_cents!: number;

    /** State stamping fee delta on this event */
    @Column({ type: 'bigint', default: 0 })
    stamping_fee_delta_cents!: number;

    /** Non-refundable policy fee or short-rate cancellation penalty delta */
    @Column({ type: 'bigint', default: 0 })
    fee_or_penalty_delta_cents!: number;

    /** Total customer charge/refund for this event (premium + tax + stamping + fee) */
    @Column({ type: 'bigint' })
    total_gross_delta_cents!: number;

    /**
     * Gauntlet #10: Deterministic rounding penny tracking.
     * Records exact sub-cent rounding residual absorbed by carrier on this proration calculation.
     */
    @Column({ type: 'integer', default: 0 })
    rounding_penny_variance_cents!: number;

    /**
     * Snapshot of policy coverage state resulting from this event
     * (enables instant PDF Declarations & Endorsement Schedule generation as of any date).
     */
    @Column({ type: 'jsonb' })
    coverage_snapshot!: {
        coverage_limit_cents: number;
        deductible_cents: number;
        insured_address: string;
        vehicles_covered: string[];
        additional_insureds: string[];
        annualized_base_premium_cents: number;
    };

    /**
     * THE CORRECTION TEST LINKS:
     * If event_type === 'ENDORSEMENT_REVERSAL' or 'ENDORSEMENT_REBOOK',
     * `reverses_event_id` points to the original erroneous PolicyEvent ID.
     * Original rows are NEVER edited.
     */
    @Index()
    @Column({ type: 'uuid', nullable: true })
    reverses_event_id!: string | null;

    @Column({ type: 'uuid', nullable: true })
    ledger_transaction_id!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    external_payment_or_refund_id!: string | null;

    @Column({ type: 'varchar', length: 120, default: 'SYSTEM' })
    created_by!: string;
}

// ============================================================================
// 4. CLAIMS INTAKE, APPEND-ONLY RESERVES & PAYOUT RAILS
// ============================================================================

/**
 * CLAIM ENTITY
 * Gauntlet #6: Incurred = Paid + Reserve <= Policy Limit.
 * Every reserve change or payment is an immutable ClaimReserveEvent.
 */
@Entity('claims')
export class Claim {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 50, unique: true })
    claim_number!: string; // e.g., "CLM-2026-0001"

    @Index()
    @Column({ type: 'uuid' })
    policy_id!: string;

    @ManyToOne(() => Policy)
    @JoinColumn({ name: 'policy_id' })
    policy!: Policy;

    /** Date the loss occurred — must fall within Policy effective_start_date..effective_end_date */
    @Column({ type: 'date' })
    date_of_loss!: string;

    @Column({ type: 'varchar', length: 255 })
    claimant_name!: string;

    @Column({ type: 'text' })
    loss_description!: string;

    @Column({ type: 'varchar', length: 30, default: 'OPEN' })
    status!: ClaimStatus;

    /** Cached current outstanding reserve (derived from sum of ClaimReserveEvents) */
    @Column({ type: 'bigint', default: 0 })
    current_reserve_cents!: number;

    /** Cached total settled payouts (derived from sum of settled ClaimReserveEvents) */
    @Column({ type: 'bigint', default: 0 })
    total_paid_cents!: number;

    /** Cached Incurred = current_reserve_cents + total_paid_cents (strictly <= policy limit) */
    @Column({ type: 'bigint', default: 0 })
    total_incurred_cents!: number;

    // Claimant Bank / Wallet Verification (Plaid Sandbox or Base Sepolia USDC Address)
    @Column({ type: 'boolean', default: false })
    claimant_account_verified!: boolean;

    @Column({ type: 'varchar', length: 255, nullable: true })
    plaid_verification_id!: string | null;

    @Column({ type: 'varchar', length: 100, nullable: true })
    claimant_bank_routing!: string | null;

    @Column({ type: 'varchar', length: 100, nullable: true })
    claimant_bank_account_mask!: string | null;

    /** Stretch Goal: Optional Base Sepolia Testnet wallet address for USDC claim payouts */
    @Column({ type: 'varchar', length: 100, nullable: true })
    claimant_usdc_wallet_address!: string | null;

    @OneToMany(() => ClaimReserveEvent, (evt) => evt.claim)
    events!: ClaimReserveEvent[];

    @CreateDateColumn({ type: 'timestamptz' })
    created_at!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at!: Date;
}

/**
 * IMMUTABLE CLAIM RESERVE & PAYOUT EVENT
 * Protected by PostgreSQL trigger: UPDATE and DELETE are strictly forbidden.
 * Every reserve adjustment and payout draw-down is an append-only event.
 */
@Entity('claim_reserve_events')
export class ClaimReserveEvent {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @Column({ type: 'uuid' })
    claim_id!: string;

    @ManyToOne(() => Claim, (claim) => claim.events, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'claim_id' })
    claim!: Claim;

    @Column({ type: 'varchar', length: 40 })
    event_type!: ClaimEventType;

    /** Change in outstanding reserve (positive for increase, negative when drawn down by payment) */
    @Column({ type: 'bigint' })
    reserve_delta_cents!: number;

    /** Positive when money is paid out; negative if an ACH return claws the payout back */
    @Column({ type: 'bigint', default: 0 })
    paid_delta_cents!: number;

    @Column({ type: 'text' })
    notes!: string;

    @Column({ type: 'varchar', length: 40, nullable: true })
    payout_rail!: 'ACH_DELAYED' | 'USDC_BASE_SEPOLIA' | null;

    /** External transfer ID or Base Sepolia tx hash (`0x...`) */
    @Column({ type: 'varchar', length: 255, nullable: true })
    external_payout_id!: string | null;

    /** If payout bounced (e.g., 'R01_INSUFFICIENT_FUNDS', 'R03_NO_ACCOUNT') */
    @Column({ type: 'varchar', length: 50, nullable: true })
    return_code!: string | null;

    @Column({ type: 'uuid', nullable: true })
    ledger_transaction_id!: string | null;

    @Column({ type: 'uuid', nullable: true })
    approval_request_id!: string | null;

    @Column({ type: 'varchar', length: 120 })
    created_by!: string;

    @CreateDateColumn({ type: 'timestamptz' })
    recorded_at!: Date;
}

// ============================================================================
// 5. MAKER-CHECKER APPROVAL QUEUE (HUMANS & MCP AGENT WRITES)
// ============================================================================

/**
 * MAKER-CHECKER APPROVAL REQUEST
 * Non-Negotiable #6 & #8:
 *  - Money-out / high-threshold actions require a second human role to approve.
 *  - Initiator (`initiated_by_user`) can NEVER equal `reviewed_by_user`.
 *  - Autonomous MCP Agent writes ALWAYS land here with `is_agent_initiated = true`
 *    and cannot be approved by an agent.
 */
@Entity('approval_requests')
export class ApprovalRequest {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 50 })
    action_type!: ApprovalActionType;

    @Column({ type: 'varchar', length: 30, default: 'PENDING' })
    status!: ApprovalStatus;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    policy_id!: string | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    claim_id!: string | null;

    /** Amount at stake in integer cents (e.g., claim payout or large endorsement/refund) */
    @Column({ type: 'bigint' })
    amount_cents!: number;

    @Column({ type: 'text' })
    summary!: string;

    /** Structured payload to execute atomically once Checker clicks "Approve" */
    @Column({ type: 'jsonb' })
    execution_payload!: Record<string, unknown>;

    @Column({ type: 'varchar', length: 120 })
    initiated_by_user!: string; // e.g., 'agent@corgi-trial.internal' or 'mcp-autonomous-agent'

    @Column({ type: 'varchar', length: 50 })
    initiated_by_role!: 'MAKER_OPS' | 'BROKER' | 'MCP_AGENT';

    @Column({ type: 'boolean', default: false })
    is_agent_initiated!: boolean;

    @Column({ type: 'varchar', length: 120, nullable: true })
    reviewed_by_user!: string | null; // Must be !== initiated_by_user and role === 'CHECKER_LEAD'

    @Column({ type: 'varchar', length: 50, nullable: true })
    reviewed_by_role!: string | null;

    @Column({ type: 'text', nullable: true })
    review_notes!: string | null;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at!: Date;

    @Column({ type: 'timestamptz', nullable: true })
    reviewed_at!: Date | null;
}

// ============================================================================
// 6. IDEMPOTENT WEBHOOK INGESTION & RECONCILIATION BREAKS
// ============================================================================

/**
 * WEBHOOK INGESTION LOG
 * Non-Negotiable #4: Signatures verified, consumers idempotent ("twice is one"),
 * out-of-order delivery tolerated.
 */
@Entity('webhook_events')
export class WebhookEvent {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    /** Provider's unique event ID (e.g., Stripe `evt_...` or Persona `evnt_...`) */
    @Index({ unique: true })
    @Column({ type: 'varchar', length: 255, unique: true })
    provider_event_id!: string;

    @Column({ type: 'varchar', length: 50 })
    provider!: 'STRIPE' | 'PERSONA' | 'PLAID' | 'PAYOUT_RAIL';

    @Column({ type: 'varchar', length: 100 })
    event_type!: string; // e.g., 'payment_intent.succeeded', 'charge.refunded'

    @Column({ type: 'boolean', default: true })
    signature_verified!: boolean;

    @Column({ type: 'varchar', length: 40, default: 'PROCESSED' })
    processing_status!: 'PROCESSED' | 'IGNORED_OUT_OF_ORDER' | 'DUPLICATE_REPLAY' | 'FAILED';

    /** Count of how many times this exact event ID was replayed during Live-Fire */
    @Column({ type: 'integer', default: 1 })
    delivery_attempts!: number;

    @Column({ type: 'jsonb' })
    raw_payload!: Record<string, unknown>;

    @Column({ type: 'timestamptz' })
    provider_occurred_at!: Date;

    @CreateDateColumn({ type: 'timestamptz' })
    first_received_at!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    last_seen_at!: Date;
}

/**
 * RECONCILIATION BREAK / EXCEPTION RECORD
 * Non-Negotiable #7: A job that pulls provider truth (API or file) and diffs it
 * against your ledger, plus a screen that shows the breaks.
 */
@Entity('reconciliation_breaks')
export class ReconciliationBreak {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @Column({ type: 'varchar', length: 100 })
    reconciliation_run_id!: string;

    @Column({ type: 'varchar', length: 50 })
    source_rail!: 'STRIPE_PAYMENTS' | 'CLAIM_PAYOUT_RAIL';

    @Index()
    @Column({ type: 'varchar', length: 255 })
    external_reference_id!: string; // e.g., Charge ID, Refund ID, or Payout Transfer ID

    @Column({ type: 'varchar', length: 50 })
    break_type!:
        | 'AMOUNT_MISMATCH'
        | 'MISSING_IN_LEDGER'
        | 'MISSING_AT_PROVIDER'
        | 'UNEXPECTED_RETURN_STATE';

    @Column({ type: 'bigint', nullable: true })
    provider_amount_cents!: number | null;

    @Column({ type: 'bigint', nullable: true })
    ledger_amount_cents!: number | null;

    /** Difference = provider_amount_cents - ledger_amount_cents */
    @Column({ type: 'bigint' })
    variance_cents!: number;

    @Column({ type: 'text' })
    explanation!: string;

    @Column({ type: 'varchar', length: 30, default: 'OPEN_BREAK' })
    status!: 'OPEN_BREAK' | 'RESOLVED_BY_JOURNAL';

    @Column({ type: 'boolean', default: false })
    is_planted_test_break!: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    detected_at!: Date;
}

export const ALL_ENTITIES = [
    LedgerTransaction,
    LedgerEntry,
    Broker,
    BrokerStatement,
    Policy,
    PolicyEvent,
    Claim,
    ClaimReserveEvent,
    ApprovalRequest,
    WebhookEvent,
    ReconciliationBreak,
];