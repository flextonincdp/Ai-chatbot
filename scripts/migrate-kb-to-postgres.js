require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initPool, query, closePool } = require('../lib/db');
const crypto = require('crypto');

function computeHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function migrate() {
  await initPool();
  
  const kbPath = path.join(__dirname, '..', 'data', 'kb.json');
  console.log('[Migrate] Loading existing kb.json from:', kbPath);
  
  if (!fs.existsSync(kbPath)) {
    console.log('[Migrate] No kb.json found. Nothing to migrate.');
    await closePool();
    return;
  }

  let kb;
  try {
    const data = fs.readFileSync(kbPath, 'utf8');
    kb = JSON.parse(data);
  } catch (err) {
    console.error('[Migrate] Failed to parse kb.json:', err.message);
    await closePool();
    return;
  }
  
  if (!kb || !kb.docs || kb.docs.length === 0) {
    console.log('[Migrate] kb.json is empty. No documents to migrate.');
    await closePool();
    return;
  }

  // 1. Create default organization
  const defaultOrgId = 'org_default';
  await query(`
    INSERT INTO organizations (id, name)
    VALUES ($1, $2)
    ON CONFLICT (id) DO NOTHING
  `, [defaultOrgId, 'Default Organization']);
  
  let totalDocs = 0;
  let totalChunks = 0;
  
  for (const doc of kb.docs) {
    const docId = doc.id || doc.documentId;
    
    console.log(`[Migrate] Processing document: ${doc.name || doc.originalFilename}`);
    
    // Insert document
    await query(`
      INSERT INTO documents (id, organization_id, original_filename, mime_type, extension, size_bytes, sha256, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0), to_timestamp($10 / 1000.0))
      ON CONFLICT (id) DO NOTHING
    `, [
      docId,
      defaultOrgId,
      doc.name || doc.originalFilename,
      doc.mimeType || 'application/octet-stream',
      doc.extension || doc.type || 'unknown',
      doc.size || 0,
      doc.hash || null,
      'READY',
      doc.uploadedAt || Date.now(),
      doc.uploadedAt || Date.now()
    ]);
    totalDocs++;

    // Insert document version
    const versionId = `${docId}_v1`;
    await query(`
      INSERT INTO document_versions (id, document_id, version_number, page_count, slide_count, sha256, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0))
      ON CONFLICT (id) DO NOTHING
    `, [
      versionId,
      docId,
      1,
      doc.pageCount || null,
      doc.slideCount || null,
      doc.hash || null,
      'READY',
      doc.uploadedAt || Date.now(),
      doc.uploadedAt || Date.now()
    ]);
    
    // Get chunks for this doc
    const docChunks = kb.chunks.filter(c => c.docId === docId);
    
    for (let i = 0; i < docChunks.length; i++) {
      const chunk = docChunks[i];
      const chunkId = chunk.id || `${versionId}_chunk_${i}`;
      const contentHash = computeHash(chunk.text);
      
      // Insert chunk
      await query(`
        INSERT INTO chunks (id, document_version_id, chunk_index, content, content_hash)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO NOTHING
      `, [chunkId, versionId, i, chunk.text, contentHash]);
      totalChunks++;
    }
  }

  console.log(`[Migrate] Complete! Migrated ${totalDocs} documents, ${totalChunks} chunks.`);
  await closePool();
}

migrate().catch(err => {
  console.error('[Migrate] Fatal error:', err);
  process.exit(1);
});
