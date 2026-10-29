import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { getDb } from '@/lib/db/data-source';
import {
    Broker,
    CancellationType,
    Policy,
    PolicyEvent,
} from '@/lib/db/entities';
import {
    calculateCancellationRefund,
    PolicyFinancialSlice,
} from '@/lib/math/insurance-math';
import { cancelPolicyAndRefund } from '@/lib/services/ledger-service';

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id: policyId } = await context.params;
        const body = await req.json();
        const {
            cancellationEffectiveDate,
            cancellationMethod = 'PRO_RATA',
            reason = 'Insured requested mid-term cancellation',
        } = body as {
            cancellationEffectiveDate: string;
            cancellationMethod?: CancellationType;
            reason?: string;
        };

        if (!cancellationEffectiveDate) {
            return NextResponse.json(
                { error: 'cancellationEffectiveDate (YYYY-MM-DD) is required.' },
                { status: 400 }
            );
        }

        const db = await getDb();
        const policy = await db.getRepository(Policy).findOne({
            where: { id: policyId },
        });

        if (!policy) {
            return NextResponse.json(
                { error: `Policy ${policyId} not found.` },
                { status: 404 }
            );
        }

        if (policy.status !== 'BOUND_ACTIVE') {
            return NextResponse.json(
                { error: `Policy ${policy.policy_number} is already ${policy.status}.` },
                { status: 400 }
            );
        }

        const broker = await db.getRepository(Broker).findOneOrFail({
            where: { id: policy.broker_id },
        });

        const events = await db.getRepository(PolicyEvent).find({
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

        // 1. Pre-compute the exact unearned refund in integer cents
        const preview = calculateCancellationRefund({
            policyStartDate: policy.effective_start_date,
            policyEndDate: policy.effective_end_date,
            cancellationEffectiveDate,
            cancellationMethod,
            riskState: policy.risk_state,
            brokerCommissionRateBps: broker.commission_rate_bps,
            slices,
        });

        // 2. Execute live Stripe Refund API call if backed by a real Stripe PaymentIntent
        let stripeRefundId: string | null = null;
        const isRealStripePayment =
            policy.stripe_payment_intent_id &&
            policy.stripe_payment_intent_id.startsWith('pi_') &&
            !policy.stripe_payment_intent_id.startsWith('pi_seed_');

        if (isRealStripePayment && preview.totalCustomerCashRefundCents > 0) {
            const refund = await stripe.refunds.create({
                payment_intent: policy.stripe_payment_intent_id!,
                amount: preview.totalCustomerCashRefundCents,
                reason: 'requested_by_customer',
                metadata: {
                    policy_id: policy.id,
                    policy_number: policy.policy_number,
                    cancellation_effective_date: cancellationEffectiveDate,
                    cancellation_method: cancellationMethod,
                    reason,
                },
            });
            stripeRefundId = refund.id;
        }

        // 3. Commit cancellation, unearned reserve clearing, and commission clawback to the ledger
        const result = await cancelPolicyAndRefund({
            idempotencyKey: `api_cancel_${policy.id}_${cancellationEffectiveDate}`,
            policyId: policy.id,
            cancellationEffectiveDate,
            cancellationMethod,
            reason,
            externalRefundId: stripeRefundId,
            createdBy: 'API_USER',
        });

        return NextResponse.json({
            policyNumber: result.policy.policy_number,
            status: result.policy.status,
            stripeRefundId,
            calculation: result.calculation,
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[CANCEL_API_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}