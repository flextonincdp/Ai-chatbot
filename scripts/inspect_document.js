// Read-only PostgreSQL inspection for a processed document version.
require('dotenv').config();
const { initPool, query, closePool } = require('../lib/db');

async function main() {
  const phraseFlag = process.argv.indexOf('--');
  const match = process.argv.slice(2, phraseFlag === -1 ? undefined : phraseFlag).join(' ').trim();
  if (!match) throw new Error('Usage: node scripts/inspect_document.js <document name fragment>');
  await initPool();
  const documents = await query(
    `SELECT d.id, d.original_filename, d.status, COUNT(c.id)::int AS chunk_count,
       (SELECT COUNT(*)::int FROM embeddings e JOIN chunks ec ON ec.id = e.chunk_id JOIN document_versions ev ON ev.id = ec.document_version_id WHERE ev.document_id = d.id) AS embedding_count
     FROM documents d LEFT JOIN document_versions dv ON dv.document_id = d.id LEFT JOIN chunks c ON c.document_version_id = dv.id
     WHERE d.original_filename ILIKE $1 OR d.id ILIKE $1 GROUP BY d.id, d.original_filename, d.status`, [`%${match}%`]
  );
  for (const document of documents.rows) {
    const chunks = await query(`SELECT chunk_index, content FROM chunks WHERE document_version_id = $1 ORDER BY chunk_index`, [`${document.id}_v1`]);
    const invalid = chunks.rows.filter(row => /knowledge studio page\s+\d+|data:image|[a-z0-9+/=]{160,}|\\\./i.test(row.content));
    const phrase = phraseFlag === -1 ? '' : process.argv.slice(phraseFlag + 1).join(' ').trim();
    const matches = phrase ? chunks.rows.filter(row => row.content.toLowerCase().includes(phrase.toLowerCase())).slice(0, 5).map(row => row.content.slice(0, 500)) : [];
    console.log(JSON.stringify({ ...document, invalidChunkCount: invalid.length, samples: chunks.rows.slice(0, 4).map(row => row.content.slice(0, 240)), matches }, null, 2));
  }
  await closePool();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
