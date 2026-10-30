import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import { getDb } from '@/lib/db/data-source';
import {
    Broker,
    CancellationType,
    Policy,
    WebhookEvent,
} from '@/lib/db/entities';
import {
    applyMidTermEndorsement,
    cancelPolicyAndRefund,
    issueAndBindPolicy,
} from '@/lib/services/ledger-service';

export async function POST(req: NextRequest) {
    const body = await req.text();
    const signature = req.headers.get('stripe-signature');
    const webhookSecret =
        process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder_for_build';

    if (!signature) {
        console.error('[STRIPE_WEBHOOK] Missing stripe-signature header.');
        return NextResponse.json(
            { error: 'Missing stripe-signature header' },
            { status: 400 }
        );
    }

    let event: Stripe.Event;
    try {
        event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[STRIPE_WEBHOOK] Signature verification failed: ${message}`);
        return NextResponse.json(
            { error: `Webhook signature verification failed: ${message}` },
            { status: 400 }
        );
    }

    const db = await getDb();
    const webhookRepo = db.getRepository(WebhookEvent);

    try {
        // 1. Idempotency Check ("Twice is one")
        const existing = await webhookRepo.findOne({
            where: { provider_event_id: event.id },
        });

        if (existing && existing.processing_status === 'PROCESSED') {
            console.log(`[STRIPE_WEBHOOK] Duplicate event replay ignored: ${event.id}`);
            existing.delivery_attempts += 1;
            existing.processing_status = 'DUPLICATE_REPLAY';
            existing.last_seen_at = new Date();
            await webhookRepo.save(existing);
            return NextResponse.json({ received: true, replay: true });
        }

        // Create or load the tracking record before executing ledger mutations
        const record =
            existing ??
            webhookRepo.create({
                provider_event_id: event.id,
                provider: 'STRIPE',
                event_type: event.type,
                signature_verified: true,
                processing_status: 'PROCESSED',
                delivery_attempts: 1,
                raw_payload: event as unknown as Record<string, unknown>,
                provider_occurred_at: new Date(event.created * 1000),
            });

        // 2. Route Event to Ledger Service
        switch (event.type) {
            case 'payment_intent.succeeded': {
                const pi = event.data.object as Stripe.PaymentIntent;

                const meta = pi.metadata ?? {};

                // Live-Fire Reconciliation Test Guard:
                // Skips ledger ingestion when planting an unbooked Stripe charge
                if (meta.skip_webhook_ledger === 'true') {
                    record.processing_status = 'PROCESSED';
                    await webhookRepo.save(record);
                    return NextResponse.json({ received: true, skippedForReconTest: true });
                }
                const actionType = meta.corgi_action ?? 'POLICY_ISSUANCE';

                const latestChargeId =
                    typeof pi.latest_charge === 'string'
                        ? pi.latest_charge
                        : pi.latest_charge?.id ?? null;

                if (actionType === 'ENDORSEMENT') {
                    if (!meta.policy_id || !meta.endorsement_effective_date) {
                        throw new Error(
                            `MISSING_ENDORSEMENT_METADATA: PaymentIntent ${pi.id} is missing policy_id or endorsement_effective_date.`
                        );
                    }

                    await applyMidTermEndorsement({
                        idempotencyKey: `stripe_end_${pi.id}`,
                        policyId: meta.policy_id,
                        endorsementEffectiveDate: meta.endorsement_effective_date,
                        description:
                            meta.description || `Mid-term endorsement paid via Stripe (${pi.id})`,
                        annualizedBasePremiumDeltaCents: Number(
                            meta.annualized_base_premium_delta_cents ?? 0
                        ),
                        newCoverageLimitCents: meta.new_coverage_limit_cents
                            ? Number(meta.new_coverage_limit_cents)
                            : undefined,
                        newDeductibleCents: meta.new_deductible_cents
                            ? Number(meta.new_deductible_cents)
                            : undefined,
                        externalPaymentOrRefundId: latestChargeId ?? pi.id,
                        bypassMakerChecker: true,
                        createdBy: 'STRIPE_WEBHOOK',
                    });

                    console.log(
                        `[STRIPE_WEBHOOK] Applied endorsement on policy ${meta.policy_id} from PaymentIntent ${pi.id}`
                    );
                } else {
                    // Default: POLICY_ISSUANCE
                    // Resolve Broker ID from metadata, or fallback to our seeded APPROVED broker for CLI test triggers
                    let brokerId = meta.broker_id;
                    if (!brokerId) {
                        const defaultApprovedBroker = await db
                            .getRepository(Broker)
                            .findOne({ where: { kyb_status: 'APPROVED' } });

                        if (!defaultApprovedBroker) {
                            throw new Error(
                                'NO_APPROVED_BROKER_FOUND: Run `pnpm db:seed` so at least one APPROVED broker exists.'
                            );
                        }
                        brokerId = defaultApprovedBroker.id;
                    }

                    // If triggered via bare Stripe CLI (`amount: 2000`), use metadata if present or sensible defaults
                    const annualBasePremiumCents = meta.annual_base_premium_cents
                        ? Number(meta.annual_base_premium_cents)
                        : 500_000; // $5,000.00 default for bare CLI triggers

                    const effectiveStartDate =
                        meta.effective_start_date || new Date().toISOString().slice(0, 10);

                    const result = await issueAndBindPolicy({
                        idempotencyKey: `stripe_iss_${pi.id}`,
                        brokerId,
                        insuredName:
                            meta.insured_name ||
                            pi.shipping?.name ||
                            'Stripe Sandbox Insured LLC',
                        insuredEin: meta.insured_ein || '88-1234567',
                        insuredAddress:
                            meta.insured_address ||
                            '510 Townsend St, San Francisco, CA 94103',
                        riskState: (meta.risk_state || 'CA').toUpperCase(),
                        productLine:
                            meta.product_line === 'CYBER_TECH_EO'
                                ? 'CYBER_TECH_EO'
                                : 'COMMERCIAL_GENERAL_LIABILITY',
                        effectiveStartDate,
                        effectiveEndDate: meta.effective_end_date || undefined,
                        coverageLimitCents: meta.coverage_limit_cents
                            ? Number(meta.coverage_limit_cents)
                            : 100_000_000, // $1,000,000
                        deductibleCents: meta.deductible_cents
                            ? Number(meta.deductible_cents)
                            : 500_000, // $5,000
                        annualBasePremiumCents,
                        paymentMethodType: 'CARD',
                        stripePaymentIntentId: pi.id,
                        stripeChargeId: latestChargeId,
                        collectImmediately: true,
                        createdBy: 'STRIPE_WEBHOOK',
                    });

                    console.log(
                        `[STRIPE_WEBHOOK] Bound Policy ${result.policy.policy_number} from PaymentIntent ${pi.id}`
                    );
                }
                break;
            }

            case 'charge.refunded': {
                const charge = event.data.object as Stripe.Charge;
                const paymentIntentId =
                    typeof charge.payment_intent === 'string'
                        ? charge.payment_intent
                        : charge.payment_intent?.id ?? null;

                const policyRepo = db.getRepository(Policy);
                const policy = await policyRepo.findOne({
                    where: [
                        ...(paymentIntentId
                            ? [{ stripe_payment_intent_id: paymentIntentId }]
                            : []),
                        { stripe_charge_id: charge.id },
                    ],
                });

                if (!policy) {
                    console.warn(
                        `[STRIPE_WEBHOOK] charge.refunded received for unknown policy (charge: ${charge.id}, pi: ${paymentIntentId}).`
                    );
                    break;
                }

                // If the synchronous /cancel endpoint already cancelled the policy, skip duplicate cancellation
                if (policy.status !== 'BOUND_ACTIVE') {
                    console.log(
                        `[STRIPE_WEBHOOK] Policy ${policy.policy_number} is already ${policy.status}; skipping duplicate refund booking.`
                    );
                    break;
                }

                const latestRefund = charge.refunds?.data?.[0];
                const refundMeta = latestRefund?.metadata ?? {};

                const cancellationEffectiveDate =
                    refundMeta.cancellation_effective_date ||
                    new Date().toISOString().slice(0, 10);

                const cancellationMethod: CancellationType =
                    refundMeta.cancellation_method === 'SHORT_RATE'
                        ? 'SHORT_RATE'
                        : 'PRO_RATA';

                const cancelResult = await cancelPolicyAndRefund({
                    idempotencyKey: `stripe_ref_${latestRefund?.id ?? charge.id}`,
                    policyId: policy.id,
                    cancellationEffectiveDate,
                    cancellationMethod,
                    reason:
                        refundMeta.reason || `Stripe charge refunded (${charge.id})`,
                    externalRefundId: latestRefund?.id ?? charge.id,
                    createdBy: 'STRIPE_WEBHOOK',
                });

                console.log(
                    `[STRIPE_WEBHOOK] Cancelled Policy ${cancelResult.policy.policy_number} and booked refund from Charge ${charge.id}`
                );
                break;
            }

            default:
                console.log(`[STRIPE_WEBHOOK] Unhandled event type: ${event.type}`);
        }

        await webhookRepo.save(record);
        return NextResponse.json({ received: true });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[STRIPE_WEBHOOK] Processing error:', message);
        return NextResponse.json(
            { error: `Webhook processing failed: ${message}` },
            { status: 500 }
        );
    }
}