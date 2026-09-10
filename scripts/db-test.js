require('dotenv').config();

const { initPool, query, closePool, localDatabaseConfig } = require('../lib/db');

const requiredTables = [
  'organizations', 'users', 'documents', 'document_versions', 'chunks', 'embeddings',
  'document_jobs', 'conversations', 'messages', 'answers', 'artifacts',
  'session_summaries', 'charts', 'context_snapshots'
];

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
}

async function dbTest() {
  const config = localDatabaseConfig();
  let failed = false;

  console.log('========================================');
  console.log('KNOWLEDGE STUDIO LOCAL MODE');
  console.log('========================================');
  console.log('Runtime: Node.js');
  console.log(`Backend: localhost:${process.env.PORT || 3000}`);
  console.log(`Database Host: ${config.host}`);
  console.log(`Database Port: ${config.port}`);
  console.log(`Database: ${config.database}`);
  console.log('Docker Required: NO');
  console.log('Vector Search: pgvector');
  console.log('========================================');

  try {
    await initPool();
    pass('PostgreSQL connection');

    const database = await query('SELECT current_database() AS name, version() AS version');
    pass(`Database: ${database.rows[0].name}`);
    pass(`PostgreSQL version: ${database.rows[0].version.split(',')[0]}`);

    await query('SELECT 1');
    pass('SELECT 1');

    const vector = await query("SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'");
    if (vector.rowCount === 1) {
      pass(`pgvector available (${vector.rows[0].extversion})`);
    } else {
      failed = true;
      fail('pgvector is missing. Install pgvector for this PostgreSQL version, then run CREATE EXTENSION vector; in knowledge_studio.');
    }

    const tables = await query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])',
      ['public', requiredTables]
    );
    const found = new Set(tables.rows.map(row => row.table_name));
    const missing = requiredTables.filter(table => !found.has(table));
    if (missing.length) {
      failed = true;
      fail(`Required tables missing: ${missing.join(', ')}. Run npm run db:migrate after reviewing the schema.`);
    } else {
      pass('Required tables available');
    }

    for (const table of requiredTables) {
      if (!found.has(table)) continue;
      const count = await query(`SELECT count(*)::int AS count FROM ${table}`);
      console.log(`[INFO] ${table}: ${count.rows[0].count}`);
    }
  } catch (error) {
    failed = true;
    fail(error.message);
  } finally {
    await closePool().catch(error => fail(`Could not close database pool: ${error.message}`));
  }

  process.exitCode = failed ? 1 : 0;
}

dbTest();
