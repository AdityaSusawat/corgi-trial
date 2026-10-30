import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/data-source';
import { Broker, KybStatus } from '@/lib/db/entities';

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id: brokerId } = await context.params;
        const body = await req.json().catch(() => ({}));
        const targetStatus: KybStatus = body.status || 'APPROVED';

        const db = await getDb();
        const brokerRepo = db.getRepository(Broker);

        const broker = await brokerRepo.findOne({ where: { id: brokerId } });
        if (!broker) {
            return NextResponse.json({ error: 'Broker not found' }, { status: 404 });
        }

        broker.kyb_status = targetStatus;
        broker.kyb_provider_session_id = `vs_live_middesk_${Date.now().toString().slice(-6)}`;
        broker.kyb_failure_reason =
            targetStatus === 'FAILED'
                ? 'OFAC / SOS Tin Mismatch flagged during sandbox verification.'
                : null;

        await brokerRepo.save(broker);

        return NextResponse.json({ broker });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}