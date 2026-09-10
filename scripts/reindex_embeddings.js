/**
 * Reindex Embeddings Script
 * 
 * Finds all chunks in PostgreSQL that do not yet have embeddings
 * (or have embeddings from a different model/version), generates
 * local embeddings using Xenova/all-MiniLM-L6-v2, and stores them
 * in the embeddings table for pgvector similarity search.
 * 
 * Safe to run multiple times — skips chunks that already have valid embeddings.
 * Safe to restart after failure — picks up where it left off.
 * 
 * Usage: npm run embeddings:reindex
 */
require('dotenv').config();
const crypto = require('crypto');
const { initPool, query, closePool } = require('../lib/db');
const { getEmbeddingProvider, initPipeline } = require('../lib/embeddings');

const BATCH_SIZE = 25;  // Process embeddings in batches of 25

async function reindex() {
  console.log('==================================================');
  console.log('EMBEDDING REINDEX');
  console.log('==================================================\n');

  // 1. Initialize DB
  await initPool();

  // 2. Verify existing data is safe
  console.log('[Safety] Verifying existing data...');
  const fs = require('fs');
  const path = require('path');
  
  const kbPath = path.join(__dirname, '..', 'data', 'kb.json');
  if (fs.existsSync(kbPath)) {
    console.log('  kb.json: EXISTS (preserved)');
  }
  
  const backupsDir = path.join(__dirname, '..', 'data', 'backups');
  if (fs.existsSync(backupsDir)) {
    const backups = fs.readdirSync(backupsDir);
    console.log(`  backups: ${backups.length} files (preserved)`);
  }

  // 3. Initialize the local embedding model
  console.log('\n[Model] Loading local embedding model...');
  const provider = getEmbeddingProvider();

  if (!provider.isConfigured()) {
    console.error('[Error] Embedding provider is not configured as "local". Check EMBEDDING_PROVIDER in .env');
    await closePool();
    process.exit(1);
  }

  await initPipeline();
  const info = provider.getEmbeddingInfo();
  console.log(`  Provider: ${info.provider}`);
  console.log(`  Model: ${info.model}`);
  console.log(`  Dimensions: ${info.dimensions}`);
  console.log(`  Distance metric: ${info.distanceMetric}`);
  console.log(`  Version: ${info.version}`);

  // 4. Count total chunks and existing embeddings
  const totalChunksRes = await query('SELECT COUNT(*) FROM chunks');
  const totalChunks = parseInt(totalChunksRes.rows[0].count, 10);

  const existingEmbeddingsRes = await query(
    'SELECT COUNT(*) FROM embeddings WHERE model = $1 AND version = $2',
    [info.model, info.version]
  );
  const existingEmbeddings = parseInt(existingEmbeddingsRes.rows[0].count, 10);

  console.log(`\n[Status] Total chunks: ${totalChunks}`);
  console.log(`[Status] Existing valid embeddings: ${existingEmbeddings}`);
  console.log(`[Status] Chunks needing embeddings: ${totalChunks - existingEmbeddings}`);

  if (existingEmbeddings >= totalChunks) {
    console.log('\n[Done] All chunks already have valid embeddings. Nothing to do.');
    await closePool();
    return;
  }

  // 5. Find chunks without valid embeddings for this model/version
  const chunksToEmbed = await query(`
    SELECT c.id, c.content, c.content_hash
    FROM chunks c
    LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = $1 AND e.version = $2
    WHERE e.id IS NULL
    ORDER BY c.id
  `, [info.model, info.version]);

  const pendingChunks = chunksToEmbed.rows;
  const total = pendingChunks.length;
  console.log(`\n[Reindex] Processing ${total} chunks in batches of ${BATCH_SIZE}...\n`);

  let completed = 0;
  let failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = pendingChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map(c => c.content);

    try {
      // Generate embeddings for the batch
      const embeddings = await provider.generateEmbeddings(texts);

      // Insert each embedding into the database
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const embedding = embeddings[j];
        const vectorStr = `[${embedding.join(',')}]`;
        const embeddingId = `emb_${chunk.id}_${info.version}`;

        await query(`
          INSERT INTO embeddings (id, chunk_id, model, dimensions, version, embedding, created_at)
          VALUES ($1, $2, $3, $4, $5, $6::vector, CURRENT_TIMESTAMP)
          ON CONFLICT (id) DO NOTHING
        `, [
          embeddingId,
          chunk.id,
          info.model,
          info.dimensions,
          info.version,
          vectorStr
        ]);

        completed++;
      }

      // Progress report
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (completed / elapsed * 60).toFixed(0);
      process.stdout.write(`\r  Embedding: ${completed} / ${total}  (${elapsed}s elapsed, ~${rate}/min)`);

    } catch (err) {
      console.error(`\n[Error] Batch starting at index ${i} failed:`, err.message);
      failed += batch.length;
      // Continue with next batch — safe to restart later
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n[Complete] Embedded ${completed} chunks in ${totalElapsed}s. Failed: ${failed}.`);

  // 6. Verify final counts
  const finalEmbeddingsRes = await query('SELECT COUNT(*) FROM embeddings');
  const finalEmbeddings = parseInt(finalEmbeddingsRes.rows[0].count, 10);

  console.log(`\n==================================================`);
  console.log(`FINAL STATUS`);
  console.log(`==================================================`);
  console.log(`Documents: ${(await query('SELECT COUNT(*) FROM documents')).rows[0].count}`);
  console.log(`Chunks: ${totalChunks}`);
  console.log(`Embeddings: ${finalEmbeddings}`);
  console.log(`Model: ${info.model}`);
  console.log(`Dimensions: ${info.dimensions}`);
  console.log(`==================================================`);

  // 7. Create pgvector index if it doesn't exist (only after successful population)
  if (finalEmbeddings > 0 && failed === 0) {
    console.log('\n[Index] Creating pgvector cosine index...');
    try {
      await query(`
        CREATE INDEX IF NOT EXISTS idx_embeddings_vector 
        ON embeddings 
        USING ivfflat (embedding vector_cosine_ops) 
        WITH (lists = ${Math.max(1, Math.floor(Math.sqrt(finalEmbeddings)))})
      `);
      console.log('[Index] IVFFlat cosine index created successfully.');
    } catch (err) {
      console.error('[Index] Index creation failed (non-fatal):', err.message);
    }
  }

  await closePool();
}

reindex().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
