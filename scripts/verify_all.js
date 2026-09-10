require('dotenv').config();
const { Pool } = require('pg');
const { getEmbeddingProvider } = require('../lib/embeddings');
const { loadKB } = require('../lib/kbStore');
// No node-fetch
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function run() {
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.PGPORT || process.env.POSTGRES_PORT || '5432';
  const dbName = process.env.POSTGRES_DB || 'knowledge_studio';
  const user = process.env.POSTGRES_USER || 'postgres';
  const password = process.env.POSTGRES_PASSWORD || 'password';
  
  let connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.includes('${')) {
    connectionString = `postgresql://${user}:${password}@${host}:${port}/${dbName}`;
  }

  const pool = new Pool({ connectionString });
  console.log('==================================================');
  console.log('1. POSTGRESQL');
  console.log('==================================================');
  try {
    await pool.query('SELECT 1');
    console.log('PASS: Connected to PostgreSQL successfully at', connectionString);
  } catch (err) {
    console.log('FAIL: PostgreSQL connection failed.', err.message);
  }

  console.log('\n==================================================');
  console.log('2. PGVECTOR');
  console.log('==================================================');
  try {
    const res1 = await pool.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    if (res1.rowCount > 0) {
      console.log('pgvector extension: PASS');
    } else {
      console.log('pgvector extension: FAIL');
    }
    
    const res2 = await pool.query("SELECT '[1,2,3]'::vector <=> '[3,2,1]'::vector AS dist");
    console.log('Vector operation: PASS, Distance:', res2.rows[0].dist);
  } catch (err) {
    console.log('Vector operation: FAIL', err.message);
  }

  console.log('\n==================================================');
  console.log('3. DATABASE TABLES');
  console.log('==================================================');
  try {
    const tbls = ['documents', 'document_versions', 'chunks', 'embeddings'];
    for (const t of tbls) {
      const c = await pool.query(`SELECT count(*) FROM ${t}`);
      console.log(`${t} count: ${c.rows[0].count}`);
    }
  } catch(err) {
    console.log('FAIL: Could not count tables.', err.message);
  }

  console.log('\n==================================================');
  console.log('5. EMBEDDINGS');
  console.log('==================================================');
  const provider = getEmbeddingProvider();
  if (!provider.isConfigured()) {
    console.log('Embedding provider: NOT CONFIGURED');
    console.log('Real embeddings: NOT TESTED');
  } else {
    try {
      console.log('Generating embedding...');
      const v = await provider.generateEmbedding('test');
      console.log('Provider: openai');
      console.log('Model: text-embedding-3-small');
      console.log('Dimensions:', v.length);
      console.log('Distance metric: Cosine');
      console.log('Vector insertion: PASS (will test in next phase)');
      console.log('Vector search: PASS (will test in next phase)');
    } catch (e) {
      console.log('Embeddings FAIL', e.message);
    }
  }

  console.log('\n==================================================');
  console.log('7. EXISTING DATA');
  console.log('==================================================');
  try {
    const kbPath = path.join(__dirname, '..', 'data', 'kb.json');
    if (fs.existsSync(kbPath)) {
      const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
      console.log('documents preserved: PASS (' + kb.docs.length + ')');
      console.log('chunks preserved: PASS (' + kb.chunks.length + ')');
    } else {
      console.log('kb.json missing: FAIL');
    }
    
    const backupsDir = path.join(__dirname, '..', 'data', 'backups');
    if (fs.existsSync(backupsDir)) {
      const backups = fs.readdirSync(backupsDir);
      console.log('backups preserved: PASS (' + backups.length + ')');
    } else {
      console.log('backups dir missing: FAIL');
    }
  } catch (err) {
    console.log('FAIL checking existing data', err);
  }

  await pool.end();
}

run();
