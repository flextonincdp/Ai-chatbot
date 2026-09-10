const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requireAdmin } = require('../middleware/auth');
const { loadKB, findDuplicateByHash } = require('../lib/kbStore');
const { extractText } = require('../lib/extractText');
const { chunkText } = require('../lib/chunk');
const { getStorageProvider } = require('../lib/storage');
const { getPool, query } = require('../lib/db');
const { getEmbeddingProvider } = require('../lib/embeddings');
const jobQueue = require('../lib/jobs/queue');
const {
  SUPPORTED_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_FILES_PER_UPLOAD,
  validateFile,
  sanitizeFilename,
  computeFileHash,
  buildDocumentMeta,
  migrateLegacyDoc
} = require('../lib/documentMeta');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '..', 'uploads'), limits: { fileSize: 50 * 1024 * 1024 } });
const storage = getStorageProvider();

router.use(requireAdmin);

function computeContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

router.get('/config', (req, res) => {
  res.json({
    supportedExtensions: SUPPORTED_EXTENSIONS,
    maxFileSize: MAX_FILE_SIZE,
    maxFileSizeMB: MAX_FILE_SIZE / (1024 * 1024),
    maxFilesPerUpload: MAX_FILES_PER_UPLOAD
  });
});

router.get('/kb', async (req, res, next) => {
  try {
    const kb = await loadKB();
    const docs = kb.docs.map(d => migrateLegacyDoc(d));
    
    let dbStats = null;
    const pool = getPool();
    if (pool) {
      try {
        const docsCount = await query('SELECT count(*) FROM documents');
        const chunksCount = await query('SELECT count(*) FROM chunks');
        const embeddingsCount = await query('SELECT count(*) FROM embeddings');
        const readyCount = await query(`SELECT count(*) FROM documents WHERE status = 'READY'`);
        const pendingCount = await query(`SELECT count(*) FROM documents WHERE status = 'PENDING_EMBEDDING' OR status = 'EMBEDDING_NOT_CONFIGURED'`);
        const failedCount = await query(`SELECT count(*) FROM documents WHERE status = 'FAILED'`);

        dbStats = {
          documents: parseInt(docsCount.rows[0].count, 10),
          chunks: parseInt(chunksCount.rows[0].count, 10),
          embeddings: parseInt(embeddingsCount.rows[0].count, 10),
          ready: parseInt(readyCount.rows[0].count, 10),
          pending: parseInt(pendingCount.rows[0].count, 10),
          failed: parseInt(failedCount.rows[0].count, 10),
        };
      } catch(err) {
        console.error('Failed to get DB stats:', err);
      }
    }

    res.json({ docs, totalChunks: kb.chunks.length, dbStats });
  } catch (err) {
    console.error('[Admin] Error loading KB:', err);
    res.status(500).json({ error: 'Failed to load knowledge base' });
  }
});

router.post('/upload', upload.array('files', MAX_FILES_PER_UPLOAD), async (req, res) => {
  const log = [];
  const defaultOrgId = 'org_default';
  const pool = getPool();
  
  if (!pool) {
    return res.status(500).json({ error: 'Database pool not configured. Workers require DB.' });
  }

  // Ensure default org exists
  try {
    await query(`INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [defaultOrgId, 'Default Organization']);
  } catch (orgErr) {
    console.error('[Admin] Failed to ensure default organization:', orgErr.message);
    return res.status(500).json({ error: 'Database connection error. Please try again.' });
  }

  for (const file of req.files || []) {
    const safeName = sanitizeFilename(file.originalname);
    const ext = safeName.split('.').pop().toLowerCase();

    // ── Step 1: Validate ──
    const validationErrors = validateFile(file);
    if (validationErrors.length) {
      log.push({ file: safeName, status: 'error', reason: validationErrors.join('; ') });
      fs.unlink(file.path, () => {});
      continue;
    }

    // ── Step 2: Duplicate detection ──
    let hash = null;
    try { hash = computeFileHash(file.path); } catch {}

    if (hash) {
      const existing = await findDuplicateByHash(hash, defaultOrgId);
      if (existing) {
        log.push({
          file: safeName,
          status: 'duplicate',
          reason: 'Document already exists',
          existingDocument: { id: existing.id, name: existing.name }
        });
        fs.unlink(file.path, () => {});
        continue;
      }
    }

    // ── Step 3: Build metadata & Queue ──
    const docMeta = buildDocumentMeta({ file: { ...file, originalname: safeName }, extractionMeta: {}, chunkCount: 0 });
    docMeta.hash = hash;
    docMeta.uploadedBy = req.session.name || 'admin';
    
    const dbStatus = 'QUEUED';
    const storageKey = `${defaultOrgId}/${docMeta.id}/v1/original.${ext}`;

    try {
      await query('BEGIN');
      
      // Upload to storage abstraction first
      await storage.put(file.path, storageKey);

      // Insert document records
      await query(`
        INSERT INTO documents (id, organization_id, original_filename, mime_type, extension, size_bytes, sha256, storage_key, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
      `, [docMeta.id, defaultOrgId, safeName, docMeta.mimeType, ext, docMeta.size, hash, storageKey, dbStatus]);

      const versionId = `${docMeta.id}_v1`;
      await query(`
        INSERT INTO document_versions (id, document_id, version_number, page_count, slide_count, storage_key, sha256, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT DO NOTHING
      `, [versionId, docMeta.id, 1, docMeta.pageCount, docMeta.slideCount, storageKey, hash, dbStatus]);

      // Enqueue job for background processing
      const jobId = `job_${docMeta.id}_${Date.now()}`;
      await jobQueue.enqueue(jobId, docMeta.id, defaultOrgId);
      
      await query('COMMIT');

      log.push({
        file: safeName,
        status: 'queued',
        jobId: jobId,
        document: {
          documentId: docMeta.id,
          filename: safeName,
          type: ext,
          size: docMeta.size,
          status: dbStatus
        }
      });
    } catch (err) {
      await query('ROLLBACK');
      console.error('DB Write Failed:', err);
      log.push({ file: safeName, status: 'error', reason: 'DB insertion failed: ' + err.message });
    } finally {
      fs.unlink(file.path, () => {});
    }
  }

  try {
    const kb = await loadKB(defaultOrgId);
    const docs = kb.docs.map(d => migrateLegacyDoc(d));
    res.json({ success: true, log, docs, totalChunks: kb.chunks.length });
  } catch (err) {
    console.error('[Admin] Error reloading KB after upload:', err);
    res.status(500).json({ error: 'Upload succeeded but failed to reload knowledge base.' });
  }
});

router.delete('/kb/:id', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'DB not configured' });

  try {
    const docRes = await query('SELECT id FROM documents WHERE id = $1', [req.params.id]);
    if (docRes.rowCount === 0) return res.status(404).json({ error: 'Document not found' });

    await query('DELETE FROM documents WHERE id = $1', [req.params.id]);

    const kb = await loadKB();
    const docs = kb.docs.map(d => migrateLegacyDoc(d));
    res.json({ success: true, docs, totalChunks: kb.chunks.length });
  } catch(err) {
    console.error('Failed to delete from DB:', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

module.exports = router;
