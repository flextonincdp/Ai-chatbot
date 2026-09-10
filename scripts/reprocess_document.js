// Requeue one or more existing documents for deterministic extraction,
// replacement chunking, and embedding regeneration. It never creates a JSON
// fallback and relies on the worker's transactional document-version flow.
require('dotenv').config();
const crypto = require('crypto');
const { initPool, query, closePool } = require('../lib/db');

async function main() {
  const match = process.argv.slice(2).join(' ').trim();
  if (!match) throw new Error('Usage: node scripts/reprocess_document.js <document name fragment>');
  await initPool();
  const result = await query(
    `SELECT d.id, d.organization_id, d.original_filename, d.status, COUNT(c.id)::int AS old_chunk_count
     FROM documents d
     LEFT JOIN document_versions dv ON dv.document_id = d.id
     LEFT JOIN chunks c ON c.document_version_id = dv.id
     WHERE d.original_filename ILIKE $1
     GROUP BY d.id, d.organization_id, d.original_filename, d.status`,
    [`%${match}%`]
  );
  if (!result.rows.length) throw new Error(`No document matches "${match}".`);
  for (const document of result.rows) {
    const jobId = crypto.randomUUID();
    await query(`UPDATE documents SET status = 'QUEUED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [document.id]);
    await query(`UPDATE document_versions SET status = 'QUEUED', updated_at = CURRENT_TIMESTAMP WHERE document_id = $1`, [document.id]);
    await query(
      `INSERT INTO document_jobs (id, document_id, organization_id, status)
       VALUES ($1, $2, $3, 'QUEUED')`,
      [jobId, document.id, document.organization_id]
    );
    console.log(JSON.stringify({ documentId: document.id, document: document.original_filename, oldChunkCount: document.old_chunk_count, jobId }));
  }
  await closePool();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
