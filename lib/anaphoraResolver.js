const { getExplicitWordCount } = require('./responseConstraints');

/**
 * Detects whether the query intends to refer to local/active context 
 * (via pronouns or summarization verbs) rather than executing a new global search.
 */
function detectLocalContextIntent(query) {
  const text = String(query || '').toLowerCase();
  
  // 1. Detect deictic/anaphoric pronouns
  const hasPronoun = /\b(this|that|it|these|those|the above|previous|current|selected document)\b/i.test(text);
  
  // 2. Detect summarization or transformation intent
  const isSummarization = /\b(summarize|summary|summarise|key points|bullet points|shorten|condense|rephrase|rewrite|simplify|translate|professional)\b/i.test(text);
  
  // 3. Detect word count constraints
  const hasWordCount = getExplicitWordCount(query) !== null;

  // 4. Detect explicit new-topic questions which override pronouns if mixed (rare but possible)
  const isExplicitNewTopic = /\b(explain|describe|what|why|how|which|define|tell|compare) (?!this|that|it|these|those|the above|previous|current)\b/i.test(text) && !isSummarization && !hasWordCount;

  if (isExplicitNewTopic) {
    return { isLocalReference: false, isSummarization: false, reason: 'Explicit new topic question' };
  }

  if (isSummarization || hasWordCount) {
    return { isLocalReference: true, isSummarization: true, reason: 'Summarization or transformation intent detected' };
  }

  if (hasPronoun) {
    return { isLocalReference: true, isSummarization: false, reason: 'Deictic pronoun reference detected' };
  }

  return { isLocalReference: false, isSummarization: false, reason: 'No local reference detected' };
}

/**
 * Decides whether vector retrieval should be bypassed.
 * Bypassing is allowed if it's a local reference AND we actually have local text to fall back on.
 */
function shouldBypassRetrieval(query, resolvedContext, activeDocumentText) {
  const intent = detectLocalContextIntent(query);
  
  if (!intent.isLocalReference) {
    return false;
  }

  // If we have text from a previously grounded answer, we can bypass RAG
  if (resolvedContext && resolvedContext.answerText && resolvedContext.answerText.trim().length > 50) {
    return true;
  }

  // If we have full text from an explicitly selected active document, we can bypass RAG
  // because we will inject the document text directly into the prompt.
  if (activeDocumentText && activeDocumentText.trim().length > 50) {
    return true;
  }

  // Even if they said "Summarize this", if we have no prior answer and no active document, 
  // we cannot bypass because we have nothing to summarize!
  return false;
}

module.exports = {
  detectLocalContextIntent,
  shouldBypassRetrieval
};
