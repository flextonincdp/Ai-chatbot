const { query } = require('./db');
const crypto = require('crypto');

async function saveContextSnapshot(conversationId, userMessageId, assistantMessageId, snapshot = {}) {
  const id = crypto.randomUUID();
  try {
    await query(
      `INSERT INTO context_snapshots (id, message_id, conversation_id, previous_message_ids, summary_version, document_ids, rag_chunk_ids, chart_ids, artifact_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        assistantMessageId,                                   // FK → messages(id)
        conversationId,                                       // FK → conversations(id)
        JSON.stringify(userMessageId ? [userMessageId] : []), // track the user msg that prompted this
        snapshot.summaryVersion || null,
        JSON.stringify(snapshot.sourceDocumentIds || snapshot.documentIds || []),
        JSON.stringify(snapshot.ragChunkIds || []),
        JSON.stringify(snapshot.chartIds || []),
        JSON.stringify(snapshot.generatedArtifactIds || snapshot.artifactIds || [])
      ]
    );
    return id;
  } catch (err) {
    console.error('[ContextSnapshot] Failed to save snapshot (non-fatal):', err.message);
    return null;  // Don't crash the request over a snapshot failure
  }
}

async function getContextSnapshot(messageId) {
  const res = await query(
    `SELECT * FROM context_snapshots WHERE message_id = $1`,
    [messageId]
  );
  return res.rows[0];
}

async function getLatestContext(conversationId) {
  const res = await query(
    `SELECT * FROM context_snapshots WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
  return res.rows[0];
}

module.exports = {
  saveContextSnapshot,
  getContextSnapshot,
  getLatestContext
};
