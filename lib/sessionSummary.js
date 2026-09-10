const { query } = require('./db');
const crypto = require('crypto');
const { callClaude } = require('./claude');

async function getSummary(conversationId) {
  const res = await query(`SELECT * FROM session_summaries WHERE conversation_id = $1 ORDER BY version DESC LIMIT 1`, [conversationId]);
  return res.rows[0];
}

async function updateSummary(conversationId, messages) {
  const currentSummary = await getSummary(conversationId);
  const nextVersion = currentSummary ? currentSummary.version + 1 : 1;
  try {
    // Callers that have already generated a constrained summary pass its text
    // directly. This prevents a second unconstrained LLM call and guarantees
    // only a validated grounded turn can enter summary persistence.
    let summaryText = typeof messages === 'string' ? messages.trim() : '';
    if (!summaryText) {
      const { buildSummaryPrompt } = require('./claude');
      const prompt = buildSummaryPrompt(messages || [], currentSummary ? currentSummary.summary_text : null);
      summaryText = await callClaude(prompt, 500);
    }
    if (!summaryText) return null;
    const id = crypto.randomUUID();

    await query(
      `INSERT INTO session_summaries (id, conversation_id, summary_text, version) VALUES ($1, $2, $3, $4)`,
      [id, conversationId, summaryText, nextVersion]
    );
    return { id, conversation_id: conversationId, summary_text: summaryText, version: nextVersion };
  } catch (err) {
    console.error('Failed to generate summary:', err);
    return null;
  }
}

async function shouldUpdateSummary(conversationId) {
  const currentSummary = await getSummary(conversationId);
  const version = currentSummary ? currentSummary.version : 0;
  
  const msgRes = await query(`SELECT COUNT(*) FROM messages WHERE conversation_id = $1`, [conversationId]);
  const messageCount = parseInt(msgRes.rows[0].count, 10);
  
  const threshold = version * 8;
  return messageCount >= threshold + 8;
}

module.exports = {
  getSummary,
  updateSummary,
  shouldUpdateSummary
};
