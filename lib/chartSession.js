const { query } = require('./db');
const crypto = require('crypto');

async function createChart(conversationId, sourceMessageId, title, chartType, config, data) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO charts (id, conversation_id, source_message_id, title, chart_type, config, data, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, conversationId, sourceMessageId, title, chartType, JSON.stringify(config), JSON.stringify(data), 1]
  );
  return id;
}

async function getCharts(conversationId) {
  const res = await query(
    `SELECT * FROM charts WHERE conversation_id = $1 ORDER BY created_at DESC`,
    [conversationId]
  );
  return res.rows;
}

async function getLatestChart(conversationId) {
  const res = await query(
    `SELECT * FROM charts WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
  return res.rows[0];
}

async function getChart(chartId) {
  const res = await query(
    `SELECT * FROM charts WHERE id = $1`,
    [chartId]
  );
  return res.rows[0];
}

async function updateChart(chartId, newConfig, newData) {
  const chart = await getChart(chartId);
  if (!chart) return null;
  
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO charts (id, conversation_id, source_message_id, title, chart_type, config, data, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, chart.conversation_id, chart.source_message_id, chart.title, chart.chart_type, JSON.stringify(newConfig), JSON.stringify(newData), chart.version + 1]
  );
  return id;
}

async function deleteChart(chartId) {
  await query(`DELETE FROM charts WHERE id = $1`, [chartId]);
}

module.exports = {
  createChart,
  getCharts,
  getLatestChart,
  getChart,
  updateChart,
  deleteChart
};
