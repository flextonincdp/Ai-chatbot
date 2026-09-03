/**
 * Document Processing Background Worker
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const queue = require('./queue');
const { query } = require('../db');
const { extractText } = require('../extractText');
const { chunkText } = require('../chunk');
const { getEmbeddingProvider } = require('../embeddings');
const { embedLimiter, AsyncSemaphore } = require('../concurrency');
const { loadKB, saveKB } = require('../kbStore'); // Legacy compat

const maxWorkers = parseInt(process.env.MAX_CONCURRENT_DOCUMENT_JOBS || '2', 10);
const embedBatchSize = parseInt(process.env.EMBEDDING_BATCH_SIZE || '25', 10);
const jobLimiter = new AsyncSemaphore(maxWorkers);

let isRunning = false;

function computeContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function processJob(job) {
  const { id: jobId, document_id: docId, organization_id: orgId } = job;
  console.log(`[Worker] Started job ${jobId} for document ${docId}`);

  try {
    // 1. Get document details
    const docRes = await query(`
      SELECT original_filename, storage_key, extension, status 
      FROM documents WHERE id = $1
    `, [docId]);

    if (docRes.rowCount === 0) throw new Error('Document not found in DB');
    const doc = docRes.rows[0];

    // Download original file path (we're using local storage right now)
    const filePath = path.join(__dirname, '..', '..', 'uploads', doc.storage_key);

    // 2. EXTRACTING TEXT
    await queue.updateStatus(jobId, 'EXTRACTING_TEXT');
    await query(`UPDATE documents SET status = 'EXTRACTING_TEXT' WHERE id = $1`, [docId]);
    await query(`UPDATE document_versions SET status = 'EXTRACTING_TEXT' WHERE document_id = $1`, [docId]);

    const progressCallback = async (progressInfo) => {
      const rawSt = progressInfo.status || 'OCR_PROCESSING';
      const st = rawSt.length > 30 ? rawSt.substring(0, 30) : rawSt;
      await queue.updateStatus(jobId, st);
      await query(`UPDATE documents SET status = $1 WHERE id = $2`, [st, docId]);
      await query(`UPDATE document_versions SET status = $1 WHERE document_id = $2`, [st, docId]);
    };

    const extractResult = await extractText(filePath, doc.original_filename, progressCallback);
    const text = extractResult.text;
    if (!text || !text.trim()) {
      throw new Error('No extractable text');
    }

    // 3. CHUNKING
    await queue.updateStatus(jobId, 'CHUNKING');
    await query(`UPDATE documents SET status = 'CHUNKING' WHERE id = $1`, [docId]);
    await query(`UPDATE document_versions SET status = 'CHUNKING' WHERE document_id = $1`, [docId]);

    const pieces = chunkText(text);
    if (!pieces.length) throw new Error('Text too short to form chunks');

    const versionId = `${docId}_v1`;
    
    // Ensure chunks are inserted
    for (let i = 0; i < pieces.length; i++) {
      const chunkId = `${versionId}_chunk_${i}`;
      const contentHash = computeContentHash(pieces[i]);
      await query(`
        INSERT INTO chunks (id, document_version_id, chunk_index, content, content_hash)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
      `, [chunkId, versionId, i, pieces[i], contentHash]);
    }

    // 4. EMBEDDING
    const provider = getEmbeddingProvider();
    if (provider.isConfigured()) {
      await queue.updateStatus(jobId, 'EMBEDDING');
      await query(`UPDATE documents SET status = 'EMBEDDING' WHERE id = $1`, [docId]);
      await query(`UPDATE document_versions SET status = 'EMBEDDING' WHERE document_id = $1`, [docId]);

      const info = provider.getEmbeddingInfo();

      // Find chunks that need embeddings
      const pendingChunksRes = await query(`
        SELECT c.id, c.content
        FROM chunks c
        LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = $1 AND e.version = $2
        WHERE c.document_version_id = $3 AND e.id IS NULL
        ORDER BY c.chunk_index ASC
      `, [info.model, info.version, versionId]);

      const pendingChunks = pendingChunksRes.rows;
      
      // Batch embedding generation under semaphore limit
      for (let i = 0; i < pendingChunks.length; i += embedBatchSize) {
        const batch = pendingChunks.slice(i, i + embedBatchSize);
        const texts = batch.map(c => c.content);

        // Limit concurrent model access
        const embeddings = await embedLimiter.run(async () => {
          return await provider.generateEmbeddings(texts);
        });

        // Insert embeddings
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const embedding = embeddings[j];
          const vectorStr = `[${embedding.join(',')}]`;
          const embId = `emb_${chunk.id}_${info.version}`;

          await query(`
            INSERT INTO embeddings (id, chunk_id, model, dimensions, version, embedding)
            VALUES ($1, $2, $3, $4, $5, $6::vector)
            ON CONFLICT (id) DO NOTHING
          `, [embId, chunk.id, info.model, provider.getDimensions(), info.version, vectorStr]);
        }
      }
    }

    // 5. INDEXING & READY
    await queue.updateStatus(jobId, 'INDEXING');
    
    // Legacy KB compatibility update (if still used by frontend)
    const kb = loadKB();
    const legacyDocIdx = kb.docs.findIndex(d => (d.id || d.documentId) === docId);
    if (legacyDocIdx >= 0) {
      kb.docs[legacyDocIdx].status = 'READY';
      kb.docs[legacyDocIdx].chunkCount = pieces.length;
      kb.docs[legacyDocIdx].processingError = null;
      if (extractResult.metadata) {
        kb.docs[legacyDocIdx].pageCount = extractResult.metadata.pageCount;
        kb.docs[legacyDocIdx].slideCount = extractResult.metadata.slideCount;
        kb.docs[legacyDocIdx].unitLabel = extractResult.metadata.unitLabel;
        kb.docs[legacyDocIdx].extractionMethod = extractResult.metadata.extractionMethod;
        kb.docs[legacyDocIdx].ocrStatus = extractResult.metadata.ocrStatus;
        kb.docs[legacyDocIdx].processingDurationMs = extractResult.metadata.processingDurationMs;
      }
      // Append chunks if missing
      pieces.forEach((p, idx) => {
        if (!kb.chunks.some(c => c.id === `${docId}_${idx}`)) {
          kb.chunks.push({ id: `${docId}_${idx}`, docId, docName: doc.original_filename, text: p });
        }
      });
      saveKB(kb);
    }

    await queue.updateStatus(jobId, 'READY');
    await query(`UPDATE documents SET status = 'READY' WHERE id = $1`, [docId]);
    await query(`UPDATE document_versions SET status = 'READY' WHERE document_id = $1`, [docId]);

    console.log(`[Worker] Job ${jobId} completed successfully.`);

  } catch (err) {
    console.error(`[Worker] Job ${jobId} encountered error:`, err.message);
    await query(`UPDATE documents SET status = 'FAILED' WHERE id = $1`, [docId]);
    await query(`UPDATE document_versions SET status = 'FAILED' WHERE document_id = $1`, [docId]);
    
    // Retry logic
    await queue.retry(jobId, err.message);
    
    // Legacy compat
    const kb = loadKB();
    const legacyDocIdx = kb.docs.findIndex(d => (d.id || d.documentId) === docId);
    if (legacyDocIdx >= 0) {
      kb.docs[legacyDocIdx].status = 'FAILED';
      kb.docs[legacyDocIdx].processingError = err.message;
      saveKB(kb);
    }
  }
}

async function loop() {
  if (!isRunning) return;

  try {
    // We try to acquire a worker slot. If maxWorkers is full, this will wait.
    await jobLimiter.acquire();
    
    const job = await queue.dequeue('worker-node-1');
    if (job) {
      // Process asynchronously so we can immediately pull another job if slots are free
      processJob(job)
        .finally(() => {
          jobLimiter.release();
          // Immediately try to loop again since we just finished a job
          setImmediate(loop);
        });
    } else {
      // No jobs in queue, release the slot and sleep
      jobLimiter.release();
      setTimeout(loop, 2000); // Check every 2 seconds
    }
  } catch (err) {
    console.error('[Worker] Queue polling error:', err);
    jobLimiter.release();
    setTimeout(loop, 5000);
  }
}

function startWorker() {
  if (isRunning) return;
  isRunning = true;
  console.log(`[Worker] Starting document processor loop (concurrency: ${maxWorkers})...`);
  // Start up to maxWorkers polling loops independently
  for(let i = 0; i < maxWorkers; i++) {
    loop();
  }
}

function stopWorker() {
  isRunning = false;
  console.log('[Worker] Stopped polling for new jobs.');
}

module.exports = { startWorker, stopWorker };
