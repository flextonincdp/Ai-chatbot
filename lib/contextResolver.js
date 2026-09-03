/**
 * Context Resolver — determines if a query refers to the current conversational context
 * and resolves the most recent meaningful assistant answer.
 */

const RELATIONS = new Set(['CONTINUE', 'TRANSFORM', 'MODIFY', 'REPRESENT', 'DOWNLOAD', 'NEW_TOPIC', 'MULTI_TOPIC', 'NONE']);
const TYPES = new Set(['CURRENT_ANSWER', 'NEW_TOPIC', 'NONE']);
const INTENTS = new Set(['ANSWER', 'SUMMARY', 'CREATE', 'CONVERT', 'VISUALIZE', 'DOWNLOAD', 'CREATE_AND_DOWNLOAD', 'MODIFY']);
const FORMATS = new Set(['PDF', 'DOCX', 'PPTX', 'XLSX', 'CSV', 'SVG', 'TXT', 'MD', 'HTML', 'JSON']);
const VISUAL_TYPES = new Set(['process_flow', 'organization_chart', 'timeline', 'architecture', 'hierarchy', 'comparison', 'decision_tree', 'roadmap', 'mind_map']);
const THEMES = new Set(['professional', 'corporate', 'executive', 'technology', 'finance', 'healthcare', 'education', 'minimal', 'modern', 'technical']);
const PALETTES = new Set(['blue', 'blue_teal', 'navy', 'green', 'purple', 'orange', 'monochrome', 'professional_blue', 'navy_blue', 'corporate_gray', 'executive_black_gold', 'technology_blue', 'finance_green', 'healthcare_blue', 'education_purple', 'minimal_monochrome']);
const TEMPLATES = new Set(['professional_report', 'executive_summary', 'client_report', 'technical_report', 'business_proposal', 'case_study', 'meeting_summary', 'project_report', 'presentation', 'simple_document']);

function tokenize(value) {
  return new Set((value || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

function similarity(left, right) {
  const a = tokenize(left);
  const b = tokenize(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.sqrt(a.size * b.size);
}

function validateSemanticResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const requiredKeys = ['contextRelation', 'contextType', 'resolvedAnswerId', 'resolvedArtifactId', 'intent', 'requestedFormat', 'topic', 'confidence', 'newInformationRequired'];
  const rawKeys = Object.keys(raw);
  const optionalKeys = ['visualType', 'theme', 'palette', 'template', 'outputs'];
  if (!requiredKeys.every(key => Object.prototype.hasOwnProperty.call(raw, key)) ||
      rawKeys.some(key => !requiredKeys.includes(key) && !optionalKeys.includes(key))) return null;
  const result = {
    contextRelation: String(raw.contextRelation || 'NONE').toUpperCase(),
    contextType: String(raw.contextType || 'NONE').toUpperCase(),
    resolvedAnswerId: raw.resolvedAnswerId || null,
    resolvedArtifactId: raw.resolvedArtifactId || null,
    intent: String(raw.intent || 'ANSWER').toUpperCase(),
    requestedFormat: raw.requestedFormat ? String(raw.requestedFormat).toUpperCase() : null,
    topic: typeof raw.topic === 'string' ? raw.topic.trim() : null,
    confidence: Number(raw.confidence),
    newInformationRequired: Boolean(raw.newInformationRequired),
    visualType: raw.visualType ? String(raw.visualType).toLowerCase() : null,
    theme: raw.theme ? String(raw.theme).toLowerCase() : null,
    palette: raw.palette ? String(raw.palette).toLowerCase() : null,
    template: raw.template ? String(raw.template).toLowerCase() : null,
    outputs: raw.outputs && typeof raw.outputs === 'object' && !Array.isArray(raw.outputs)
      ? {
          text_answer: raw.outputs.text_answer !== false,
          diagram: raw.outputs.diagram === true,
          chart: raw.outputs.chart === true
        }
      : undefined
  };
  if (!RELATIONS.has(result.contextRelation) || !TYPES.has(result.contextType) || !INTENTS.has(result.intent)) return null;
  if (result.requestedFormat && !FORMATS.has(result.requestedFormat)) return null;
  if (result.visualType && !VISUAL_TYPES.has(result.visualType)) return null;
  if (result.theme && !THEMES.has(result.theme)) return null;
  if (result.palette && !PALETTES.has(result.palette)) return null;
  if (result.template && !TEMPLATES.has(result.template)) return null;
  if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) return null;
  return result;
}

/**
 * Resolves the most recent meaningful assistant answer from conversation history.
 * Skips download confirmation messages which are not "answers".
 */
function resolveContext(history) {
  if (!history || !history.length) return null;

  const reversed = [...history].reverse();

  // Find the most recent meaningful assistant answer
  const lastAsst = reversed.find(m => {
    if (m.role !== 'assistant') return false;
    if (!m.content) return false;
    // Only a message linked to an Answer record can be reused as knowledge
    // context. Error, clarification, and download-confirmation messages have
    // no answerId and must never become the input to an artifact generator.
    if (!m.answerId) return false;
    // Skip download/retrieval confirmation messages
    if (/^Here is the \w+ you requested/.test(m.content)) return false;
    return true;
  });

  if (lastAsst) {
    return {
      messageId: lastAsst.id,
      answerId: lastAsst.answerId || lastAsst.id,
      answerText: lastAsst.content,
      sourceChunkIds: lastAsst.sourceIds || [],
      sourceDocumentIds: lastAsst.sourceDocIds || [],
    };
  }
  return null;
}

function resolveBestContext(query, history, semanticResult = null) {
  const candidates = (history || []).filter(m => m.role === 'assistant' && m.content && m.answerId && !/^Here is the \w+ you requested/.test(m.content));
  if (!candidates.length) return null;
  if (semanticResult && semanticResult.resolvedAnswerId) {
    // The resolver sees the persisted Answer ID, whereas an older message can
    // also be identified by its message ID. Accept either identity.
    const exact = candidates.find(m => m.id === semanticResult.resolvedAnswerId || m.answerId === semanticResult.resolvedAnswerId);
    if (exact) return resolveContext([exact]);
  }
  if (semanticResult && semanticResult.newInformationRequired) return null;
  // Legacy preflight results only establish continuity. Preserve their
  // existing behavior and use the latest grounded answer.
  if (!semanticResult || !semanticResult.contextRelation) return resolveContext([candidates[candidates.length - 1]]);
  const scored = candidates.map((message, index) => ({
    message,
    score: similarity(`${query} ${semanticResult.topic || ''}`, message.content) * 0.8 + ((index + 1) / candidates.length) * 0.2
  })).sort((a, b) => b.score - a.score);
  if (semanticResult && ['CONTINUE', 'TRANSFORM', 'MODIFY', 'REPRESENT', 'DOWNLOAD'].includes(semanticResult.contextRelation)) {
    return resolveContext([scored[0].score >= 0.3 ? scored[0].message : candidates[candidates.length - 1]]);
  }
  return scored[0].score >= 0.35 ? resolveContext([scored[0].message]) : null;
}

module.exports = { resolveContext, resolveBestContext, validateSemanticResult };
