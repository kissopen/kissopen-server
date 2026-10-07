import { PrismaPGlite } from 'pglite-prisma-adapter';

type Driver = Awaited<ReturnType<PrismaPGlite['connect']>>;

/** Prisma 6's driver boundary expects Bytes as a plain array, not a typed
 * array (which its JSON transport turns into an object with numeric keys).
 * Convert result values only; stored bytea and bound parameters are unchanged.
 */
function bytesForPrisma(value: unknown): unknown {
    if (value instanceof Uint8Array) return Array.from(value);
    if (Array.isArray(value)) return value.map(bytesForPrisma);
    return value;
}

function queryable<T extends Pick<Driver, 'queryRaw'>>(driver: T): T {
    const query = driver.queryRaw.bind(driver);
    driver.queryRaw = async input => {
        const result = await query(input);
        return { ...result, rows: result.rows.map(row => row.map(bytesForPrisma)) };
    };
    return driver;
}

function compatible(driver: Driver): Driver {
    queryable(driver);
    const start = driver.startTransaction.bind(driver);
    driver.startTransaction = async isolation => queryable(await start(isolation));
    return driver;
}

export class PrismaPGliteCompatible extends PrismaPGlite {
    override async connect(): Promise<Driver> {
        return compatible(await super.connect());
    }

    override async connectToShadowDb(): Promise<Driver> {
        return compatible(await super.connectToShadowDb());
    }
}
