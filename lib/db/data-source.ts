import 'reflect-metadata';
import { DataSource, EntityManager } from 'typeorm';
import pg from 'pg';
import { ALL_ENTITIES } from './entities';

// 1. Parse Postgres BIGINT (OID 20) as safe JS integer (cents) instead of string
pg.types.setTypeParser(20, (val: string) => parseInt(val, 10));
pg.types.setTypeParser(1700, (val: string) => parseFloat(val));

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    throw new Error(
        'CRITICAL: DATABASE_URL environment variable is not set. Check your .env file.'
    );
}

export const AppDataSource = new DataSource({
    type: 'postgres',
    url: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
    synchronize: true,
    logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    entities: ALL_ENTITIES,
    extra: {
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        options: '-c timezone=UTC',
    },
});

const globalForDb = globalThis as unknown as {
    dataSource: DataSource | undefined;
    initPromise: Promise<DataSource> | undefined;
};

/**
 * Installs a hard PostgreSQL trigger on all append-only financial/event tables.
 * Guarantees Non-Negotiable #2 ("UPDATE or DELETE on money rows. Anywhere. Ever.")
 * at the database engine level.
 */
async function installImmutabilityTriggers(ds: DataSource): Promise<void> {
    const immutableTables = [
        'ledger_transactions',
        'ledger_entries',
        'policy_events',
        'claim_reserve_events',
    ];

    await ds.query(`
    CREATE OR REPLACE FUNCTION prevent_financial_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'FINANCIAL_IMMUTABILITY_VIOLATION: % is strictly prohibited on append-only table %. Use compensating reversal entries.', TG_OP, TG_TABLE_NAME;
    END;
    $$ LANGUAGE plpgsql;
  `);

    for (const table of immutableTables) {
        await ds.query(`
      DROP TRIGGER IF EXISTS trg_immutable_${table} ON "${table}";
      CREATE TRIGGER trg_immutable_${table}
      BEFORE UPDATE OR DELETE ON "${table}"
      FOR EACH ROW EXECUTE FUNCTION prevent_financial_mutation();
    `);
    }
}

export async function getDb(): Promise<DataSource> {
    const ds = globalForDb.dataSource ?? AppDataSource;
    globalForDb.dataSource = ds;

    if (ds.isInitialized) {
        return ds;
    }

    if (!globalForDb.initPromise) {
        globalForDb.initPromise = ds
            .initialize()
            .then(async (initializedDs) => {
                await installImmutabilityTriggers(initializedDs);
                console.log(
                    '[DB] Connected to Neon PostgreSQL (UTC, BIGINT parser active, Immutability Triggers armed)'
                );
                return initializedDs;
            })
            .catch((err) => {
                globalForDb.initPromise = undefined;
                console.error('[DB] Failed to initialize Neon PostgreSQL connection:', err);
                throw err;
            });
    }

    return globalForDb.initPromise;
}

export async function withTransaction<T>(
    work: (manager: EntityManager) => Promise<T>
): Promise<T> {
    const db = await getDb();
    return db.transaction(async (transactionalEntityManager) => {
        return work(transactionalEntityManager);
    });
}