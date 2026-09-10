const express = require('express');
const crypto = require('crypto');
const { requireUser } = require('../middleware/auth');
const { loadKB } = require('../lib/kbStore');
const { retrieveTopChunks, selectRelevantChunks, validateAnswerGrounding, orderChunksForPresentation, requestedParentHeading } = require('../lib/retrieval');
const { callClaude, buildGroundedPrompt, buildExportPrompt, buildSvgConfigPrompt, buildIntentPrompt, QuotaExhaustedError } = require('../lib/claude');
const { generateFile, normalizeExportMarkdown } = require('../lib/fileGenerators');
const { getExplicitWordCount, applyWordCountLimit } = require('../lib/responseConstraints');
const { resolveBestContext, validateSemanticResult } = require('../lib/contextResolver');
const { detectLocalContextIntent, shouldBypassRetrieval } = require('../lib/anaphoraResolver');
const { generateProfessionalTitle, validateAndFixTitle } = require('../lib/titleGenerator');
const { generateSvg } = require('../lib/svgGenerator/generator');
const { chatLimiter, llmLimiter } = require('../lib/concurrency');
const memory = require('../lib/memory');
const { getStorageProvider } = require('../lib/storage');
const { getPool, query } = require('../lib/db');
const { getSummary, updateSummary, shouldUpdateSummary } = require('../lib/sessionSummary');
const { createChart, getCharts, getLatestChart, getChart, updateChart, deleteChart } = require('../lib/chartSession');
const { saveContextSnapshot, getContextSnapshot, getLatestContext } = require('../lib/contextSnapshot');
const { hasChartReference } = require('../lib/contextResolver');

async function getActiveDocumentText(documentId, orgId) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const res = await pool.query(`
      SELECT c.content AS text FROM chunks c
      JOIN document_versions dv ON c.document_version_id = dv.id
      JOIN documents d ON dv.document_id = d.id
      WHERE d.id = $1 AND d.organization_id = $2 AND dv.status = 'READY'
      ORDER BY c.chunk_index ASC
    `, [documentId, orgId]);
    return res.rows.map(r => r.text).join('\n\n') || null;
  } catch (err) {
    console.error('[Chat] Failed to get active document text:', err);
    return null;
  }
}

const storage = getStorageProvider();

const router = express.Router();
router.use(requireUser);

/**
 * Turns flattened OCR/source text such as
 * "Core Features 1. Access 2. Search" into real Markdown blocks.  The
 * fallback path must never return a wall of inline headings simply because a
 * source document omitted line breaks between its numbered sections.
 */
function formatInlineNumberedSections(text, headingLevel = '###') {
  const original = String(text || '');
  // Keep genuine Markdown intact. This helper is only for text that OCR has
  // flattened into a single paragraph; reflowing an existing document would
  // merge its title, source, and list blocks together.
  if (/(^|\r?\n)\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+)/m.test(original)) return null;

  const compact = original.replace(/\s+/g, ' ').trim();
  if (!compact || /<\/?[a-z][^>]*>/i.test(compact)) return null;

  const matches = [...compact.matchAll(/(?:^|\s)(\d{1,2})\.\s+(?=[A-Z])/g)];
  // A single number may be part of normal prose. Treat it as a list only when
  // the source clearly contains a numbered series.
  if (matches.length < 2) return null;

  const lead = compact.slice(0, matches[0].index).trim();
  if (lead.length > 100) return null;

  const items = matches.map((match, index) => {
    const contentStart = match.index + match[0].length;
    const contentEnd = index + 1 < matches.length ? matches[index + 1].index : compact.length;
    const content = compact.slice(contentStart, contentEnd).replace(/\s+\d+\.\s*$/, '').trim();
    return `${match[1]}. ${content}`;
  }).filter(item => item.length > 3);

  if (items.length < 2) return null;
  return `${lead ? `${headingLevel} ${lead}\n\n` : ''}${items.join('\n')}`;
}

/**
 * Builds structured document content from a previous answer text (first-class source).
 * Falls back to cleaned RAG chunks only if no answer is available.
 * NEVER returns raw chunk dumps or system messages.
 */
function buildFallbackContent(query, answerText, chunks, scopeHeading = null) {
  // Always prefer the current answer text — it's already grounded and structured
  if (answerText && answerText.trim().length > 50) {
    // Strip HTML tags for document markdown
    const stripped = answerText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Derive title from first heading or query topic
    const headingMatch = answerText.match(/<h[23][^>]*>([^<]+)<\/h[23]>/i);
    const title = generateProfessionalTitle(query, {}, query);
    return `# ${title}\n\n${stripped}`;
  }
  // Fallback: structured chunk content (cleaned, not raw)
  return buildFallbackContentFromChunks(query, chunks, scopeHeading);
}

// Build document content directly from RAG chunks when the LLM is unavailable.
function buildFallbackContentFromChunks(query, chunks, scopeHeading = null) {
  // Derive a professional title from source documents, NOT the user's raw command
  const docNames = [...new Set(chunks.map(c => c.docName || 'Source').filter(Boolean))];
  const documentSubject = String(docNames[0] || 'Document')
    .replace(/\.[^.]+$/, '')
    .replace(/\s*\(autorecovered\).*$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
    .trim() || 'Document';
  // Export titles should describe the content, not expose an uploaded filename
  // such as "Case studies (AutoRecovered) (3).docx" as a report heading.
  const title = scopeHeading || generateProfessionalTitle(documentSubject, {}, query);
  let md = `# ${title}\n\n`;
  
  // Deduplicate and group chunks by source document and page
  const byDoc = {};
  const seenParagraphs = new Set();

  for (const c of chunks) {
    const docName = c.docName || 'Source';
    const pageNum = (c.metadata && c.metadata.page) ? c.metadata.page : null;
    
    if (!byDoc[docName]) byDoc[docName] = [];
    
    const paragraphs = c.text
      .replace(new RegExp(`^#{1,6}\\s+${String(scopeHeading || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'gmi'), '')
      .split(/\n{2,}/);
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (!trimmed || trimmed.length < 10) continue; // Skip very short or empty lines
      
      const hash = trimmed.substring(0, 50).toLowerCase();
      if (seenParagraphs.has(hash)) continue;
      seenParagraphs.add(hash);
      
      byDoc[docName].push({ text: trimmed, page: pageNum });
    }
  }
  
  const sourceDocNames = Object.keys(byDoc);
  if (sourceDocNames.length === 0) {
    return md + "No detailed content found matching this request.";
  }

  for (const docName of sourceDocNames) {
    const docChunks = byDoc[docName];
    
    // Group by page internally
    const byPage = {};
    for (const dc of docChunks) {
      const pKey = dc.page ? `Page ${dc.page}` : 'Content';
      if (!byPage[pKey]) byPage[pKey] = [];
      byPage[pKey].push(dc.text);
    }

    for (const pageKey of Object.keys(byPage)) {
      if (pageKey !== 'Content') {
        md += `**${pageKey}**\n\n`;
      }
      for (const text of byPage[pageKey]) {
        // OCR and some source files flatten numbered headings into one long
        // line. Convert those patterns into Markdown so the web view and all
        // generated files retain a clean, point-wise hierarchy.
        const formatted = formatInlineNumberedSections(text);
        md += `${formatted || text}\n\n`;
      }
    }
  }
  
  return md;
}

const defaultOrgId = 'org_default';
const EXPOSE_CHUNKS = String(process.env.EXPOSE_CHUNK_TEXT_TO_USERS || 'false').toLowerCase() === 'true';

function normalizeIntentResult(result) {
  if (!result || typeof result !== 'object') return result;
  const normalized = { ...result };
  if (normalized.intent) normalized.intent = String(normalized.intent).toUpperCase();
  // The semantic schema deliberately uses uppercase enum values, while the
  // generator, storage records, MIME map, and download lookup use lowercase
  // extensions. Keep that boundary canonical so a successful semantic route
  // cannot bypass artifact generation (for example, "PDF" !== "pdf").
  if (normalized.requestedFormat) normalized.requestedFormat = String(normalized.requestedFormat).toLowerCase();
  if (normalized.contextRelation) normalized.contextRelation = String(normalized.contextRelation).toUpperCase();
  return normalized;
}

// An artifact is an opt-in representation, never a side effect of producing
// an answer. Keep this check at the execution boundary so a malformed or
// over-eager semantic response cannot turn a knowledge answer into a file.
function hasArtifactGenerationIntent(intent) {
  const action = String(intent?.intent || '').toUpperCase();
  const format = String(intent?.requestedFormat || '').toLowerCase();
  const artifactActions = new Set(['CREATE', 'CONVERT', 'CREATE_AND_DOWNLOAD']);

  if (action === 'VISUALIZE') {
    return format === 'svg' || intent?.outputs?.diagram === true;
  }

  return artifactActions.has(action) &&
    ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'md', 'html', 'json', 'svg'].includes(format);
}

function suppressUnrequestedArtifact(intent, query = '') {
  const format = String(intent?.requestedFormat || '').toLowerCase();
  // A file is never an implied side effect of prose such as "summarize this"
  // or "make this professional". SVG is deliberately separate: it is an
  // on-screen visualization, not a document download.
  const explicitlyRequested = format === 'svg' || hasExplicitArtifactDeliveryRequest(query);
  if (explicitlyRequested && (hasArtifactGenerationIntent(intent) || String(intent?.intent || '').toUpperCase() === 'DOWNLOAD')) return intent;

  const isContextTransformation = intent?.contextType === 'CURRENT_ANSWER' &&
    ['CONTINUE', 'TRANSFORM', 'MODIFY', 'REPRESENT'].includes(intent?.contextRelation);
  return {
    ...intent,
    intent: isContextTransformation ? 'SUMMARY' : 'ANSWER',
    requestedFormat: null,
    outputs: { ...(intent?.outputs || {}), text_answer: true, diagram: false, chart: false }
  };
}

// DOWNLOAD is only valid for an artifact that already exists in the
// conversation. If semantic resolution also says the request needs new
// information, the requested representation belongs after RAG and Answer
// persistence, so it must be created rather than looked up.
function promoteCombinedKnowledgeArtifactIntent(intent) {
  const isDownload = String(intent?.intent || '').toUpperCase() === 'DOWNLOAD';
  const hasFormat = Boolean(intent?.requestedFormat);
  const needsNewInformation = intent?.newInformationRequired === true ||
    String(intent?.contextType || '').toUpperCase() === 'NEW_TOPIC' ||
    ['NEW_TOPIC', 'MULTI_TOPIC'].includes(String(intent?.contextRelation || '').toUpperCase());
  if (!isDownload || !hasFormat || !needsNewInformation) return intent;

  return {
    ...intent,
    intent: 'CREATE',
    contextType: 'NEW_TOPIC',
    contextRelation: 'NONE',
    resolvedAnswerId: null,
    resolvedArtifactId: null,
    newInformationRequired: true,
    outputs: { ...(intent.outputs || {}), text_answer: true, diagram: intent.requestedFormat === 'svg' }
  };
}

// This is only used when semantic preflight is unavailable. Normal operation
// is resolved by the LLM contract above; these broad language families keep a
// temporary model outage from breaking ordinary artifact requests.
function inferFormatFromLanguage(text) {
  // Format inference is intentionally conservative. A report, a professional
  // tone, or a request to summarize must remain a normal text response. Files
  // are created only when the user names a format or representation explicitly.
  if (/\bpdf\b/.test(text)) return 'pdf';
  if (/\bdocx\b|\bmicrosoft\s+word\b|\bword\s+(?:file|document)\b/.test(text)) return 'docx';
  if (/\b(xlsx|excel|spreadsheet)\b/.test(text)) return 'xlsx';
  if (/\b(pptx?|powerpoint|presentation|slides?)\b/.test(text)) return 'pptx';
  if (/\b(html|web(?: ?page| document)?)\b/.test(text)) return 'html';
  if (/\b(csv)\b/.test(text)) return 'csv';
  if (/\b(json|structured data)\b/.test(text)) return 'json';
  if (/\b(markdown|documentation)\b/.test(text)) return 'md';
  if (/\b(text file|plain text)\b/.test(text)) return 'txt';
  if (/\b(svg|diagram|visuali[sz]e|visually|visual representation|architecture|workflow|process)\b/.test(text)) return 'svg';
  return null;
}

// The semantic resolver is the primary interpreter, but an explicit delivery
// action is an execution-critical signal. This guard prevents a malformed or
// overly conservative resolver response from silently dropping the file part
// of "Explain X and give me a PDF." It deliberately excludes discovery
// questions such as "Is there a PDF about X?".
function hasExplicitArtifactDeliveryRequest(query) {
  const text = String(query || '').toLowerCase();
  const format = inferFormatFromLanguage(text);
  if (!format) return false;
  return /\b(?:give|create|generate|make|build|prepare|produce|convert|turn|export|download|save|send|put|need|want|show|get|map)\b/.test(text);
}

function inferPresentationHints(text, requestedFormat) {
  const theme = /\b(management|leadership|executive|meeting)\b/.test(text) ? 'executive'
    : /\b(technical|architecture)\b/.test(text) ? 'technology'
    : /\b(simple|minimal|clean)\b/.test(text) ? 'minimal'
    : /\b(corporate|business)\b/.test(text) ? 'corporate'
    : 'professional';
  const palette = /\b(black and white|monochrome)\b/.test(text) ? 'monochrome'
    : /\b(navy)\b/.test(text) ? 'navy'
    : /\b(green)\b/.test(text) ? 'green'
    : /\b(purple)\b/.test(text) ? 'purple'
    : /\b(orange)\b/.test(text) ? 'orange'
    : /\b(blue)\b/.test(text) ? 'blue'
    : 'auto';
  const template = requestedFormat === 'pptx' ? 'presentation'
    : theme === 'executive' ? 'executive_summary'
    : theme === 'technology' ? 'technical_report'
    : theme === 'minimal' ? 'simple_document'
    : 'professional_report';
  const visualType = requestedFormat === 'svg'
    ? (/\b(architecture|system)\b/.test(text) ? 'architecture'
      : /\b(timeline|chronolog)\b/.test(text) ? 'timeline'
      : /\b(decision|branch)\b/.test(text) ? 'decision_tree'
      : /\b(roadmap|milestone)\b/.test(text) ? 'roadmap'
      : /\b(process|flow|workflow|stage|step)\b/.test(text) ? 'process_flow'
      : 'hierarchy')
    : null;
  return { theme, palette, template, visualType };
}

// File-format and delivery words describe the output, not the knowledge the
// user wants. Removing them before retrieval stops a request such as
// "create a PDF about access policies" from ranking an unrelated document
// merely because it repeatedly mentions PDFs.
function buildRetrievalQuery(query, intent) {
  let baseQuery = query;
  
  if (hasArtifactGenerationIntent(intent)) {
    const subject = String(query || '')
      .replace(/\b(?:create|generate|make|build|prepare|produce|convert|turn|export|download|save|give|send)\b/gi, ' ')
      .replace(/\b(?:a|an|the|this|that|it|me|please)\b/gi, ' ')
      .replace(/\b(?:pdf|docx|word|pptx|powerpoint|presentation|xlsx|excel|spreadsheet|csv|txt|text|markdown|html|json|svg|diagram)\b/gi, ' ')
      .replace(/\b(?:file|format|version|copy|report|document|to download|for download)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    baseQuery = subject.length >= 3 ? subject : query;
  }

  return baseQuery;
}

// A request such as "based on this information, create a flow diagram" is
// unambiguously a representation of the previous grounded answer. Keep this
// routing deterministic so an LLM intent classification cannot send it back
// through new-topic RAG.
function isExplicitContextDiagramRequest(query) {
  const text = String(query || '').toLowerCase();
  const asksForDiagram = /\b(flow\s*(?:chart|diagram)|process\s*(?:flow|diagram)|workflow|diagram|visuali[sz]ation)\b/.test(text);
  const refersToContext = /\b(?:based on|from|using|with)\s+(?:this|that|the|above|previous)\s+(?:information|answer|content|details|document)\b/.test(text) ||
    /\b(?:based on|from|using|with)\s+(?:(?:the|above|previous|current)\s+)?(?:information|answer|content|details|document)\b/.test(text) ||
    /\b(?:this|that|the above|previous)\s+(?:information|answer|content|details|document)\b/.test(text);
  return asksForDiagram && refersToContext;
}

// Follow-up questions such as "explain each feature" elaborate on the last
// grounded answer. They do not introduce a new search topic, even when the
// user omits words such as "this" or "above".
function isCurrentAnswerElaborationRequest(query) {
  const text = String(query || '').toLowerCase();
  const asksToExplain = /\b(?:explain|describe|detail|elaborate|expand|break\s+down|clarify)\b/.test(text);
  const refersToAnswerContent = /\b(?:each|every|all|these|those|the above|previous|current)\s+(?:feature|features|item|items|point|points|section|sections|capability|capabilities)\b/.test(text);
  return asksToExplain && refersToAnswerContent;
}

// A knowledge question that names its own subject is a fresh retrieval.  The
// resolver is advisory only: it must never attach an earlier document to this
// class of request merely because a conversation already has an answer.
function isExplicitNewKnowledgeRequest(query) {
  const text = String(query || '').trim().toLowerCase();
  if (!/\b(?:explain|describe|what|why|how|which|define|tell|list|identify|compare|analy[sz]e)\b/.test(text)) return false;
  if (/\b(?:this|that|it|these|those|above|previous|current)\b/.test(text)) return false;
  const subject = text
    .replace(/\b(?:explain|describe|what|why|how|which|define|tell|list|identify|compare|analy[sz]e|is|are|the|a|an|of|in|about|for|please)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return subject.split(/\s+/).filter(Boolean).length >= 1;
}

// When someone explicitly refers to the current result/answer and requests a
// representation, reuse that Answer. This prevents phrases such as "based on
// this result, download a PDF" from becoming a fresh knowledge search.
function isExplicitCurrentAnswerArtifactRequest(query) {
  const text = String(query || '').toLowerCase();
  const requestedFormat = inferFormatFromLanguage(text);
  if (!requestedFormat) return false;

  const explicitReference = /\b(?:based on|from|using|with)\s+(?:this|that|the|above|previous|current)\s+(?:result|answer|response|summary|explanation|content|information|output)\b/.test(text) ||
    // "Based on information, make a PDF" refers to the answer on screen
    // even when the user omits "this" or "above".
    /\b(?:based on|from|using|with)\s+(?:(?:the|above|previous|current)\s+)?(?:information|answer|response|summary|explanation|content|output)\b/.test(text) ||
    /\b(?:this|that|the above|previous|current)\s+(?:result|answer|response|summary|explanation|content|information|output)\b/.test(text) ||
    /\b(?:turn|convert|make|create|put|give|download|export|save)\b[^.?!]*\b(?:it|this|that)\b/.test(text) ||
    /\b(?:download|export|save)\s+(?:this|that|the above|previous|current)\s+(?:result|answer|response|summary|explanation|content|information|output)\b/.test(text) ||
    /\b(?:above|previous|current)\b/.test(text) ||
    /\b(?:this|that)\s+(?:information|data|content|explanation|report|document|file)\b/.test(text);

  if (explicitReference) return true;

  // Natural language often omits a pronoun after an answer is shown: "Give
  // me the data as CSV" or "Make a professional report." Treat it as a
  // representation only when, after removing output/style language, no new
  // knowledge subject remains. New requests such as "PDF about HR policy"
  // retain their subject and still take the RAG path.
  const subjectWords = text
    .replace(/\b(?:create|generate|make|build|prepare|produce|convert|turn|export|download|save|give|get|send|put|need|want|would|like|can|could)\b/gi, ' ')
    .replace(/\b(?:pdf|docx|word|pptx|powerpoint|presentation|xlsx|excel|spreadsheet|csv|txt|text|markdown|html|json|svg|diagram|flowchart)\b/gi, ' ')
    .replace(/\b(?:i|me|you|a|an|the|to|as|into|in|for|of|and|or|my|your|please|something|file|format|version|copy|report|document|data|information|content|answer|result|response|summary|explanation|professional|clean|management|executive|printable|editable|share)\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return subjectWords.length === 0;
}

function buildContextArtifactIntent(query) {
  const requestedFormat = inferFormatFromLanguage(String(query || '').toLowerCase());
  const presentation = inferPresentationHints(String(query || '').toLowerCase(), requestedFormat);
  return {
    intent: requestedFormat === 'svg' ? 'VISUALIZE' : 'CREATE',
    requestedFormat,
    visualType: presentation.visualType,
    outputs: { text_answer: true, diagram: requestedFormat === 'svg' },
    contextType: 'CURRENT_ANSWER',
    contextRelation: 'REPRESENT',
    confidence: 1,
    newInformationRequired: false,
    theme: presentation.theme,
    palette: presentation.palette,
    template: presentation.template
  };
}

function buildContextDiagramIntent(query) {
  const presentation = inferPresentationHints(String(query || '').toLowerCase(), 'svg');
  return {
    intent: 'VISUALIZE',
    requestedFormat: 'svg',
    visualType: presentation.visualType || 'process_flow',
    outputs: { text_answer: true, diagram: true },
    contextType: 'CURRENT_ANSWER',
    contextRelation: 'REPRESENT',
    confidence: 1,
    newInformationRequired: false,
    theme: presentation.theme,
    palette: presentation.palette,
    template: presentation.template
  };
}

function buildDeterministicDiagramConfig(answerText, visualType, title) {
  const htmlTitle = String(answerText || '').match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  const markdownHeadings = [...String(answerText || '').matchAll(/^\s*(#{1,6})\s+(.+?)\s*$/gm)]
    .map(match => ({
      level: match[1].length,
      label: match[2].replace(/\*\*/g, '').replace(/\\([.#])/g, '$1').trim()
    }));
  const preferredMarkdownTitle = markdownHeadings.find(heading => heading.level === 2)?.label ||
    markdownHeadings.find(heading => heading.level === 1)?.label;
  const diagramTitle = (htmlTitle ? htmlTitle[1] : preferredMarkdownTitle || title || 'Information Flow')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Information Flow';
  const plainText = String(answerText || '')
    .replace(/<\/(?:p|div|li|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\(\s*source\s*:\s*[^)]+\)/gi, '')
    .replace(/\[\s*source\s*:\s*[^\]]+\]/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  const candidates = plainText
    .split(/\n+|(?<=[.!?])\s+/)
    .map(line => line
      .replace(/^\s*(?:#{1,6}\s*|[-*•]\s*|\d+[.)]\s*)+/, '')
      .replace(/\*\*/g, '')
      .replace(/\\([.#])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(line => line.length >= 8 && !/^source\s*:/i.test(line));
  // A catalogue should use its section headings as nodes; piping raw Markdown
  // lines into the SVG renderer produced literal # and ** symbols in labels.
  const sectionLabels = markdownHeadings
    .filter(heading => heading.level >= 3)
    .map(heading => heading.label.replace(/^\d+\.\s*/, ''))
    .filter(label => label.length >= 3);
  const labels = [...new Set((sectionLabels.length ? sectionLabels : candidates).map(line => line.slice(0, 90)))].slice(0, 6);
  const nodes = (labels.length ? labels : [diagramTitle]).map((label, index) => ({ id: `step_${index + 1}`, label }));
  const edges = nodes.slice(1).map((node, index) => ({ source: nodes[index].id, target: node.id }));
  return {
    title: diagramTitle,
    template: visualType === 'process_flow' ? 'process_flow' : 'hierarchy',
    theme: 'professional',
    palette: 'blue',
    data: { nodes, edges }
  };
}

function inferDocumentScopeFromQuery(query, documents = []) {
  const queryTokens = (String(query || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  const queryText = ` ${queryTokens.join(' ')} `;
  let best = null;
  for (const document of documents) {
    const filename = String(document.name || document.originalFilename || '').replace(/\.[^.]+$/, '');
    const tokens = (filename.toLowerCase().match(/[a-z]+/g) || []).filter(token => !['autorecovered', 'recovered'].includes(token));
    for (let length = Math.min(5, tokens.length); length >= 2; length--) {
      for (let start = 0; start <= tokens.length - length; start++) {
        const phrase = tokens.slice(start, start + length).join(' ');
        if (queryText.includes(` ${phrase} `) && (!best || phrase.length > best.length)) best = phrase;
      }
    }
  }
  return best;
}

function inferTopicFromQuery(query, targetDocument) {
  let subject = String(query || '').toLowerCase()
    .replace(/\b(?:explain|describe|summari[sz]e|tell me about|what (?:is|are)|list|show|give me|outline|detail)\b/g, ' ')
    .replace(/\b(?:in|from|within|about|regarding|the|a|an)\b/g, ' ');
  if (targetDocument) subject = subject.replace(new RegExp(`\\b${targetDocument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  return subject.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

function inferFallbackIntent(query, history, artifacts, documents = []) {
  const text = String(query || '').trim().toLowerCase();
  const hasAnswer = (history || []).some(message => message.role === 'assistant' && message.answerId && message.content);
  const requestedFormat = inferFormatFromLanguage(text);
  const presentation = inferPresentationHints(text, requestedFormat);
  // "Generate a PDF to download" is a creation request with a delivery
  // preference, not a request to fetch an older artifact. Only take the
  // download-only path where no creation/transformation action is present.
  const requestsCreation = /\b(create|generate|make|build|prepare|produce|convert|turn|export|format)\b/.test(text);
  const download = !requestsCreation && /\b(download|retrieve|send)\b/.test(text) && hasAnswer && (artifacts || []).length > 0;
  const explicitSubject = /\b(about|regarding|on)\s+\w+/.test(text);
  // This fallback is intentionally broad-language rather than phrase-based:
  // new explanatory questions plus a requested format are Answer → Artifact,
  // even if the conversation also contains an earlier Answer.
  const requestsKnowledge = /\b(explain|describe|summari[sz]e|tell|what|why|how|which|compare|analy[sz]e|outline|detail|list|identify)\b/.test(text);
  const combinedKnowledgeArtifact = Boolean(requestedFormat && requestsKnowledge);
  const transformation = hasAnswer && !explicitSubject && !combinedKnowledgeArtifact && (/\b(summarize|summarise|rewrite|rephrase|organize|prepare|present|print|editable|convert|turn|make|show|give me|need something)\b/.test(text) || requestedFormat);
  return {
    intent: download ? 'DOWNLOAD' : requestedFormat ? (requestedFormat === 'svg' ? 'VISUALIZE' : (requestsCreation && /\b(download|send|share)\b/.test(text) ? 'CREATE_AND_DOWNLOAD' : 'CREATE')) : transformation ? 'SUMMARY' : 'ANSWER',
    requestedFormat,
    visualType: presentation.visualType,
    outputs: { text_answer: true, diagram: requestedFormat === 'svg' },
    contextType: transformation || download ? 'CURRENT_ANSWER' : 'NEW_TOPIC',
    contextRelation: download ? 'DOWNLOAD' : transformation ? 'REPRESENT' : 'NONE',
    confidence: transformation || download ? 0.65 : 0.4,
    newInformationRequired: combinedKnowledgeArtifact || (!transformation && !download),
    topic: inferTopicFromQuery(query, inferDocumentScopeFromQuery(query, documents)),
    targetDocument: inferDocumentScopeFromQuery(query, documents),
    theme: presentation.theme,
    palette: presentation.palette,
    template: presentation.template
  };
}

// Removed in-memory stash. Artifacts are now stored in MinIO.

// Ask the knowledge base — answer is grounded ONLY in retrieved chunks.
router.post('/ask', async (req, res) => {
  try {
    await chatLimiter.run(async () => {
      let { query, conversationId, activeDocumentId } = req.body || {};
      if (!query || !query.trim()) return res.status(400).json({ error: 'query is required' });

      const sessionUserId = req.session?.user?.id || 'anonymous';
      const sessionOrgId = req.session?.user?.organizationId || defaultOrgId;

      // Load or Create Conversation — scoped to session user
      if (!conversationId) {
        conversationId = await memory.createConversation(sessionUserId, sessionOrgId);
      } else {
        const conv = await memory.getConversation(conversationId);
        if (!conv) {
           conversationId = await memory.createConversation(sessionUserId, sessionOrgId);
        } else if (conv.user_identifier !== sessionUserId || (conv.organization_id && conv.organization_id !== sessionOrgId)) {
           // RBAC: Prevent cross-user conversation access
           return res.status(403).json({ error: 'Conversation access denied.' });
        }
      }

      const history = await memory.getMessages(conversationId, 10);
      const artifacts = await memory.getArtifacts(conversationId, 10);
      const summaryRes = await getSummary(conversationId);
      const summaryText = summaryRes ? summaryRes.summary_text : null;
      const activeCharts = await getCharts(conversationId);
      
      // Inject previous artifacts into history context for the LLM
      const historyForLLM = history.map(h => {
         const entry = { role: h.role, content: h.content };
        if (h.role === 'assistant') {
            entry.answerId = h.answerId || h.id;
          entry.sourceDocumentIds = h.sourceDocIds || [];
          entry.sourceChunkIds = h.sourceIds || [];
        }
         if (h.artifactIds && h.artifactIds.length > 0) {
            entry.artifactIds = h.artifactIds;
         }
         return entry;
      });

      const kb = await loadKB(sessionOrgId);
      let top = [];
      let resolvedContext = null;
      let intentJson = { intent: "answer", outputs: { text_answer: true } };
      let intentRouterFailed = false;
      let preflightRes = null;

      // 1. Preflight LLM Intent Routing
      const hasPriorGroundedAnswer = history.some(message =>
        message.role === 'assistant' && message.answerId && message.content
      );
      const explicitContextArtifactRequest = isExplicitCurrentAnswerArtifactRequest(query) && hasPriorGroundedAnswer;
      const explicitContextDiagramRequest = !explicitContextArtifactRequest &&
        isExplicitContextDiagramRequest(query) && hasPriorGroundedAnswer;
      if (explicitContextArtifactRequest) {
        preflightRes = buildContextArtifactIntent(query);
        Object.assign(intentJson, preflightRes);
        console.log('[PIPELINE] Explicit current-answer artifact request: reusing the latest grounded answer.');
      } else if (explicitContextDiagramRequest) {
        preflightRes = buildContextDiagramIntent(query);
        Object.assign(intentJson, preflightRes);
        console.log('[PIPELINE] Explicit context diagram request: reusing the latest grounded answer.');
      } else try {
        const { buildIntentPreflightPrompt } = require('../lib/claude');
        const preflightPrompt = buildIntentPreflightPrompt({ query, conversationHistory: historyForLLM });
        const preflightText = await llmLimiter.run(async () => {
          return await callClaude(preflightPrompt, 300);
        });
        const firstBrace = preflightText.indexOf('{');
        const lastBrace = preflightText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
          const parsedPreflight = JSON.parse(preflightText.substring(firstBrace, lastBrace + 1));
          preflightRes = validateSemanticResult(parsedPreflight);
          if (!preflightRes) throw new Error('Semantic resolver returned an invalid schema');
          preflightRes = normalizeIntentResult(preflightRes);
          Object.assign(intentJson, preflightRes);
          console.log(`\n[SEMANTIC RESOLVER] intent="${intentJson.intent}" contextType=${intentJson.contextType} newInformationRequired=${intentJson.newInformationRequired}`);
        }
      } catch (e) {
        console.warn('[Chat] Intent Preflight failed, falling back to heuristics:', e.message);
        preflightRes = inferFallbackIntent(query, history, artifacts, kb.docs);
        Object.assign(intentJson, preflightRes);
      }

      // requestedFormat is metadata, not authorization to write a file. Only
      // a CREATE/CONVERT/VISUALIZE intent may proceed to artifact generation.
      // Preserve an explicit request to *receive* a file even when the
      // semantic model returns ANSWER. This applies only to creation/delivery
      // wording, never file-discovery questions.
      const currentIntent = preflightRes || intentJson;
      if (hasExplicitArtifactDeliveryRequest(query) && !hasArtifactGenerationIntent(currentIntent) && String(currentIntent?.intent).toUpperCase() !== 'DOWNLOAD') {
        const requestedFormat = inferFormatFromLanguage(String(query || '').toLowerCase());
        const presentation = inferPresentationHints(String(query || '').toLowerCase(), requestedFormat);
        preflightRes = {
          ...currentIntent,
          intent: requestedFormat === 'svg' ? 'VISUALIZE' : 'CREATE',
          requestedFormat,
          visualType: presentation.visualType,
          outputs: { ...(currentIntent.outputs || {}), text_answer: true, diagram: requestedFormat === 'svg', chart: false },
          theme: presentation.theme,
          palette: presentation.palette,
          template: presentation.template
        };
        console.log(`[PIPELINE] Explicit artifact delivery request preserved: ${requestedFormat.toUpperCase()}.`);
      }
      preflightRes = suppressUnrequestedArtifact(preflightRes || intentJson, query);
      preflightRes = promoteCombinedKnowledgeArtifactIntent(preflightRes);
      const explicitDocumentScope = inferDocumentScopeFromQuery(query, kb.docs);
      if (explicitDocumentScope) {
        preflightRes = {
          ...preflightRes,
          targetDocument: explicitDocumentScope,
          topic: preflightRes.topic || inferTopicFromQuery(query, explicitDocumentScope)
        };
      }
      if (isExplicitNewKnowledgeRequest(query) && !hasArtifactGenerationIntent(preflightRes)) {
        preflightRes = {
          ...preflightRes,
          intent: 'ANSWER',
          contextType: 'NEW_TOPIC',
          contextRelation: 'NEW_TOPIC',
          // Clear inherited scope only. A document named in the current query
          // remains authoritative for fresh retrieval.
          targetDocument: explicitDocumentScope || null,
          resolvedAnswerId: null,
          newInformationRequired: true
        };
        console.log('[PIPELINE] Explicit new knowledge request: cleared inherited document/topic context.');
      }
      if (hasPriorGroundedAnswer && isCurrentAnswerElaborationRequest(query)) {
        preflightRes = {
          ...preflightRes,
          intent: 'SUMMARY',
          requestedFormat: null,
          outputs: { ...(preflightRes.outputs || {}), text_answer: true, diagram: false, chart: false },
          contextType: 'CURRENT_ANSWER',
          contextRelation: 'TRANSFORM',
          newInformationRequired: false
        };
        console.log('[PIPELINE] Feature-explanation follow-up: reusing the latest grounded answer.');
      }
      // A resolver cannot continue a conversation that has no saved Answer.
      // Treat an ordinary first-turn request as a new knowledge topic rather
      // than returning a misleading context clarification.
      if (!hasPriorGroundedAnswer &&
          preflightRes.contextType === 'CURRENT_ANSWER' &&
          preflightRes.intent !== 'DOWNLOAD' &&
          !hasArtifactGenerationIntent(preflightRes)) {
        preflightRes = {
          ...preflightRes,
          contextType: 'NEW_TOPIC',
          contextRelation: 'NONE',
          resolvedAnswerId: null,
          newInformationRequired: true
        };
      }

      // Deictic reference heuristic: when a conversion verb is paired with a
      // pronoun reference ("this", "that", "it") and a prior grounded answer
      // exists, correct a misclassified NEW_TOPIC to CURRENT_ANSWER so the
      // system transforms the existing answer rather than searching anew.
      if (hasPriorGroundedAnswer &&
          preflightRes.contextType === 'NEW_TOPIC' &&
          hasArtifactGenerationIntent(preflightRes) &&
          (/\b(?:convert|turn|make|transform|change|put|export|show|render)\s+(?:this|that|it)\b/i.test(query) ||
           /\b(?:this|that|it)\s+(?:into|to|as|in(?:to)?)\b/i.test(query) ||
           /\b(?:make|turn)\s+(?:this|that|it)\s+(?:a|an|the)\b/i.test(query) ||
           /\bnow\s+(?:make|show|convert|turn|put)\b/i.test(query))) {
        preflightRes = {
          ...preflightRes,
          contextType: 'CURRENT_ANSWER',
          contextRelation: 'REPRESENT',
          newInformationRequired: false
        };
        console.log('[PIPELINE] Deictic reference detected — corrected to CURRENT_ANSWER/REPRESENT');
      }

      if (activeDocumentId) {
        preflightRes.activeDocumentId = activeDocumentId;
      }

      intentJson = { ...intentJson, ...preflightRes };
      // Do not leave strict length control to an intent model. It is a direct
      // user constraint and must be available to the grounded-answer prompt.
      intentJson.wordCount = getExplicitWordCount(query);

       // ── Active Document Inheritance ──
      // If the LLM resolver didn't set a targetDocument but we have prior
      // grounded answers, inherit the active document from the most recent
      // assistant turn that has sourceDocIds. This keeps follow-up queries
      // ("explain AI search", "give me 5 points") scoped to the same document.
      if (!intentJson.targetDocument || intentJson.targetDocument === 'null') {
        // Only inherit the active document for follow-up queries on the SAME topic.
        // Do NOT inherit when the user is asking a NEW question that requires new information —
        // otherwise RAG gets scoped to the wrong document and returns off-topic content.
        const isNewTopic = intentJson.contextType === 'NEW_TOPIC' ||
          intentJson.contextRelation === 'NEW_TOPIC' ||
          intentJson.contextRelation === 'NONE' ||
          intentJson.newInformationRequired === true;

        if (!isNewTopic) {
          // Try to inherit from the most recent assistant message with source docs
          for (let i = history.length - 1; i >= 0; i--) {
            const h = history[i];
            if (h.role === 'assistant' && h.sourceDocIds && h.sourceDocIds.length > 0) {
              // Resolve the document name from the KB docs
              const sourceDoc = kb.docs.find(d => h.sourceDocIds.includes(d.id));
              if (sourceDoc) {
                const inheritedDocName = sourceDoc.originalFilename || sourceDoc.name || '';
                // Only inherit if there is a meaningful name (strip extension for matching)
                if (inheritedDocName) {
                  intentJson.targetDocument = inheritedDocName.replace(/\.[^/.]+$/, '').toLowerCase();
                  console.log(`[PIPELINE] Inherited targetDocument="${intentJson.targetDocument}" from prior grounded answer`);
                }
              }
              break;
            }
          }
        } else {
          console.log(`[PIPELINE] Skipping targetDocument inheritance — new topic detected (contextType=${intentJson.contextType}, relation=${intentJson.contextRelation}, newInfo=${intentJson.newInformationRequired})`);
        }
      }

      // ── Active Topic Inheritance ──
      // If the LLM resolver didn't extract a topic but the user is asking a
      // follow-up ("summarize this", "give me 5 points", "make it professional"),
      // inherit the topic from the most recent answer's stored topic.
      if (!intentJson.topic || intentJson.topic === 'null') {
        // Check if this is a follow-up (not a NEW_TOPIC with explicit new information)
        const isFollowUp = intentJson.contextType === 'CURRENT_ANSWER' ||
          ['CONTINUE', 'TRANSFORM', 'MODIFY', 'REPRESENT'].includes(intentJson.contextRelation) ||
          /\b(this|that|it|these|those|above|previous|same)\b/i.test(query) ||
          /\b(more content|more detail|make it|summarize|summarise|bullet|professional)\b/i.test(query);

        if (isFollowUp) {
          // Try to get the topic from the most recent assistant answer's stored topic
          for (let i = history.length - 1; i >= 0; i--) {
            const h = history[i];
            if (h.role === 'assistant' && h.answerId) {
              try {
                const prevAnswer = await memory.getAnswer(h.answerId, sessionOrgId);
                if (prevAnswer && prevAnswer.topic) {
                  intentJson.topic = prevAnswer.topic;
                  console.log(`[PIPELINE] Inherited topic="${intentJson.topic}" from prior grounded answer`);
                  break;
                }
              } catch (e) { /* ignore lookup errors */ }
            }
          }
        }
      }

      // 2. Resolve prior grounded context before any retrieval.
      const refersToContext = preflightRes &&
        preflightRes.contextType === 'CURRENT_ANSWER' &&
        !preflightRes.newInformationRequired &&
        ['CONTINUE', 'TRANSFORM', 'MODIFY', 'REPRESENT', 'DOWNLOAD'].includes(preflightRes.contextRelation);
      if (refersToContext) {
          resolvedContext = resolveBestContext(query, history, preflightRes);
          if (resolvedContext) {
             // Rehydrate Answer provenance from its authoritative persisted
             // record rather than trusting conversational history fields.
             const persistedAnswer = await memory.getAnswer(resolvedContext.answerId, sessionOrgId);
             if (persistedAnswer) {
               resolvedContext.answerText = persistedAnswer.answerText;
               resolvedContext.sourceDocumentIds = persistedAnswer.sourceDocumentIds;
               resolvedContext.sourceChunkIds = persistedAnswer.sourceChunkIds;
             }
             console.log(`[PIPELINE] Resolved context to messageId=${resolvedContext.messageId}`);
             // Ensure intentJson has correct outputs if heuristic overrode preflight
         }
      }

      if (refersToContext && !resolvedContext && preflightRes.confidence >= 0.6) {
        const latestAssistant = [...history].reverse().find(message => message.role === 'assistant' && message.content);
        if (latestAssistant && /couldn't find sufficient information|no matching chunks found|i do not have enough information/i.test(latestAssistant.content)) {
          const noEvidence = "I couldn't find sufficient information about this in the uploaded documents.";
          await memory.addMessage(conversationId, 'assistant', noEvidence, [], [], []);
          return res.json({ conversationId, success: false, grounded: false, answer: noEvidence, sources: [], sourceDocuments: [], chunks: [], artifacts: [], intent: preflightRes });
        }
        const clarification = preflightRes.requestedFormat
          ? `I can't create a ${preflightRes.requestedFormat.toUpperCase()} yet because this conversation does not contain a successful grounded answer. Ask a knowledge question first, then request the file.`
          : 'I could not identify a successful earlier answer to use. Please name the topic or ask a knowledge question first.';
        await memory.addMessage(conversationId, 'assistant', clarification, [], [], []);
        return res.json({ conversationId, success: false, grounded: false, answer: clarification, sources: [], sourceDocuments: [], chunks: [], artifacts: [], intent: preflightRes });
      }

      // Add User Message
      const userMessageId = await memory.addMessage(conversationId, 'user', query, [], []);

      // 3. Retrieval — mode selection based on intent and context
      const isDownloadIntent = ['DOWNLOAD'].includes(intentJson.intent);
      const isCreateAndDownload = intentJson.intent === 'CREATE_AND_DOWNLOAD';

      if (isDownloadIntent) {
        console.log(`[PIPELINE] mode=DOWNLOAD RAG_CALL_COUNT=0 LLM_CALL_COUNT=0`);
      } else if (resolvedContext) {
        console.log(`[PIPELINE] mode=CONTEXT_REF RAG_CALL_COUNT=0 LLM_CALL_COUNT=1`);
        // Use the exact chunks from the resolved answer — no new retrieval
        // Query PostgreSQL directly instead of kb.chunks (Rule 21)
        if (resolvedContext.sourceChunkIds && resolvedContext.sourceChunkIds.length > 0) {
          try {
            const { getPool } = require('../lib/db');
            const pool = getPool();
            if (pool) {
              const chunkRes = await pool.query(
                `SELECT c.id, c.content as text, d.id as "docId", d.original_filename as "docName"
                 FROM chunks c
                 JOIN document_versions dv ON c.document_version_id = dv.id
                 JOIN documents d ON dv.document_id = d.id
                 WHERE c.id = ANY($1::varchar[]) AND dv.status = 'READY'`,
                [resolvedContext.sourceChunkIds]
              );
              top = chunkRes.rows;
            }
          } catch (e) {
            console.warn('[PIPELINE] DB chunk lookup failed, using answerText only:', e.message);
          }
        }
        // If stored chunk IDs not found in DB (e.g. chunks pruned), fall back to last RAG
        if (!top.length && resolvedContext.answerText) {
          console.warn('[PIPELINE] Context chunks not found in DB, using answerText only.');
        }
      } else {
        const localIntent = detectLocalContextIntent(query);
        const activeDocText = activeDocumentId ? await getActiveDocumentText(activeDocumentId, sessionOrgId) : null;
        
        if (localIntent.isLocalReference && shouldBypassRetrieval(query, resolvedContext, activeDocText)) {
          console.log(`[PIPELINE] Anaphora bypass: ${localIntent.reason}`);
          console.log(`[PIPELINE] mode=ANAPHORA_BYPASS RAG_CALL_COUNT=0 LLM_CALL_COUNT=1`);
          // Use local text directly — skip RAG entirely
          if (resolvedContext && resolvedContext.answerText) {
             top = []; // No chunks needed — answerText is the context
          } else if (activeDocText) {
             top = [{ text: activeDocText, docName: 'Active Document', docId: activeDocumentId }];
          }
        } else {
          console.log(`[PIPELINE] mode=NEW_RAG RAG_CALL_COUNT=1`);
          const retrievalQuery = buildRetrievalQuery(query, intentJson);
        if (retrievalQuery !== query) console.log(`[RAG] retrievalQuery="${retrievalQuery}"`);
        const candidates = await retrieveTopChunks(kb, retrievalQuery, 25, sessionOrgId, intentJson);
        console.log(`[RAG] candidates=${candidates.length} candidateChunkIds=${candidates.map(c => c.id).join(',')} candidateDocumentIds=${[...new Set(candidates.map(c => c.docId || c.documentId || c.docName).filter(Boolean))].join(',')}`);
        const selection = await selectRelevantChunks(candidates, retrievalQuery, intentJson);
        top = orderChunksForPresentation(selection.top);
        const rejected = selection.rejected;
        
        console.log(`\n[REQUEST] query="${query}"`);
        console.log(`[INTENT] ${intentJson.intent} | contextType=${intentJson.contextType} | relation=${intentJson.contextRelation}`);
        console.log(`[TOPIC] ${intentJson.topic || '(none)'}`);
        console.log(`[REFERENCE] ${intentJson.contextRelation === 'CONTINUE' || intentJson.contextRelation === 'TRANSFORM' || intentJson.contextRelation === 'MODIFY' ? 'follow-up' : 'direct'}`);
        console.log(`[ACTIVE_DOCUMENT] ${intentJson.targetDocument || '(none)'}`);
        console.log(`[DOCUMENT_SCOPE] ${intentJson.targetDocument ? 'SCOPED to ' + intentJson.targetDocument : 'GLOBAL'}`);
        if (resolvedContext) console.log(`[RESOLVED_REFERENCE] AnswerID: ${resolvedContext.answerId}`);
        console.log(`[RAG_CANDIDATES] ${candidates.length}`);
        console.log(`[ACCEPTED_CHUNKS] ${top.length} (${top.map(c => c.id).join(', ')})`);
        console.log(`[REJECTED_CHUNKS] ${rejected.length} (${rejected.map(c => c.id).join(', ')})`);
        console.log(`[REJECTION_REASONS] ${[...new Set(rejected.map(c => c.rejectReason).filter(Boolean))].join(' | ') || '(none)'}`);
        console.log(`[FINAL_CONTEXT] chunks=${top.length} docIds=${[...new Set(top.map(c => c.docId || c.documentId || c.docName).filter(Boolean))].join(',')}`);
        console.log(`[LLM_CALLED] ${top.length > 0 || resolvedContext ? 'true' : 'false'}`);
        console.log(`[OUTPUT_TYPE] ${intentJson.requestedFormat || 'text_answer'}`);
        
        console.log(`[RAG] finalEvidence=${top.length} rejectedCandidates=${rejected.length} selectedDocumentIds=${[...new Set(top.map(c => c.docId || c.documentId || c.docName).filter(Boolean))].join(',')} relevanceScores=${top.map(c => Number(c.relevanceScore || 0).toFixed(3)).join(',')}`);
        console.log(`[RETRIEVAL] sectionNumbers=${top.map(c => c.metadata?.sectionNumber || '-').join(',')} vectorScores=${top.map(c => Number(c.vector_score || 0).toFixed(3)).join(',')} finalScores=${top.map(c => Number(c.final_score || c.score || 0).toFixed(3)).join(',')}`);
        }
        // --- Token Budget: Deduplicate and trim chunks ---
        const MAX_CONTEXT_TOKENS = parseInt(process.env.GROQ_MAX_CONTEXT_TOKENS || '3500', 10);
        const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * 4;
        const seenIds = new Set();
        const deduped = [];
        for (const c of top) {
          const key = c.id || c.text;
          if (!seenIds.has(key)) { seenIds.add(key); deduped.push(c); }
        }
        let totalChars = 0;
        const trimmed = [];
        for (const c of deduped) {
          const chunkLen = (c.text || '').length + (c.docName || '').length + 30;
          if (totalChars + chunkLen > MAX_CONTEXT_CHARS && trimmed.length > 0) break;
          trimmed.push(c);
          totalChars += chunkLen;
        }
        top = orderChunksForPresentation(trimmed);
        console.log(`[ANSWER ASSEMBLY] requestedScope=${intentJson.topic || '(none)'} sectionsSelected=${[...new Set(top.map(c => c.metadata?.sectionNumber || c.metadata?.sectionTitle || '-'))].join(',')} finalSectionOrder=${top.map(c => c.metadata?.sectionNumber || c.chunkIndex || '-').join('->')}`);
        console.log(`[RAG] Using ${top.length} chunks, ~${Math.ceil(totalChars/4)} estimated tokens`);
      }

      if (!isDownloadIntent && !top.length && !(resolvedContext && resolvedContext.answerText)) {
        const noDataMsg = "I couldn't find sufficient information about this in the uploaded documents.";
             await memory.addMessage(conversationId, 'assistant', noDataMsg, [], [], []);
        console.log(JSON.stringify({
          _tag: '[RAG DIAGNOSTIC]', currentQuery: query, intent: intentJson.intent,
          contextRelation: intentJson.contextRelation, explicitDocumentScope: intentJson.targetDocument || null,
          finalTargetDocument: null, retrievedCandidateCount: 0, validatedEvidenceCount: 0,
          evidenceSupport: false, queryAligned: false, resolvedContext: null,
          sourceCount: 0, llmCalled: false, groundedAnswerCreated: false,
          reusableContext: false, noEvidencePath: true
        }));
        return res.json({ conversationId, success: false, grounded: false, sources: [], sourceDocuments: [], chunks: [], artifacts: [], answer: noDataMsg, intent: intentJson });
      }

      // ============================================================
      // STRICT DOWNLOAD INTERCEPT — 0 RAG, 0 LLM, 0 generation
      // ============================================================
      if (isDownloadIntent) {
         console.log(`[PIPELINE] DOWNLOAD intercept — RAG=0, LLM=0, GEN=0`);
         const format = intentJson.requestedFormat && intentJson.requestedFormat !== 'null' ? intentJson.requestedFormat : null;
         let targetArtifact = null;

         // Match by exact format first, then by type hints from query
         if (format) {
             targetArtifact = artifacts.find(a => a.format === format);
         }
         // If no specific format — pick most recently generated artifact
         if (!targetArtifact && !format && artifacts.length > 0) {
             targetArtifact = artifacts[0];
         }

         if (targetArtifact) {
             console.log(`[DOWNLOAD] Serving artifact ${targetArtifact.id} (${targetArtifact.format}) — no regeneration`);
             const storedTitle = (targetArtifact.validatedData && targetArtifact.validatedData.title) || targetArtifact.id.slice(0, 30);
             const safeTitle = storedTitle.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'download';
             const filename = `${safeTitle}.${targetArtifact.format}`;
             const confirmMsg = `Here is the ${targetArtifact.format.toUpperCase()} you requested to download.`;
             const downloadPayload = {
                 conversationId,
                 answer: confirmMsg,
                 sources: [],
                 chunks: [],
                 intent: intentJson
             };

             if (targetArtifact.format === 'svg') {
                 downloadPayload.diagram = {
                     svg: targetArtifact.validatedData ? generateSvg(targetArtifact.validatedData) : '',
                     downloadUrl: `/api/chat/download/${targetArtifact.id}?filename=${encodeURIComponent(filename)}`,
                     filename
                 };
             } else {
                 downloadPayload.document = {
                     format: targetArtifact.format,
                     filename,
                     downloadUrl: `/api/chat/download/${targetArtifact.id}?filename=${encodeURIComponent(filename)}`
                 };
             }

             await memory.addMessage(conversationId, 'assistant', confirmMsg, [], [targetArtifact.id]);
             return res.json(downloadPayload);
         } else {
             // No matching artifact found — tell the user rather than silently creating one
             const noArtMsg = format
               ? `No ${format.toUpperCase()} has been generated in this conversation yet. Ask me to create one first.`
               : `No files have been generated in this conversation yet. Ask me to create a document or diagram first.`;
             await memory.addMessage(conversationId, 'assistant', noArtMsg, [], []);
             return res.json({ conversationId, success: false, grounded: false, answer: noArtMsg, sources: [], sourceDocuments: [], chunks: [], artifacts: [], intent: intentJson });
         }
      }

      // ============================================================
      // 4. Generate text answer (ANSWER / SUMMARY / CREATE / VISUALIZE / CONVERT)
      // ============================================================
      const NO_EVIDENCE = "I couldn't find sufficient information about this in the uploaded documents.";
      let answer = "";
      let llmFailed = false;
      let groundedAnswerCreated = false;
      let knowledgeLlmCallCount = 0;
      let noEvidencePath = false;

      // SUMMARY intent: always text-only; suppress artifact generation unless explicitly requested
      const isSummaryOnly = intentJson.intent === 'SUMMARY' &&
        (!intentJson.requestedFormat || intentJson.requestedFormat === 'null') &&
        !(intentJson.outputs && intentJson.outputs.diagram);

      const needsTextAnswer = intentJson.outputs && intentJson.outputs.text_answer !== false;
      const artifactRequested = hasArtifactGenerationIntent(intentJson);
      // Artifact requests represent the persisted answer verbatim. Conversational
      // transformations (shorten, simplify, management-ready, etc.) may call
      // the LLM, but only with that persisted answer as their evidence.
      const isArtifactRepresentation = Boolean(
        resolvedContext && artifactRequested
      );
      const isDerivedTransformation = Boolean(resolvedContext && !isArtifactRepresentation);
      const parentScopeHeading = !resolvedContext ? requestedParentHeading(top, intentJson) : null;
      const parentScopeSections = new Set(top.map(chunk => chunk.metadata?.sectionNumber).filter(Boolean));
      const isCompleteParentScopeAnswer = Boolean(parentScopeHeading && parentScopeSections.size > 1 && intentJson.intent !== 'SUMMARY');

      if (needsTextAnswer) {
         if (isCompleteParentScopeAnswer) {
           // A broad parent-section request is answered from its complete,
           // source-ordered child evidence. This prevents a generator from
           // silently omitting supported sibling sections.
           answer = buildFallbackContent(query, null, top, parentScopeHeading);
           groundedAnswerCreated = true;
           console.log(`[ANSWER ASSEMBLY] mode=STRUCTURED_PARENT_SCOPE heading=${parentScopeHeading} sectionCount=${parentScopeSections.size}`);
         } else if (isArtifactRepresentation) {
           // Artifact transformations use the persisted grounded answer as
           // their source of truth and must not call the knowledge LLM again.
           answer = resolvedContext.answerText;
           groundedAnswerCreated = true;
         } else try {
           // For context references: ground the LLM in the resolved answer text
           const contextHint = resolvedContext ? resolvedContext.answerText : null;
           
            if (top.length === 0 && !resolvedContext) {
              console.log('[PIPELINE] No chunks retrieved and no context resolved. Skipping LLM generation to enforce strict grounding.');
              answer = NO_EVIDENCE;
              groundedAnswerCreated = false;
              noEvidencePath = true;
              top = [];
            } else {
              const prompt = buildGroundedPrompt(query, top, intentJson, contextHint, historyForLLM, summaryText, activeCharts);
              knowledgeLlmCallCount += 1;
              answer = await llmLimiter.run(async () => {
                return await callClaude(prompt);
              });

              // DEBUG: Log the raw LLM response for diagnostics
              console.log(`[PIPELINE DEBUG] LLM answer length=${answer.length} chars, first 200 chars: ${JSON.stringify(answer.slice(0, 200))}`);

              // REFUSAL DETECTION — must happen BEFORE grounding validation.
              // Only treat as a refusal if the ENTIRE response is a short refusal
              // phrase (< 250 chars). Long answers that include disclaimer
              // sentences like "The documents do not contain information about X"
              // are valid partial-evidence answers and must NOT be discarded.
              const REFUSAL_PATTERN = /couldn't find sufficient information|i do not have enough information|does not contain information|i cannot answer|no matching chunks found|not mentioned in the provided|not covered in the provided|no information about this/i;
              const refusalMatch = REFUSAL_PATTERN.test(answer);
              console.log(`[PIPELINE DEBUG] refusalMatch=${refusalMatch} answerLength=${answer.length} threshold=250`);
              if (refusalMatch && answer.length < 250) {
                if (top.length > 0) {
                  console.warn('[PIPELINE] LLM falsely refused despite having evidence. Triggering structured fallback.');
                  throw new Error('LLM falsely refused with valid evidence present');
                } else {
                  console.log('[PIPELINE] LLM returned a refusal (short response) and no evidence present.');
                  answer = NO_EVIDENCE;
                  groundedAnswerCreated = false;
                  noEvidencePath = true;
                }
              } else {
                // Non-refusal answer: validate grounding against evidence
                const answerEvidence = top.length > 0 ? top : (resolvedContext ? [{ text: resolvedContext.answerText }] : []);
                console.log(`[PIPELINE DEBUG] Running grounding validation with ${answerEvidence.length} evidence chunks...`);
                const groundingResult = await validateAnswerGrounding(answer, query, answerEvidence);
                console.log(`[PIPELINE DEBUG] Grounding validation result=${groundingResult}`);
                if (!groundingResult) {
                  throw new Error('Generated answer failed grounding validation');
                } else {
                  groundedAnswerCreated = true;
                }
              }
            }
          } catch (llmErr) {
            console.warn('[Chat] LLM content generation failed, using structured fallback:', llmErr.message);
            llmFailed = true;
            if (resolvedContext && resolvedContext.answerText) {
              // Valid prior context exists — use it as the answer
              answer = resolvedContext.answerText;
              groundedAnswerCreated = true;
            } else if (top.length > 0) {
              // We have valid evidence chunks, but the LLM failed (e.g. hallucinated, truncated, or failed grounding).
              // Since evidence exists, this is NOT a NO_EVIDENCE scenario. 
              // We must build the structured fallback from the validated chunks.
              answer = buildFallbackContent(query, null, top);
              groundedAnswerCreated = true;
            } else {
              // No valid evidence at all.
              answer = NO_EVIDENCE;
              groundedAnswerCreated = false;
              noEvidencePath = true;
            }
          }
      }
      
      // ============================================================
      // TITLE VALIDATION
      // ============================================================
      // If the LLM (or fallback) produced a title that is basically just the raw
      // user query, replace it with a professional, operation-based title.
      if (groundedAnswerCreated && answer) {
         const { cleanUnprofessionalCitations } = require('../lib/responseConstraints');
         answer = cleanUnprofessionalCitations(answer);
         if (intentJson.wordCount) {
           answer = applyWordCountLimit(answer, intentJson.wordCount);
         } else {
           const resolvedTopicForTitle = intentJson?.targetDocument || intentJson?.topic || null;
           answer = validateAndFixTitle(answer, query, intentJson, resolvedTopicForTitle);
           answer = normalizeExportMarkdown(answer);
         }
      }

      // Refusal reasons are now handled by the frontend via intent.reason
      // Do NOT append them as raw text to the answer

      // ============================================================
      // Sources and provenance — always from resolved context or RAG
      // ============================================================
      let sourceDocNames = groundedAnswerCreated && resolvedContext && resolvedContext.sourceDocumentIds && resolvedContext.sourceDocumentIds.length > 0
        ? resolvedContext.sourceDocumentIds
        : groundedAnswerCreated ? [...new Set(top.map(c => c.docName).filter(Boolean))] : [];
      const sourceChunkIds = groundedAnswerCreated && resolvedContext && resolvedContext.sourceChunkIds && resolvedContext.sourceChunkIds.length > 0
        ? resolvedContext.sourceChunkIds
        : groundedAnswerCreated ? top.map(c => c.id) : [];
      const sourceDocumentIds = groundedAnswerCreated && resolvedContext && resolvedContext.sourceDocumentIds && resolvedContext.sourceDocumentIds.length > 0
        ? resolvedContext.sourceDocumentIds
        : groundedAnswerCreated ? [...new Set(top.map(c => c.docId || c.documentId || c.docName).filter(Boolean))] : [];
      const sourceDocuments = sourceDocumentIds.map(sourceId => {
        const document = kb.docs.find(item => (item.id || item.documentId) === sourceId);
        return { id: sourceId, name: document ? (document.name || document.originalFilename) : sourceId };
      }).filter(source => kb.docs.some(item => (item.id || item.documentId) === source.id));
      if (groundedAnswerCreated) sourceDocNames = sourceDocuments.map(source => source.name);

      let answerId = resolvedContext ? resolvedContext.answerId : null;
      // Transformations represent an already persisted answer. Do not create a
      // duplicate Answer row and then attach the artifact to that duplicate.
      if ((!resolvedContext || (isDerivedTransformation && !llmFailed)) && groundedAnswerCreated && answer && answer.trim()) {
        answerId = await memory.addAnswer(conversationId, sessionOrgId, userMessageId, answer, sourceDocumentIds, sourceChunkIds, preflightRes?.topic || null);
      }

      const chunksForClient = groundedAnswerCreated && EXPOSE_CHUNKS
        ? top.map(c => ({ docName: c.docName, text: c.text, score: c.score }))
        : [];

      let responsePayload = { conversationId, success: true, grounded: groundedAnswerCreated, answer, sources: sourceDocNames, chunks: chunksForClient, artifacts: [], intent: intentJson };
      if (groundedAnswerCreated && answerId) responsePayload.answerId = answerId;
      responsePayload.sourceDocuments = groundedAnswerCreated ? sourceDocuments.map(source => ({
        ...source,
        downloadUrl: `/api/chat/source/${encodeURIComponent(source.id)}`
      })) : [];
      const generatedArtifactIds = [];

      // For SUMMARY-only: return text immediately without any artifact generation
      if (isSummaryOnly) {
        await memory.addMessage(conversationId, 'assistant', answer, sourceChunkIds, [], sourceDocumentIds, answerId);
        return res.json(responsePayload);
      }

      // Never turn an unavailable new-topic response into a fake artifact.
      // Current-context requests may still use their persisted grounded answer.
      if (!groundedAnswerCreated) {
        // Store the no-evidence message WITHOUT an answerId so it cannot
        // be resolved as reusable grounded context by follow-up queries.
        await memory.addMessage(conversationId, 'assistant', answer, [], [], []);
        console.log(JSON.stringify({
          _tag: '[PIPELINE FINAL]',
          retrievedCandidateCount: Math.max(top.length, sourceDocNames.length),
          validatedEvidenceCount: top.length,
          hasSufficientEvidence: false,
          resolvedContext: resolvedContext ? resolvedContext.answerId : null,
          sourceCount: 0,
          llmCalled: knowledgeLlmCallCount > 0,
          finalResponseType: 'no_evidence'
        }));
        // Authoritative no-evidence response: empty sources, no chunks, no artifacts
        return res.json({
          conversationId,
          success: false,
          grounded: false,
          answer,
          sources: [],
          sourceDocuments: [],
          chunks: [],
          artifacts: [],
          intent: intentJson
        });
      }

      // Look for a previously generated SVG in the artifact history
      const previousSvgArtifact = artifacts.find(a => a.format === 'svg' && a.validatedData);

      // ============================================================
      // 5. Diagram Generation (SVG) — VISUALIZE intent or requestedFormat=svg
      // ============================================================
      const needsDiagram = artifactRequested && (
        intentJson.intent === 'VISUALIZE' ||
        (intentJson.outputs && intentJson.outputs.diagram) ||
        intentJson.requestedFormat === 'svg'
      );

      let currentSvgConfig = null;
      if (needsDiagram) {
        // Use the appropriate visual type based on content (never default to process_flow for feature lists)
        const effectiveVisualType = intentJson.visualType || 'hierarchy';
        const diagConfig = {
          uiTemplate: effectiveVisualType,
          uiTheme: intentJson.theme || 'professional',
          uiPalette: intentJson.palette || 'blue'
        };

        // Every visual is derived from the exact assistant response being
        // returned, never from raw retrieval chunks. Chunks can contain facts
        // omitted from the answer and must not leak into an exported file.
        const svgSourceChunks = [{ text: answer, docName: 'Assistant Response' }];

        const svgPrompt = buildSvgConfigPrompt({
          query, chunks: svgSourceChunks, ...diagConfig
        });
        
        let svgRes;
        if (explicitContextDiagramRequest) {
          // The user explicitly requested a representation of the saved answer.
          // Build it locally so delivery does not depend on another model call.
          svgRes = null;
        } else try {
          svgRes = await llmLimiter.run(async () => {
            return await callClaude(svgPrompt);
          });
        } catch (svgLlmErr) {
          console.warn('[Chat] SVG config LLM failed, skipping diagram:', svgLlmErr.message);
          svgRes = null;
        }

        try {
          if (!svgRes) throw new Error('SVG LLM response unavailable');
          const firstBrace = svgRes.indexOf('{');
          const lastBrace = svgRes.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1) {
            currentSvgConfig = JSON.parse(svgRes.substring(firstBrace, lastBrace + 1));
            if (!currentSvgConfig.data || !Array.isArray(currentSvgConfig.data.nodes) || currentSvgConfig.data.nodes.length === 0) {
              throw new Error('SVG configuration contains no nodes');
            }
            const svgString = generateSvg(currentSvgConfig);
            
            // Validate SVG
            if (typeof svgString !== 'string' || !svgString.includes('<svg') || !svgString.includes('</svg>')) {
              throw new Error("Invalid SVG generated");
            }
            // Strip scripts and events
            const cleanSvg = svgString
              .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
              .replace(/javascript:/gi, '')
              .replace(/ on\w+="[^"]*"/gi, '')
              .replace(/ on\w+='[^']*'/gi, '');

            const buffer = Buffer.from(cleanSvg, 'utf8');
            const safeTitle = (currentSvgConfig.title || 'diagram').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'diagram';
            const filename = `${safeTitle}.svg`;
            const storageKey = `${sessionOrgId}/artifacts/${conversationId}_${Date.now()}.svg`;
            
            await storage.put(buffer, storageKey, 'image/svg+xml');
            
            // Validate persistence
            const exists = await storage.exists(storageKey);
            if (!exists) throw new Error("Artifact failed to persist");
            const metadata = await storage.metadata(storageKey);
            if (!metadata || metadata.size === 0) throw new Error("Artifact persisted with 0 size");
            
            // Save Artifact with full provenance
            const artifactId = await memory.addArtifact(
               conversationId, answerId,
               sourceDocumentIds, sourceChunkIds, 'svg', diagConfig, currentSvgConfig, storageKey, sessionOrgId,
               { filename, mimeType: 'image/svg+xml', sizeBytes: buffer.length }
            );
            generatedArtifactIds.push(artifactId);

            responsePayload.diagram = {
              svg: cleanSvg,
              downloadUrl: `/api/chat/download/${artifactId}?filename=${encodeURIComponent(filename)}`,
              filename
            };
          } else {
            throw new Error('SVG configuration was not valid JSON');
          }
        } catch (e) {
          console.error('Failed to generate SVG via LLM, attempting deterministic fallback:', e.message);
          try {
             // Use the current answer text for fallback SVG content — not raw system text
             const fallbackText = resolvedContext ? resolvedContext.answerText : answer;
             const svgTitle = (preflightRes && preflightRes.topic) || 'Information Flow';
             currentSvgConfig = buildDeterministicDiagramConfig(fallbackText, effectiveVisualType, svgTitle);
             
             const cleanSvg = generateSvg(currentSvgConfig);
             const buffer = Buffer.from(cleanSvg, 'utf8');
             const safeTitle = svgTitle.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'diagram';
             const filename = `${safeTitle}.svg`;
             const storageKey = `${sessionOrgId}/artifacts/${conversationId}_${Date.now()}_fb.svg`;
             
             await storage.put(buffer, storageKey, 'image/svg+xml');
             const artifactId = await memory.addArtifact(
                conversationId, answerId, sourceDocumentIds, sourceChunkIds, 'svg', diagConfig, currentSvgConfig, storageKey, sessionOrgId,
                { filename, mimeType: 'image/svg+xml', sizeBytes: buffer.length }
             );
             generatedArtifactIds.push(artifactId);

             responsePayload.diagram = {
               svg: cleanSvg,
               downloadUrl: `/api/chat/download/${artifactId}?filename=${encodeURIComponent(filename)}`,
               filename
             };
          } catch (fallbackErr) {
             console.error('Fallback SVG generation also failed:', fallbackErr.message);
             if (intentJson.requestedFormat === 'svg') {
               responsePayload.answer += `\n\n*Note: A flow diagram could not be generated at this time because the AI diagramming service is temporarily unavailable. Please try again later.*`;
               responsePayload.fallbackMode = true;
             }
          }
        }
      }

      // ============================================================
      // 5.5 Chart Generation (Persistent)
      // ============================================================
      let chartDataToEmbed = null;
      const needsChart = (intentJson.outputs && intentJson.outputs.chart) || hasChartReference(query);
      if (needsChart && groundedAnswerCreated) {
         const { buildChartDataPrompt } = require('../lib/claude');
         const chartPrompt = buildChartDataPrompt(query, answer, activeCharts);
         try {
           const chartRes = await llmLimiter.run(async () => await callClaude(chartPrompt, 500));
           const firstBrace = chartRes.indexOf('{');
           const lastBrace = chartRes.lastIndexOf('}');
           if (firstBrace !== -1 && lastBrace !== -1) {
              const parsedChart = JSON.parse(chartRes.substring(firstBrace, lastBrace + 1));
              
              const chartId = await createChart(
                conversationId,
                answerId,
                parsedChart.title || 'Data Chart',
                parsedChart.chartType || 'bar',
                parsedChart.config || {},
                parsedChart.data || {}
              );
              
              chartDataToEmbed = parsedChart;
              if (!responsePayload.charts) responsePayload.charts = [];
              responsePayload.charts.push({
                 id: chartId,
                 title: parsedChart.title,
                 chartType: parsedChart.chartType,
                 config: parsedChart.config,
                 data: parsedChart.data
              });
           }
         } catch (e) {
           console.warn('[Chat] Chart generation failed:', e.message);
         }
      }

      // ============================================================
      // 6. Document/File Generation (PDF, DOCX, PPTX, XLSX, etc.)
      // ============================================================
      // Determine actual format — for CONVERT, use the target format
      const effectiveIntent = intentJson.intent;
      const requestedFormat = artifactRequested && effectiveIntent !== 'VISUALIZE'
        ? intentJson.requestedFormat
        : null;
      const allDocFormats = ['pptx', 'pdf', 'docx', 'xlsx', 'ods', 'csv', 'tsv', 'rtf', 'txt', 'md', 'html', 'json'];
      if (requestedFormat && allDocFormats.includes(requestedFormat)) {
         // Determine if we should reuse a diagram
         let diagramDataToEmbed = null;
         if (intentJson.outputs && intentJson.outputs.diagram) {
            // They asked for a diagram in this turn, and we just generated it
            diagramDataToEmbed = currentSvgConfig;
         } else if (previousSvgArtifact) {
            // They asked to convert "this" (the previous diagram) into a PPT
            diagramDataToEmbed = previousSvgArtifact.validatedData;
         }

         const docConfig = {
            template: intentJson.template || 'auto',
            theme: intentJson.theme || 'auto',
            palette: intentJson.palette || 'auto',
            sourceDocuments,
            embeddedDiagram: diagramDataToEmbed, // Pass the diagram JSON to the file generator
            embeddedChart: chartDataToEmbed      // Pass the chart JSON to the file generator
         };

         // Build document content — always prefer the grounded answer over raw chunk dumps
         const drafted = resolvedContext
           ? resolvedContext.answerText
           : answer;
         if (!drafted || !drafted.trim()) {
           throw new Error('No validated answer is available for artifact generation');
         }

         // Use LLM-generated topic filename if available, otherwise derive from query
         const topicFilename = (preflightRes && preflightRes.topic)
           ? preflightRes.topic
           : null;
         const topicHint = topicFilename
           ? topicFilename.replace(/_/g, ' ')
           : (() => {
               const cmdPattern = /^(create|generate|make|build|prepare|export|give|download|show|explain|provide|produce|turn|convert|put)\s+(a |an |the |me |this |that |it )*/i;
               return query.replace(cmdPattern, '').replace(/\s*(professional|based on|from|about|for|in|into|using|with)\s*/gi, ' ').trim() || 'Document';
             })();

         const { buffer, mime, title } = await generateFile(requestedFormat, drafted, topicHint, docConfig);

         // Validate artifact integrity
         if (!buffer || buffer.length === 0) {
            throw new Error(`Generated ${requestedFormat} is empty`);
         }
         if (requestedFormat === 'pdf') {
            if (buffer.toString('utf8', 0, 5) !== '%PDF-') throw new Error("Generated PDF has invalid signature");
         } else if (['docx', 'pptx', 'xlsx', 'ods'].includes(requestedFormat)) {
            if (buffer.toString('utf8', 0, 2) !== 'PK') throw new Error(`Generated ${requestedFormat} has invalid signature`);
         } else if (requestedFormat === 'json') {
            try { JSON.parse(buffer.toString('utf8')); } catch (e) { throw new Error('Generated JSON is not valid'); }
         }

         const safeTitle = (title || topicHint || 'document').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'document';
         const filename = `${safeTitle}.${requestedFormat}`;
         const storageKey = `${sessionOrgId}/artifacts/${conversationId}_${Date.now()}.${requestedFormat}`;

         await storage.put(buffer, storageKey, mime);

         // Verify artifact persisted
         const exists = await storage.exists(storageKey);
         if (!exists) throw new Error("Artifact failed to persist");
         const metadata = await storage.metadata(storageKey);
         if (!metadata || metadata.size === 0) throw new Error("Artifact persisted with 0 size");

         // Save artifact with full provenance linked to the resolved answer
         const artifactId = await memory.addArtifact(
            conversationId,
            answerId,
            sourceDocumentIds,
            sourceChunkIds,
            requestedFormat,
            docConfig,
            { title: safeTitle },
            storageKey,
            sessionOrgId,
            { filename, mimeType: mime, sizeBytes: buffer.length }
         );
         generatedArtifactIds.push(artifactId);

         responsePayload.document = {
           downloadUrl: `/api/chat/download/${artifactId}?filename=${encodeURIComponent(filename)}`,
           filename,
           format: requestedFormat,
           mimeType: mime,
           sizeBytes: buffer.length,
           artifactId
         };

         // For CREATE_AND_DOWNLOAD: return file reference immediately after generation
         if (effectiveIntent === 'CREATE_AND_DOWNLOAD') {
           console.log(`[CREATE_AND_DOWNLOAD] Artifact ${artifactId} created and ready for download.`);
         }
      }

      // Save Assistant Message with provenance
      responsePayload.artifacts = generatedArtifactIds;
      const assistantMessageId = await memory.addMessage(
        conversationId, 'assistant', answer, sourceChunkIds, generatedArtifactIds, sourceDocumentIds, answerId
      );
      await memory.attachArtifactsToMessage(generatedArtifactIds, assistantMessageId);
      responsePayload.messageId = assistantMessageId;
      if (responsePayload.document) responsePayload.document.sourceMessageId = assistantMessageId;
      if (responsePayload.diagram) responsePayload.diagram.sourceMessageId = assistantMessageId;

      // Save context snapshot
      await saveContextSnapshot(conversationId, userMessageId, assistantMessageId, {
         intent: intentJson,
         sourceDocumentIds,
         generatedArtifactIds
      });

      // Update Summary if needed
      if (await shouldUpdateSummary(conversationId)) {
        const { buildSummaryPrompt } = require('../lib/claude');
        const summaryPrompt = buildSummaryPrompt(historyForLLM.concat([{role: 'assistant', content: answer}]), summaryText);
        try {
          const newSummary = await llmLimiter.run(async () => await callClaude(summaryPrompt, 500));
          await updateSummary(conversationId, newSummary.trim());
          responsePayload.newSummary = newSummary.trim();
        } catch(e) {
          console.warn('[Chat] Failed to update summary:', e);
        }
      }

      res.json(responsePayload);
    });
  } catch (e) {
    if (e instanceof QuotaExhaustedError) {
      console.error('[Chat] Daily quota exhausted:', e.message);
      return res.status(503).json({ error: e.message });
    }
    console.error('[Chat] Internal endpoint error:', e);
    if (e.message && (e.message.includes('Network error') || e.message.includes('Groq API error') || e.message.includes('rate limit'))) {
      return res.status(503).json({ error: 'The AI model service is temporarily unavailable. Please try again later.' });
    }
    res.status(500).json({ error: 'The requested artifact or response could not be generated at this time. Please try again.' });
  }
});

// Rehydrate a persisted conversation after a page refresh or return visit.
// The server remains authoritative: the requested conversation must belong to
// the signed-in user and organization before any content or download link is
// returned.
router.get('/history/:conversationId', async (req, res) => {
  try {
    const sessionUserId = req.session?.user?.id || 'anonymous';
    const sessionOrgId = req.session?.user?.organizationId || defaultOrgId;
    const conversation = await memory.getConversation(req.params.conversationId);
    if (!conversation || conversation.user_identifier !== sessionUserId || conversation.organization_id !== sessionOrgId) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    const [messages, artifacts, summary, charts, context] = await Promise.all([
      memory.getMessages(conversation.id, 1000),
      memory.getArtifacts(conversation.id, 1000),
      getSummary(conversation.id),
      getCharts(conversation.id),
      getLatestContext(conversation.id)
    ]);
    const kb = await loadKB(conversation.organization_id || 'org_default');
    const documentById = new Map(kb.docs.map(document => [document.id || document.documentId, document]));
    const artifactById = new Map(artifacts.map(artifact => [artifact.id, artifact]));
    const toSourceDocuments = ids => (ids || []).map(id => {
      const document = documentById.get(id);
      return document ? {
        id,
        name: document.name || document.originalFilename,
        downloadUrl: `/api/chat/source/${encodeURIComponent(id)}`
      } : null;
    }).filter(Boolean);
    const toArtifactPayload = artifact => {
      const filename = artifact.filename || `${artifact.id}.${artifact.format}`;
      const downloadUrl = `/api/chat/download/${artifact.id}?filename=${encodeURIComponent(filename)}`;
      if (artifact.format === 'svg') {
        return {
          id: artifact.id,
          format: artifact.format,
          diagram: {
            svg: artifact.validatedData ? generateSvg(artifact.validatedData) : '',
            filename,
            downloadUrl,
            sourceMessageId: artifact.sourceMessageId
          }
        };
      }
      return {
        id: artifact.id,
        format: artifact.format,
        document: {
          artifactId: artifact.id,
          format: artifact.format,
          filename,
          downloadUrl,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sourceMessageId: artifact.sourceMessageId
        }
      };
    };

    const history = messages.map(message => {
      const linkedArtifacts = artifacts.filter(artifact => artifact.sourceMessageId === message.id);
      const legacyArtifacts = (message.artifactIds || []).map(id => artifactById.get(id)).filter(Boolean);
      const uniqueArtifacts = [...new Map([...linkedArtifacts, ...legacyArtifacts].map(artifact => [artifact.id, artifact])).values()];
      const artifactPayloads = uniqueArtifacts.map(toArtifactPayload);
      const diagram = artifactPayloads.find(item => item.diagram)?.diagram;
      const document = artifactPayloads.find(item => item.document)?.document;
      return {
        messageId: message.id,
        role: message.role,
        content: message.content,
        answer: message.role === 'assistant' ? message.content : undefined,
        answerId: message.answerId,
        grounded: Boolean(message.answerId),
        sourceDocuments: toSourceDocuments(message.sourceDocIds),
        artifacts: uniqueArtifacts.map(artifact => artifact.id),
        document,
        diagram
      };
    });

    res.json({ 
      conversationId: conversation.id, 
      history, 
      summary: summary || { summary_text: null }, 
      charts: charts || [], 
      context: context || {} 
    });
  } catch (error) {
    console.error('Conversation history error:', error);
    res.status(503).json({ error: 'Conversation history is temporarily unavailable.' });
  }
});

// Download a generated artifact — enforces user/org RBAC before streaming.
router.get('/download/:id', async (req, res) => {
  try {
    const artifactId = req.params.id;
    const sessionUserId = req.session?.user?.id || 'anonymous';
    const sessionOrgId = req.session?.user?.organizationId || defaultOrgId;
    const { query: dbQuery } = require('../lib/db');

    // RBAC: Validate artifact ownership — user must own the conversation
    const artifactRes = await dbQuery(`
      SELECT a.*, c.user_identifier, c.organization_id AS conversation_organization_id
      FROM artifacts a
      JOIN conversations c ON a.conversation_id = c.id
      WHERE a.id = $1
        AND a.organization_id IS NOT NULL
        AND a.organization_id = $2
        AND c.organization_id = $2
    `, [artifactId, sessionOrgId]);

    if (artifactRes.rows.length === 0) {
      return res.status(404).json({ error: 'Artifact not found.' });
    }

    const artifact = artifactRes.rows[0];

    // Authorization check — changing artifact ID in URL must not bypass this
    if (artifact.user_identifier !== sessionUserId || artifact.organization_id !== sessionOrgId || artifact.conversation_organization_id !== sessionOrgId) {
      console.warn(`[AUTH] Download denied: user ${sessionUserId} attempted to access artifact ${artifactId} owned by ${artifact.user_identifier}`);
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (!artifact.storage_key) {
      return res.status(404).json({ error: 'Artifact file not found.' });
    }

    const exists = await storage.exists(artifact.storage_key);
    if (!exists) {
      return res.status(404).json({ error: 'Artifact file not found in storage.' });
    }

    const format = artifact.format;
    const filename = req.query.filename || `download.${format}`;
    const { MIME } = require('../lib/fileGenerators');
    const mimeType = MIME[format] || (format === 'svg' ? 'image/svg+xml' : 'application/octet-stream');

    res.setHeader('Content-Type', mimeType);
    const safeFilename = filename.replace(/["\r\n]/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"`);

    try {
      const metadata = await storage.metadata(artifact.storage_key);
      if (metadata && metadata.size) res.setHeader('Content-Length', metadata.size);
    } catch (_) { /* ignore metadata errors */ }

    const stream = await storage.getStream(artifact.storage_key);
    stream.pipe(res);

  } catch (err) {
    console.error('Download error:', err);
    res.status(503).json({ error: 'Artifact storage temporarily unavailable.' });
  }
});

// Download an original authorized Knowledge Base document.
router.get('/source/:id', async (req, res) => {
  try {
    const sessionOrgId = req.session?.user?.organizationId || defaultOrgId;
    const documentRes = await query(`
      SELECT id, original_filename, mime_type, storage_key
      FROM documents
      WHERE id = $1 AND organization_id = $2
    `, [req.params.id, sessionOrgId]);
    if (!documentRes.rows.length) return res.status(404).json({ error: 'Source document not found.' });

    const document = documentRes.rows[0];
    if (!document.storage_key || !(await storage.exists(document.storage_key))) {
      return res.status(404).json({ error: 'Source document file not found.' });
    }

    res.setHeader('Content-Type', document.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(document.original_filename.replace(/["\r\n]/g, ''))}"`);
    const metadata = await storage.metadata(document.storage_key);
    if (!metadata || !metadata.size) return res.status(404).json({ error: 'Source document is empty.' });
    res.setHeader('Content-Length', metadata.size);
    const stream = await storage.getStream(document.storage_key);
    stream.pipe(res);
  } catch (error) {
    console.error('Source download error:', error);
    res.status(503).json({ error: 'Source document storage temporarily unavailable.' });
  }
});

// --- New Endpoints for Persistent History, Summary, and Charts ---

// List sessions
router.get('/sessions', async (req, res) => {
  try {
    const sessionUserId = req.session?.user?.id || 'anonymous';
    const sessionOrgId = req.session?.user?.organizationId || defaultOrgId;
    const conversations = await memory.listConversations(sessionUserId, sessionOrgId);
    res.json(conversations);
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Delete session
router.delete('/sessions/:id', async (req, res) => {
  try {
    const sessionUserId = req.session?.user?.id || 'anonymous';
    const sessionOrgId = req.session?.user?.organizationId || defaultOrgId;
    const conversation = await memory.getConversation(req.params.id);
    if (!conversation || conversation.user_identifier !== sessionUserId || conversation.organization_id !== sessionOrgId) {
      return res.status(404).json({ error: 'Session not found' });
    }
    await query(`DELETE FROM conversations WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete session error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Rename and pin/unpin a conversation. Ownership is verified before every
// mutation so a valid session cannot alter another user's chat metadata.
router.patch('/sessions/:id', async (req, res) => {
  try {
    const sessionUserId = req.session?.user?.id || 'anonymous';
    const sessionOrgId = req.session?.user?.organizationId || defaultOrgId;
    const conversation = await memory.getConversation(req.params.id);
    if (!conversation || conversation.user_identifier !== sessionUserId || conversation.organization_id !== sessionOrgId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const updates = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'title')) {
      const title = String(req.body.title || '').replace(/\s+/g, ' ').trim();
      if (!title) return res.status(400).json({ error: 'Conversation name cannot be empty.' });
      if (title.length > 80) return res.status(400).json({ error: 'Conversation name must be 80 characters or fewer.' });
      updates.title = title;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'pinned')) {
      if (typeof req.body.pinned !== 'boolean') return res.status(400).json({ error: 'Pinned must be true or false.' });
      updates.isPinned = req.body.pinned;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No conversation update was provided.' });

    await memory.updateConversationState(req.params.id, updates);
    const updated = await memory.getConversation(req.params.id);
    res.json({ id: updated.id, title: updated.title, is_pinned: updated.is_pinned, updated_at: updated.updated_at });
  } catch (err) {
    console.error('Update session error:', err);
    res.status(500).json({ error: 'Failed to update conversation.' });
  }
});

// Get session summary
router.get('/sessions/:id/summary', async (req, res) => {
  try {
    const summary = await getSummary(req.params.id);
    res.json(summary || { summary_text: null });
  } catch (err) {
    console.error('Get summary error:', err);
    res.status(500).json({ error: 'Failed to get summary' });
  }
});

// Get session context
router.get('/sessions/:id/context', async (req, res) => {
  try {
    const context = await getLatestContext(req.params.id);
    res.json(context || {});
  } catch (err) {
    console.error('Get context error:', err);
    res.status(500).json({ error: 'Failed to get context' });
  }
});

// Get session charts
router.get('/sessions/:id/charts', async (req, res) => {
  try {
    const charts = await getCharts(req.params.id);
    res.json(charts);
  } catch (err) {
    console.error('Get charts error:', err);
    res.status(500).json({ error: 'Failed to get charts' });
  }
});

// Create manual chart
router.post('/sessions/:id/charts', async (req, res) => {
  try {
    const { sourceMessageId, title, chartType, config, data } = req.body;
    const chartId = await createChart(req.params.id, sourceMessageId, title, chartType, config, data);
    res.json({ id: chartId });
  } catch (err) {
    console.error('Create chart error:', err);
    res.status(500).json({ error: 'Failed to create chart' });
  }
});

// Get single chart
router.get('/charts/:id', async (req, res) => {
  try {
    const chart = await getChart(req.params.id);
    if (!chart) return res.status(404).json({ error: 'Chart not found' });
    res.json(chart);
  } catch (err) {
    console.error('Get chart error:', err);
    res.status(500).json({ error: 'Failed to get chart' });
  }
});

// Update chart
router.put('/charts/:id', async (req, res) => {
  try {
    const { config, data } = req.body;
    const newId = await updateChart(req.params.id, config, data);
    if (!newId) return res.status(404).json({ error: 'Chart not found' });
    res.json({ id: newId });
  } catch (err) {
    console.error('Update chart error:', err);
    res.status(500).json({ error: 'Failed to update chart' });
  }
});

// Delete chart
router.delete('/charts/:id', async (req, res) => {
  try {
    await deleteChart(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete chart error:', err);
    res.status(500).json({ error: 'Failed to delete chart' });
  }
});

module.exports = router;
