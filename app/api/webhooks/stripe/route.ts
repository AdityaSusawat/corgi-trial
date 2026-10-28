import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { getDb } from '@/lib/db/data-source';
import { WebhookEvent } from '@/lib/db/entities';

export async function POST(req: NextRequest) {
    const body = await req.text();
    const signature = req.headers.get('stripe-signature');
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder_for_build';

    if (!signature) {
        console.error('[STRIPE_WEBHOOK] Missing stripe-signature header.');
        return NextResponse.json(
            { error: 'Missing stripe-signature header' },
            { status: 400 }
        );
    }

    let event;
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

    try {
        const db = await getDb();
        const webhookRepo = db.getRepository(WebhookEvent);

        // 1. Idempotency Check ("Twice is one")
        const existing = await webhookRepo.findOne({
            where: { provider_event_id: event.id },
        });

        if (existing) {
            console.log(`[STRIPE_WEBHOOK] Duplicate event replay ignored: ${event.id}`);
            existing.delivery_attempts += 1;
            existing.processing_status = 'DUPLICATE_REPLAY';
            await webhookRepo.save(existing);
            return NextResponse.json({ received: true, replay: true });
        }

        // 2. Record the fresh webhook event for audit trail
        const record = webhookRepo.create({
            provider_event_id: event.id,
            provider: 'STRIPE',
            event_type: event.type,
            signature_verified: true,
            processing_status: 'PROCESSED',
            raw_payload: event as unknown as Record<string, unknown>,
            provider_occurred_at: new Date(event.created * 1000),
        });
        await webhookRepo.save(record);

        console.log(`[STRIPE_WEBHOOK] Successfully recorded event: ${event.type} (${event.id})`);

        // Business event handlers (e.g. payment_intent.succeeded) will be connected here
        switch (event.type) {
            case 'payment_intent.succeeded': {
                const paymentIntent = event.data.object;
                console.log(`[STRIPE_WEBHOOK] PaymentIntent succeeded: ${paymentIntent.id}`);
                break;
            }
            case 'charge.refunded': {
                const charge = event.data.object;
                console.log(`[STRIPE_WEBHOOK] Charge refunded: ${charge.id}`);
                break;
            }
            default:
                console.log(`[STRIPE_WEBHOOK] Unhandled event type: ${event.type}`);
        }

        return NextResponse.json({ received: true });
    } catch (err: unknown) {
        console.error('[STRIPE_WEBHOOK] Processing error:', err);
        return NextResponse.json(
            { error: 'Internal server error processing webhook' },
            { status: 500 }
        );
    }
}