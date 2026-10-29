import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import { stripe } from '../lib/stripe';
import { getDb } from '../lib/db/data-source';
import {
    Broker,
    LedgerAccount,
    LedgerEntry,
    Policy,
} from '../lib/db/entities';

const BASE_URL = 'http://localhost:3000';

async function runLocalVerification() {
    console.log('🚀 [TEST] Starting End-to-End Local Payment & Ledger Verification...\n');

    const db = await getDb();

    // 1. Fetch our seeded APPROVED broker
    const broker = await db.getRepository<Broker>('Broker').findOne({
        where: { kyb_status: 'APPROVED' },
    });

    if (!broker) {
        throw new Error('No APPROVED broker found in DB. Did you run `pnpm db:seed`?');
    }
    console.log(`✅ [1/5] Using Seeded Approved Broker: "${broker.legal_name}" (${broker.id})`);

    // 2. Call the Checkout API on localhost:3000
    console.log('💳 [2/5] Calling POST /api/policies/checkout with test card pm_card_visa...');
    const checkoutRes = await fetch(`${BASE_URL}/api/policies/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            brokerId: broker.id,
            insuredName: 'Apex Dynamics Robotics LLC',
            insuredEin: '88-4411223',
            insuredAddress: '400 Mission St, San Francisco, CA 94105',
            riskState: 'CA',
            annualBasePremiumCents: 1_200_000, // $12,000 base
            autoConfirmWithTestCard: true,
        }),
    });

    if (!checkoutRes.ok) {
        const errText = await checkoutRes.text();
        throw new Error(`Checkout API failed (${checkoutRes.status}): ${errText}`);
    }

    const checkoutData = await checkoutRes.json();
    console.log(`✅ [2/5] Stripe PaymentIntent Created & Confirmed: ${checkoutData.paymentIntentId}`);
    console.log(`       - Status: ${checkoutData.status}`);
    console.log(`       - Total Gross Charged: $${(checkoutData.pricing.totalGrossChargedCents / 100).toFixed(2)}`);

    // 3. Fetch full PaymentIntent object from Stripe and dispatch local HMAC-signed Webhook
    console.log('\n🪝 [3/5] Simulating Webhook dispatch to POST /api/webhooks/stripe...');
    const paymentIntent = await stripe.paymentIntents.retrieve(checkoutData.paymentIntentId);

    const webhookPayload = JSON.stringify({
        id: `evt_local_test_${Date.now()}`,
        object: 'event',
        api_version: '2026-09-30.endive',
        created: Math.floor(Date.now() / 1000),
        data: { object: paymentIntent },
        type: 'payment_intent.succeeded',
    });

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder_for_build';
    const signature = stripe.webhooks.generateTestHeaderString({
        payload: webhookPayload,
        secret: webhookSecret,
    });

    const webhookRes = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'stripe-signature': signature,
        },
        body: webhookPayload,
    });

    if (!webhookRes.ok) {
        const errText = await webhookRes.text();
        throw new Error(`Webhook handler failed (${webhookRes.status}): ${errText}`);
    }
    console.log('✅ [3/5] Webhook successfully received and processed (200 OK)');

    // 4. Verify Database Integrity in Neon
    console.log('\n🔍 [4/5] Verifying database records in Neon PostgreSQL...');
    const policy = await db.getRepository<Policy>('Policy').findOne({
        where: { stripe_payment_intent_id: checkoutData.paymentIntentId },
        relations: { events: true },
    });

    if (!policy) {
        throw new Error(`Policy not found for PaymentIntent ${checkoutData.paymentIntentId}`);
    }

    console.log(`✅ Policy Bound in Ledger: ${policy.policy_number} (Status: ${policy.status})`);
    console.log(`   - Term: ${policy.effective_start_date} -> ${policy.effective_end_date} (${policy.term_days} days)`);
    console.log(`   - Policy Events Recorded: ${policy.events.length}`);

    // Ledger invariant check for this policy
    const entries = await db.getRepository<LedgerEntry>('LedgerEntry').find({
        where: { policy_id: policy.id },
    });

    const totalDebits = entries
        .filter((e) => e.direction === 'DEBIT')
        .reduce((sum, e) => sum + e.amount_cents, 0);

    const totalCredits = entries
        .filter((e) => e.direction === 'CREDIT')
        .reduce((sum, e) => sum + e.amount_cents, 0);

    console.log(`   - Ledger Invariant Check: Debits ($${(totalDebits / 100).toFixed(2)}) === Credits ($${(totalCredits / 100).toFixed(2)})`);
    if (totalDebits !== totalCredits) {
        throw new Error(`UNBALANCED LEDGER: Debits ${totalDebits} != Credits ${totalCredits}`);
    }
    console.log('✅ [4/5] Double-Entry Ledger Invariant holds to the exact integer cent!');

    // 5. Test Cancellation & Real Stripe Refund API Call
    console.log('\n💸 [5/5] Testing Cancellation & Live Stripe Refund API...');
    const cancelRes = await fetch(`${BASE_URL}/api/policies/${policy.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            cancellationEffectiveDate: '2026-07-01',
            cancellationMethod: 'PRO_RATA',
            reason: 'Local test verification of unearned premium refund rail',
        }),
    });

    if (!cancelRes.ok) {
        const errText = await cancelRes.text();
        throw new Error(`Cancel API failed (${cancelRes.status}): ${errText}`);
    }

    const cancelData = await cancelRes.json();
    console.log(`✅ Policy Cancelled: Status is now "${cancelData.status}"`);
    console.log(`   - Live Stripe Refund ID: ${cancelData.stripeRefundId}`);
    console.log(`   - Refund Amount: $${(cancelData.calculation.totalCustomerCashRefundCents / 100).toFixed(2)}`);
    console.log(`   - Broker Commission Clawed Back: $${(cancelData.calculation.brokerCommissionClawbackCents / 100).toFixed(2)}`);

    console.log('\n🎉 ALL LOCAL INTEGRATION TESTS PASSED! Money moved in & out successfully.');
    process.exit(0);
}

runLocalVerification().catch((err) => {
    console.error('\n❌ [TEST FAILED]:', err);
    process.exit(1);
});