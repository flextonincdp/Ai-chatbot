const { getPool, query } = require('./db');

/**
 * Knowledge Base Store (PostgreSQL Backed)
 * Replaces the old file-based kb.json implementation.
 */

async function loadKB(orgId = 'org_default') {
  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool not configured.');
  }

  try {
    // Load documents WITH page_count from versions and chunk_count from chunks
    const docsRes = await query(`
      SELECT d.*,
        dv.page_count,
        dv.slide_count,
        COALESCE(cc.chunk_count, 0) AS chunk_count
      FROM documents d
      LEFT JOIN document_versions dv ON dv.document_id = d.id
      LEFT JOIN (
        SELECT dv2.document_id, count(c.id)::int AS chunk_count
        FROM chunks c
        JOIN document_versions dv2 ON c.document_version_id = dv2.id
        GROUP BY dv2.document_id
      ) cc ON cc.document_id = d.id
      WHERE d.organization_id = $1
    `, [orgId]);
    
    // Map to the expected legacy format for compatibility
    const docs = docsRes.rows.map(row => ({
      id: row.id,
      documentId: row.id,
      originalFilename: row.original_filename,
      name: row.original_filename,
      extension: row.extension,
      type: row.extension,
      mimeType: row.mime_type,
      size: row.size_bytes,
      hash: row.sha256,
      status: row.status,
      pageCount: row.page_count || null,
      slideCount: row.slide_count || null,
      unitLabel: row.slide_count ? 'slides' : (row.page_count ? 'pages' : 'document'),
      chunkCount: row.chunk_count || 0,
      processingStatus: row.status === 'READY' ? 'completed' : 'processing',
      indexingStatus: row.status === 'READY' ? 'completed' : 'processing',
      uploadedAt: row.created_at ? row.created_at.getTime() : Date.now(),
      processedAt: row.updated_at ? row.updated_at.getTime() : Date.now(),
      uploadedBy: 'admin',
      processingError: null
    }));

    // For missing properties (pageCount, chunkCount), we can fetch aggregate data if needed,
    // but the critical properties are id, name, and status.

    // Load chunks
    const chunksRes = await query(`
      SELECT c.id, c.chunk_index AS "chunkIndex", c.metadata, c.content AS text,
        d.id AS "docId", d.original_filename AS "docName"
      FROM chunks c
      JOIN document_versions dv ON c.document_version_id = dv.id
      JOIN documents d ON dv.document_id = d.id
      WHERE d.organization_id = $1 AND d.status = 'READY'
    `, [orgId]);

    const chunks = chunksRes.rows;

    return { docs, chunks };
  } catch (err) {
    console.error('[kbStore] Failed to load KB from PostgreSQL:', err);
    throw err;
  }
}

async function findDuplicateByHash(hash, orgId = 'org_default') {
  if (!hash) return null;
  const pool = getPool();
  if (!pool) return null;

  try {
    const res = await query(
      `SELECT id, original_filename AS name FROM documents WHERE sha256 = $1 AND organization_id = $2 LIMIT 1`,
      [hash, orgId]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('[kbStore] Failed to check duplicate by hash:', err);
    return null;
  }
}

// Stubs for removed functions so we don't crash before all routes are updated
function saveKB(kb) {
  // No-op: PostgreSQL is the single source of truth.
  // Saving is handled per-record via specific DB queries.
}

function backupKB() {
  // No-op: Backups should be handled via pg_dump
}

module.exports = {
  loadKB,
  findDuplicateByHash,
  saveKB,
  backupKB
};
