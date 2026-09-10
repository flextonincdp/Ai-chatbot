const { Pool } = require('pg');

let pool = null;

function localDatabaseConfig() {
  // PG* is the standard Node/PostgreSQL configuration for local Windows use.
  // POSTGRES_* remains a temporary compatibility fallback for existing .env files.
  const host = process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost';
  const port = Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432);
  const database = process.env.PGDATABASE || process.env.POSTGRES_DB || 'knowledge_studio';
  const user = process.env.PGUSER || process.env.POSTGRES_USER || 'postgres';
  const password = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD;

  return { host, port, database, user, password };
}

function describeConnectionFailure(error) {
  switch (error.code) {
    case 'ECONNREFUSED':
      return 'PostgreSQL is not running or is not listening on the configured host and port.';
    case '28P01':
      return 'PostgreSQL authentication failed. Check PGUSER and PGPASSWORD.';
    case '3D000':
      return 'The configured PostgreSQL database does not exist.';
    default:
      return error.message;
  }
}

async function initPool() {
  if (pool) return;

  const config = localDatabaseConfig();
  console.log(`[DB] host=${config.host}`);
  console.log(`[DB] port=${config.port}`);
  console.log(`[DB] database=${config.database}`);
  console.log(`[DB] user=${config.user}`);
  
  const poolMin = parseInt(process.env.DATABASE_POOL_MIN || '2', 10);
  const poolMax = parseInt(process.env.DATABASE_POOL_MAX || '20', 10);

  pool = new Pool({
    ...config,
    min: poolMin,
    max: poolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    // Applied by PostgreSQL before a client is handed to the pool. Doing this
    // in a `connect` listener races the caller's first query on pg 8/9.
    options: '-c statement_timeout=60000',
  });

  pool.on('error', (err, client) => {
    console.error('[DB] Unexpected error on idle client', err);
  });
  
  try {
    // Force a test query to verify the connection is alive before accepting requests.
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('[DB] PostgreSQL connected');
    console.log(`[DB] PostgreSQL pool initialized (min=${poolMin}, max=${poolMax}).`);
  } catch (err) {
    console.error('[DB] PostgreSQL connection failed');
    console.error(`[DB] host=${config.host}`);
    console.error(`[DB] port=${config.port}`);
    console.error(`[DB] database=${config.database}`);
    console.error(`[DB] ${describeConnectionFailure(err)}`);
    await pool.end().catch(() => {});
    pool = null;
    process.exit(1); // Force crash, no silent fallback allowed
  }
}

async function query(text, params, _retries = 2) {
  if (!pool) {
    throw new Error('[DB] Database not configured');
  }
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    // console.log('[DB] executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (err) {
    // Retry on transient connection errors
    if (_retries > 0 && (err.code === 'ECONNREFUSED' || err.message.includes('Connection terminated'))) {
      console.warn(`[DB] Transient connection error, retrying (${_retries} left)...`);
      await new Promise(r => setTimeout(r, 1000));
      return query(text, params, _retries - 1);
    }
    console.error('[DB] query error:', err.message, text);
    throw err;
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[DB] Pool closed.');
  }
}

// Ensure pool shuts down cleanly on server exit
process.on('SIGINT', async () => {
  await closePool();
  process.exit(0);
});

module.exports = {
  initPool,
  query,
  closePool,
  getPool: () => pool,
  localDatabaseConfig
};
