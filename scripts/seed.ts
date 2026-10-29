import 'reflect-metadata';
import { getDb } from '../lib/db/data-source';
import {
    Broker,
    KybStatus,
    LedgerTransaction,
} from '../lib/db/entities';
import {
    applyMidTermEndorsement,
    issueAndBindPolicy,
    openClaimWithInitialReserve,
} from '../lib/services/ledger-service';

async function seed() {
    console.log('🌱 [SEED] Initializing Neon database connection...');
    const db = await getDb();

    console.log('🧹 [SEED] Cleaning existing demo records...');
    // Truncate tables cleanly using CASCADE to reset state for repeatable test runs
    await db.query(`
    TRUNCATE TABLE 
      approval_requests,
      claim_reserve_events,
      claims,
      ledger_entries,
      ledger_transactions,
      policy_events,
      policies,
      broker_statements,
      webhook_events,
      brokers
    CASCADE;
  `);

    console.log('🏛️ [SEED] Creating Brokers across all statutory KYB states...');

    const brokerRepo = db.getRepository(Broker);

    // 1. Approved Broker (Ready to bind business)
    const approvedBroker = brokerRepo.create({
        legal_name: 'Apex Specialty Risk LLC',
        dba_name: 'Apex Risk Partners',
        ein: '12-3456789',
        contact_email: 'underwriting@apexrisk.com',
        license_state: 'CA',
        kyb_status: 'APPROVED' as KybStatus,
        kyb_provider_session_id: 'vs_live_apex_ca_001',
        kyb_provider_name: 'STRIPE_IDENTITY_LIVE',
        kyb_failure_reason: null,
        commission_rate_bps: 1000, // 10.0%
    });

    // 2. Pending Broker (Underwriting gate blocks binding)
    const pendingBroker = brokerRepo.create({
        legal_name: 'Beacon Underwriting Partners LLC',
        dba_name: 'Beacon Underwriting',
        ein: '98-7654321',
        contact_email: 'licensing@beaconpartners.com',
        license_state: 'NY',
        kyb_status: 'PENDING' as KybStatus,
        kyb_provider_session_id: 'vs_test_beacon_pending',
        kyb_provider_name: 'STRIPE_IDENTITY_LIVE',
        kyb_failure_reason: null,
        commission_rate_bps: 1250, // 12.5%
    });

    // 3. Failed Broker (Blocked from binding business)
    const failedBroker = brokerRepo.create({
        legal_name: 'Vanguard Mutual Agents Corp',
        dba_name: 'Vanguard Risk',
        ein: '45-9876543',
        contact_email: 'compliance@vanguardmutual.com',
        license_state: 'TX',
        kyb_status: 'FAILED' as KybStatus,
        kyb_provider_session_id: 'vs_test_vanguard_failed',
        kyb_provider_name: 'STRIPE_IDENTITY_LIVE',
        kyb_failure_reason:
            'Corporate charter suspended; Secretary of State active standing check failed.',
        commission_rate_bps: 1500, // 15.0%
    });

    const savedBrokers = await brokerRepo.save([
        approvedBroker,
        pendingBroker,
        failedBroker,
    ]);

    console.log(`✅ [SEED] Saved 3 brokers:`);
    console.log(`   - ${savedBrokers[0].legal_name} (${savedBrokers[0].kyb_status})`);
    console.log(`   - ${savedBrokers[1].legal_name} (${savedBrokers[1].kyb_status})`);
    console.log(`   - ${savedBrokers[2].legal_name} (${savedBrokers[2].kyb_status})`);

    console.log('\n📜 [SEED] Issuing Policy 1: Acme Robotics Corp (CA Risk)...');
    const policy1Result = await issueAndBindPolicy({
        idempotencyKey: 'seed_issuance_acme_2026',
        brokerId: savedBrokers[0].id,
        insuredName: 'Acme Robotics Corp',
        insuredEin: '94-3124567',
        insuredAddress: '742 Evergreen Terrace, Palo Alto, CA 94301',
        riskState: 'CA',
        productLine: 'COMMERCIAL_GENERAL_LIABILITY',
        effectiveStartDate: '2026-01-01',
        effectiveEndDate: '2027-01-01', // Leap-year aware 365-day term
        coverageLimitCents: 100_000_000, // $1,000,000.00
        deductibleCents: 1_000_000, // $10,000.00
        annualBasePremiumCents: 1_200_000, // $12,000.00
        vehiclesCovered: ['2024 Ford Transit (VIN: 1FTBR1Y89P0192)'],
        additionalInsureds: ['Landlord Holdings LLC'],
        collectImmediately: true,
        stripePaymentIntentId: 'pi_seed_acme_issuance_001',
        stripeChargeId: 'ch_seed_acme_issuance_001',
        createdBy: 'SYSTEM_SEED',
    });
    console.log(`✅ [SEED] Issued & bound policy: ${policy1Result.policy.policy_number}`);
    console.log(
        `   - Gross Collected: $${(
            policy1Result.pricing.totalGrossChargedCents / 100
        ).toFixed(2)}`
    );
    console.log(
        `   - Broker Commission Accrued: $${(
            policy1Result.pricing.brokerCommissionCents / 100
        ).toFixed(2)}`
    );

    console.log('\n📜 [SEED] Issuing Policy 2: NovaCloud Systems Inc (NY Risk)...');
    const policy2Result = await issueAndBindPolicy({
        idempotencyKey: 'seed_issuance_novacloud_2026',
        brokerId: savedBrokers[0].id,
        insuredName: 'NovaCloud Systems Inc',
        insuredEin: '13-5892341',
        insuredAddress: '350 5th Ave, Suite 4100, New York, NY 10118',
        riskState: 'NY',
        productLine: 'CYBER_TECH_EO',
        effectiveStartDate: '2026-03-01',
        effectiveEndDate: '2027-03-01',
        coverageLimitCents: 200_000_000, // $2,000,000.00
        deductibleCents: 2_500_000, // $25,000.00
        annualBasePremiumCents: 2_400_000, // $24,000.00
        collectImmediately: true,
        stripePaymentIntentId: 'pi_seed_novacloud_issuance_002',
        stripeChargeId: 'ch_seed_novacloud_issuance_002',
        createdBy: 'SYSTEM_SEED',
    });
    console.log(`✅ [SEED] Issued & bound policy: ${policy2Result.policy.policy_number}`);

    console.log('\n📝 [SEED] Applying Mid-Term Endorsement to NovaCloud Systems...');
    const endorsementResult = await applyMidTermEndorsement({
        idempotencyKey: 'seed_endorsement_novacloud_limit_inc',
        policyId: policy2Result.policy.id,
        endorsementEffectiveDate: '2026-06-01',
        description: 'Increase Cyber Coverage Limit to $5M and expand aggregate',
        annualizedBasePremiumDeltaCents: 600_000, // +$6,000/yr annualized
        newCoverageLimitCents: 500_000_000, // $5,000,000.00
        bypassMakerChecker: true,
        createdBy: 'SYSTEM_SEED',
    });
    console.log(
        `✅ [SEED] Endorsement applied (Prorated Base Delta: $${(
            endorsementResult.pricing.proratedBasePremiumDeltaCents / 100
        ).toFixed(2)})`
    );

    console.log('\n🚨 [SEED] Establishing Claim with Loss Reserve on Acme Robotics...');
    const claimResult = await openClaimWithInitialReserve({
        idempotencyKey: 'seed_claim_acme_robotics_001',
        policyId: policy1Result.policy.id,
        dateOfLoss: '2026-04-15',
        claimantName: 'Bay Area Logistics Corp',
        lossDescription:
            'Autonomous warehouse robot malfunction caused rack structural collapse.',
        initialReserveCents: 2_500_000, // $25,000.00 initial loss reserve
        plaidVerificationId: 'plaid_v_seed_bayarea_001',
        claimantBankRouting: '011000015',
        claimantBankAccountMask: '4488',
        createdBy: 'SYSTEM_SEED',
    });
    console.log(
        `✅ [SEED] Opened Claim ${claimResult.claim.claim_number} with reserve: $${(
            claimResult.claim.current_reserve_cents / 100
        ).toFixed(2)}`
    );

    console.log('\n🔒 [SEED] Verifying Ledger Double-Entry Balancing Invariant...');
    const txRepo = db.getRepository(LedgerTransaction);
    const transactions = await txRepo.find({ relations: { entries: true } });

    let allBalanced = true;
    for (const tx of transactions) {
        const debits = tx.entries
            .filter((e) => e.direction === 'DEBIT')
            .reduce((sum, e) => sum + e.amount_cents, 0);
        const credits = tx.entries
            .filter((e) => e.direction === 'CREDIT')
            .reduce((sum, e) => sum + e.amount_cents, 0);

        if (debits !== credits) {
            console.error(
                `❌ UNBALANCED TX DETECTED: [${tx.id}] Debits: ${debits} != Credits: ${credits}`
            );
            allBalanced = false;
        }
    }

    if (allBalanced) {
        console.log(
            `🎉 [SEED] All ${transactions.length} Ledger Transactions are balanced to the exact integer cent!`
        );
    }

    console.log('\n🚀 [SEED] Database seeding completed successfully.');
    process.exit(0);
}

seed().catch((err) => {
    console.error('❌ [SEED] Fatal error running seed script:', err);
    process.exit(1);
});