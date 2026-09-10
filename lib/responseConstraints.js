/**
 * Deterministic response constraints that must be honored even if a model
 * over-produces content. These operate on presentation only and do not add
 * facts that are absent from the grounded answer.
 */
function getExplicitWordCount(query) {
  const match = String(query || '').match(/\b(?:in|within|under|about|around|exactly|just)?\s*(\d{1,4})\s*words?\b/i);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  return Number.isInteger(count) && count >= 1 && count <= 2000 ? count : null;
}

function toPlainSummaryText(value) {
  return String(value || '')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\*{1,3}|_{1,3}|`/g, '')
    .replace(/\s*\(Source:\s*[^)]+\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanUnprofessionalCitations(text) {
  return String(text || '')
    .replace(/\s*\(\s*Source\s*:\s*Chunk\s*\d+[^)]*\)/gi, '')
    .replace(/\s*\(Source:\s*Chunk[^)]+\)/gi, '')
    .replace(/\s*Chunk\s*\d+/gi, '')
    .replace(/(\(Source:\s*[^)]+\))\s*\1+/gi, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function applyWordCountLimit(answer, requestedWordCount) {
  let cleaned = cleanUnprofessionalCitations(answer);
  if (!requestedWordCount) return cleaned;
  
  const words = cleaned.match(/\S+/g) || [];
  // Allow a +15% margin over the requested word count before hard truncating
  const maxWords = Math.ceil(requestedWordCount * 1.15);
  if (words.length <= maxWords) return cleaned;
  
  // If text significantly exceeds target, trim cleanly at a sentence or word boundary
  const shortened = words.slice(0, requestedWordCount).join(' ').replace(/[,:;]+$/g, '');
  return /[.!?]$/.test(shortened) ? shortened : `${shortened}.`;
}

module.exports = { getExplicitWordCount, toPlainSummaryText, applyWordCountLimit, cleanUnprofessionalCitations };
