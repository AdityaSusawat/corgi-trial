import { Suspense } from 'react';
import { connection } from 'next/server';
import { getDb } from '@/lib/db/data-source';

async function DatabaseStatusCard() {
  // Tells Next.js 16 this component executes dynamically at request time
  await connection();

  let dbStatus = 'Checking...';
  let tableCount = 0;
  let errorMsg = '';

  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';`
    );
    tableCount = parseInt(result[0].count, 10);
    dbStatus = 'Connected to Neon PostgreSQL (UTC session, triggers armed)';
  } catch (err: unknown) {
    dbStatus = 'Failed to connect';
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex justify-between items-center py-2 border-b border-slate-800">
        <span className="text-slate-400">Database:</span>
        <span
          className={
            dbStatus.startsWith('Connected')
              ? 'text-emerald-400 font-semibold'
              : 'text-rose-400 font-semibold'
          }
        >
          {dbStatus.startsWith('Connected') ? 'ONLINE' : 'OFFLINE'}
        </span>
      </div>

      <div className="flex justify-between items-center py-2 border-b border-slate-800">
        <span className="text-slate-400">Tables Synchronized:</span>
        <span className="text-slate-200 font-semibold">{tableCount}</span>
      </div>

      <div className="flex justify-between items-center py-2 border-b border-slate-800">
        <span className="text-slate-400">Money Handling:</span>
        <span className="text-slate-200">Integer Cents (BIGINT)</span>
      </div>

      {errorMsg && (
        <div className="mt-4 p-3 bg-rose-950/60 border border-rose-800 rounded text-rose-300 text-xs break-all">
          {errorMsg}
        </div>
      )}
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 font-mono">
      <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-2xl">
        <h1 className="text-xl font-bold text-orange-400 mb-4 flex items-center gap-2">
          <span>🐕</span> Corgi Policy Admin
        </h1>

        <Suspense
          fallback={
            <div className="py-6 text-center text-xs text-slate-500 animate-pulse">
              Connecting to Neon PostgreSQL...
            </div>
          }
        >
          <DatabaseStatusCard />
        </Suspense>

        <div className="mt-6 pt-4 border-t border-slate-800 text-xs text-slate-500 text-center">
          Track 1: Policy Administration System
        </div>
      </div>
    </main>
  );
}