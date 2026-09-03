const { Pool } = require('pg');

let pool = null;

function initPool() {
  if (pool) return;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('[DB] DATABASE_URL not found in .env. Database connection skipped.');
    return;
  }
  
  const poolMin = parseInt(process.env.DATABASE_POOL_MIN || '2', 10);
  const poolMax = parseInt(process.env.DATABASE_POOL_MAX || '20', 10);

  pool = new Pool({
    connectionString,
    min: poolMin,
    max: poolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  
  // Set statement_timeout on new clients
  pool.on('connect', (client) => {
    client.query('SET statement_timeout = 60000').catch(e => console.error('[DB] Failed to set statement_timeout:', e));
  });

  pool.on('error', (err, client) => {
    console.error('[DB] Unexpected error on idle client', err);
  });
  
  console.log(`[DB] PostgreSQL pool initialized (min=${poolMin}, max=${poolMax}).`);
}

async function query(text, params) {
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
    console.error('[DB] query error:', err.message, text);
    throw err;
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
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
  getPool: () => pool
};
