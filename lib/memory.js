const { query } = require('./db');
const crypto = require('crypto');

async function createConversation(userIdentifier = 'anonymous', organizationId = 'org_default') {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO conversations (id, user_identifier, organization_id) VALUES ($1, $2, $3)`,
    [id, userIdentifier, organizationId]
  );
  return id;
}

async function getConversation(id) {
  const res = await query(`SELECT * FROM conversations WHERE id = $1`, [id]);
  return res.rows[0];
}

async function listConversations(userId, orgId, limit = 50) {
  const res = await query(
    `SELECT * FROM conversations
     WHERE user_identifier = $1 AND organization_id = $2
     ORDER BY is_pinned DESC, updated_at DESC
     LIMIT $3`,
    [userId, orgId, limit]
  );
  return res.rows;
}

async function updateConversationState(conversationId, { lastMessageId, lastChartId, title, isPinned }) {
  const updates = [];
  const values = [conversationId];
  let i = 2;
  
  if (lastMessageId !== undefined) {
    updates.push(`last_message_id = $${i++}`);
    values.push(lastMessageId);
  }
  if (lastChartId !== undefined) {
    updates.push(`last_chart_id = $${i++}`);
    values.push(lastChartId);
  }
  if (title !== undefined) {
    updates.push(`title = $${i++}`);
    values.push(title);
  }
  if (isPinned !== undefined) {
    updates.push(`is_pinned = $${i++}`);
    values.push(Boolean(isPinned));
  }
  
  if (updates.length > 0) {
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    const sql = `UPDATE conversations SET ${updates.join(', ')} WHERE id = $1`;
    await query(sql, values);
  }
}

async function addMessage(conversationId, role, content, sourceIds = [], artifactIds = [], sourceDocumentIds = [], answerId = null) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO messages (id, conversation_id, role, content, source_ids, artifact_ids, source_document_ids, answer_id) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, conversationId, role, content, JSON.stringify(sourceIds), JSON.stringify(artifactIds), JSON.stringify(sourceDocumentIds), answerId]
  );
  // A fresh conversation receives a useful default title from its first user
  // message, while an explicit user rename is never overwritten.
  await query(
    `UPDATE conversations
     SET last_message_id = $2,
         updated_at = CURRENT_TIMESTAMP,
         title = CASE
           WHEN $4 = 'user' AND (title IS NULL OR BTRIM(title) = '')
             THEN LEFT(BTRIM($3), 80)
           ELSE title
         END
     WHERE id = $1`,
    [conversationId, id, String(content || ''), role]
  );
  return id;
}

async function getMessages(conversationId, limit = 100) {
  const res = await query(
    // Select the newest messages first, then restore chronological order for
    // callers. The previous ASC/LIMIT query returned the first messages in a
    // long conversation, so an export request could miss the answer directly
    // above it and incorrectly start a new knowledge search.
    `SELECT * FROM (
       SELECT * FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC
       LIMIT $2
     ) AS recent_messages
     ORDER BY created_at ASC`,
    [conversationId, limit]
  );
  return res.rows.map(row => ({
    id: row.id,
    answerId: row.answer_id || null,
    role: row.role,
    content: row.content,
    sourceIds: row.source_ids || [],
    sourceDocIds: row.source_document_ids || [],
    artifactIds: row.artifact_ids || [],
    createdAt: row.created_at
  }));
}

async function attachArtifactsToMessage(artifactIds, sourceMessageId) {
  if (!sourceMessageId || !artifactIds || artifactIds.length === 0) return;
  await query(
    `UPDATE artifacts SET source_message_id = $2 WHERE id = ANY($1::varchar[])`,
    [artifactIds, sourceMessageId]
  );
}

async function addAnswer(conversationId, organizationId, userMessageId, answerText, sourceDocumentIds = [], sourceChunkIds = [], topic = null, id = crypto.randomUUID()) {
  await query(
    `INSERT INTO answers (id, conversation_id, organization_id, user_message_id, answer_text, source_document_ids, source_chunk_ids, topic)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, conversationId, organizationId, userMessageId, answerText, JSON.stringify(sourceDocumentIds), JSON.stringify(sourceChunkIds), topic]
  );
  return id;
}

async function getAnswer(id, organizationId) {
  const result = await query(`SELECT * FROM answers WHERE id = $1 AND organization_id = $2`, [id, organizationId]);
  const row = result.rows[0];
  return row ? { answerId: row.id, conversationId: row.conversation_id, organizationId: row.organization_id, userMessageId: row.user_message_id, answerText: row.answer_text, sourceDocumentIds: row.source_document_ids || [], sourceChunkIds: row.source_chunk_ids || [], topic: row.topic, createdAt: row.created_at } : null;
}

async function addArtifact(conversationId, sourceAnswerId, sourceDocumentIds, sourceChunkIds, format, generationPlan, validatedData, storageKey = null, organizationId = 'org_default', metadata = {}) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO artifacts (id, conversation_id, organization_id, source_answer_id, source_document_ids, source_chunk_ids, format, generation_plan, validated_data, storage_key, filename, mime_type, size_bytes, storage_provider, storage_bucket)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [id, conversationId, organizationId, sourceAnswerId, JSON.stringify(sourceDocumentIds), JSON.stringify(sourceChunkIds), format, JSON.stringify(generationPlan), JSON.stringify(validatedData), storageKey, metadata.filename || null, metadata.mimeType || null, metadata.sizeBytes || null, metadata.storageProvider || process.env.OBJECT_STORAGE_PROVIDER || 'local', metadata.storageBucket || null]
  );
  return id;
}

async function getArtifacts(conversationId, limit = 10) {
  const res = await query(
    `SELECT * FROM artifacts WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [conversationId, limit]
  );
  return res.rows.map(row => ({
    id: row.id,
    sourceAnswerId: row.source_answer_id,
    sourceMessageId: row.source_message_id || null,
    sourceDocumentIds: row.source_document_ids || [],
    sourceChunkIds: row.source_chunk_ids || [],
    format: row.format,
    generationPlan: row.generation_plan,
    validatedData: row.validated_data,
    storageKey: row.storage_key,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storageProvider: row.storage_provider,
    storageBucket: row.storage_bucket,
    createdAt: row.created_at
  }));
}

module.exports = {
  createConversation,
  getConversation,
  listConversations,
  updateConversationState,
  addMessage,
  addAnswer,
  getAnswer,
  getMessages,
  attachArtifactsToMessage,
  addArtifact,
  getArtifacts
};
