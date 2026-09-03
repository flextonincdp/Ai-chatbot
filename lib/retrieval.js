const { getPool } = require('./db');
const { getEmbeddingProvider } = require('./embeddings');

// Simple, dependency-free lexical retrieval (term-frequency scoring).
// Good enough for small/medium knowledge bases without needing an
// embeddings API or a vector database. Swap this out for real embeddings
// later if the KB grows large — see README.

const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','to','of','and','or',
  'in','on','for','with','that','this','it','as','at','by','from','what','how','did','does','do',
  'can','could','would','should','will','shall','which','who','whom','i','you','we','they']);

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9]+/g)) || [];
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function documentTitleMatchesQuery(candidate, query) {
  const titleTerms = tokenize(candidate.docName || candidate.documentName || '');
  const queryTerms = tokenize(query).filter(term => !STOPWORDS.has(term));
  if (titleTerms.length < 2 || queryTerms.length < 2) return false;

  const title = ` ${titleTerms.join(' ')} `;
  // A two-or-more word query phrase in a document title is a strong, generic
  // indication that the user named that document. Prefer it over coincidental
  // embedding similarity from unrelated material.
  for (let size = Math.min(4, queryTerms.length); size >= 2; size--) {
    for (let start = 0; start <= queryTerms.length - size; start++) {
      if (title.includes(` ${queryTerms.slice(start, start + size).join(' ')} `)) return true;
    }
  }
  return false;
}

function preferNamedDocuments(scored, query) {
  const explicitlyNamed = scored.filter(candidate => documentTitleMatchesQuery(candidate, query));
  // A comparison often names multiple sources. If title matching finds only
  // one of them (for example, "policy and deployment guide"), do not discard
  // the other semantically relevant source just because its title uses a
  // shorter or different form of the name.
  const requestsMultipleSources = /\b(?:and|vs\.?|versus|between|across|compare)\b/i.test(query || '');
  if (requestsMultipleSources && explicitlyNamed.length < 2) return scored;
  return explicitlyNamed.length ? explicitlyNamed : scored;
}

function includeNamedDocumentCandidates(selected, allChunks, query) {
  const result = [...selected];
  const selectedIds = new Set(result.map(chunk => chunk.id));
  const addedDocuments = new Set();
  for (const chunk of allChunks || []) {
    const documentKey = chunk.docId || chunk.documentId || chunk.docName || chunk.id;
    if (documentTitleMatchesQuery(chunk, query) && !selectedIds.has(chunk.id) && !addedDocuments.has(documentKey)) {
      result.push(chunk);
      selectedIds.add(chunk.id);
      addedDocuments.add(documentKey);
    }
  }
  return result;
}

/**
 * Converts retrieval candidates into final evidence. Retrieval rank is only
 * a candidate signal; every chunk must also match the query semantically.
 */
async function selectRelevantChunks(candidates, query) {
  if (!candidates || !candidates.length) return [];
  const provider = getEmbeddingProvider();
  if (provider.isConfigured()) {
    try {
      const vectors = await provider.generateEmbeddings([query, ...candidates.map(c => c.text || '')]);
      const scored = candidates.map((candidate, index) => ({
        ...candidate,
        relevanceScore: cosineSimilarity(vectors[0], vectors[index + 1])
      })).sort((a, b) => b.relevanceScore - a.relevanceScore);
      const eligible = preferNamedDocuments(scored, query);
      const best = eligible[0].relevanceScore;
      const threshold = Math.max(0.30, best - 0.12);
      return eligible.filter(candidate => candidate.relevanceScore >= threshold);
    } catch (error) {
      console.warn('[Retrieval] Evidence embedding failed; using conservative lexical boundary:', error.message);
    }
  }

  const queryTerms = new Set(tokenize(query));
  const scored = candidates.map(candidate => {
    const terms = new Set(tokenize(candidate.text));
    const overlap = [...queryTerms].filter(term => terms.has(term)).length;
    return { ...candidate, relevanceScore: queryTerms.size ? overlap / queryTerms.size : 0 };
  }).sort((a, b) => b.relevanceScore - a.relevanceScore);
  const eligible = preferNamedDocuments(scored, query);
  const best = eligible[0].relevanceScore;
  return best > 0 ? eligible.filter(candidate => candidate.relevanceScore >= Math.max(0.5, best - 0.25)) : [];
}

async function validateAnswerGrounding(answer, query, evidence) {
  if (!answer || !evidence || !evidence.length) return false;
  const provider = getEmbeddingProvider();
  try {
    // Citations are required in generated answers, but they are metadata rather
    // than factual claims.  Splitting on punctuation used to turn a trailing
    // `(Source: file.docx)` citation into its own sentence, which then failed
    // the similarity check and rejected otherwise grounded answers.
    const cleanAnswer = answer
      .replace(/<[^>]+>/g, ' ')
      .replace(/\(\s*source\s*:\s*[^)]+\)/gi, ' ')
      .replace(/\[\s*source\s*:\s*[^\]]+\]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const sentences = cleanAnswer.split(/[.!?]+/).map(sentence => sentence.trim()).filter(sentence => sentence.length > 20);
    if (!sentences.length) return false;
    const vectors = await provider.generateEmbeddings([query, ...evidence.map(c => c.text || ''), ...sentences]);
    const evidenceVectors = vectors.slice(1, evidence.length + 1);
    const answerVectors = vectors.slice(evidence.length + 1);
    return answerVectors.every(sentenceVector => Math.max(...evidenceVectors.map(evidenceVector => cosineSimilarity(sentenceVector, evidenceVector))) >= 0.30);
  } catch (error) {
    console.warn('[Retrieval] Answer grounding validation unavailable:', error.message);
    return false;
  }
}

// Keep the original lexical retrieval exact logic
function retrieveTopChunksLexical(kb, query, k = 5, organizationId = 'org_default') {
  const qTerms = tokenize(query).filter(t => !STOPWORDS.has(t));
  if (!qTerms.length || !kb.chunks.length) return [];
  const scored = kb.chunks
    .filter(c => !organizationId || c.orgId === organizationId || (c.orgId === undefined && organizationId === 'org_default'))
    .map(c => {
      const cTerms = tokenize(c.text);
      let score = 0;
      qTerms.forEach(qt => {
        score += cTerms.filter(ct => ct === qt || ct.includes(qt)).length;
      });
      return { ...c, score };
    }).filter(c => c.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return includeNamedDocumentCandidates(scored.slice(0, k), scored, query);
}

// New Hybrid Retrieval
async function retrieveTopChunks(kb, query, k = 5, organizationId = 'org_default') {
  const pool = getPool();
  const provider = getEmbeddingProvider();
  
  // If no DB pool or embedding provider is not configured, fallback to purely lexical
  if (!pool || !provider.isConfigured()) {
    return retrieveTopChunksLexical(kb, query, k, organizationId);
  }

  // Check if there are any embeddings in the DB to search against
  let hasEmbeddings = false;
  try {
    const embCount = await pool.query('SELECT COUNT(*) FROM embeddings LIMIT 1');
    hasEmbeddings = parseInt(embCount.rows[0].count, 10) > 0;
  } catch (e) {
    // DB query failed, fallback to lexical
  }

  if (!hasEmbeddings) {
    return retrieveTopChunksLexical(kb, query, k, organizationId);
  }

  try {
    // 1. Vector Search
    const qEmbed = await provider.generateEmbedding(query);
    // Assuming L2 distance (`<->`) or inner product (`<#>`) or cosine (`<=>`).
    // Using Cosine distance as it's common for OpenAI embeddings.
    const vectorRes = await pool.query(`
      SELECT 
        c.id, 
        c.content as text, 
        d.id as "docId",
        d.original_filename as docName,
        1 - (e.embedding <=> $1::vector) as vector_score
      FROM chunks c
      JOIN embeddings e ON e.chunk_id = c.id
      JOIN document_versions dv ON c.document_version_id = dv.id
      JOIN documents d ON dv.document_id = d.id
      WHERE dv.status = 'READY' AND d.organization_id = $3
      ORDER BY e.embedding <=> $1::vector ASC
      LIMIT $2
    `, [`[${qEmbed.join(',')}]`, k * 2, organizationId]);
    
    const vectorCandidates = vectorRes.rows;

    // 2. Lexical Search on DB results or existing KB chunks
    // Since we want true hybrid, we can run lexical on the entire KB or just on DB
    // To match original exactly, we'll run it against the existing kb.chunks
    const lexicalCandidates = retrieveTopChunksLexical(kb, query, Math.max(k * 2, 50), organizationId);

    // 3. Reciprocal Rank Fusion (RRF)
    const rrfK = 60;
    const scores = new Map(); // id -> score
    const chunksDict = new Map();

    const addScore = (chunk, rank, isVector) => {
      const id = chunk.id;
      if (!scores.has(id)) scores.set(id, 0);
      scores.set(id, scores.get(id) + 1.0 / (rrfK + rank));
      if (!chunksDict.has(id)) {
        chunksDict.set(id, {
          id: chunk.id,
          text: chunk.text,
          docId: chunk.docId || chunk.documentId,
          docName: chunk.docName || chunk.docname,
          score: 0
        });
      }
    };

    vectorCandidates.forEach((c, idx) => addScore(c, idx + 1, true));
    lexicalCandidates.forEach((c, idx) => addScore(c, idx + 1, false));

    const final = Array.from(chunksDict.values()).map(c => {
      c.score = scores.get(c.id);
      return c;
    });

    final.sort((a, b) => b.score - a.score);
    // Include only documents that the query explicitly names; do not append a
    // representative from every document in the organization.
    return includeNamedDocumentCandidates(final.slice(0, Math.max(k, 25)), kb.chunks, query);

  } catch (err) {
    console.error('[Retrieval] Vector search failed, falling back to keyword search.', err.message);
    return retrieveTopChunksLexical(kb, query, k, organizationId);
  }
}

module.exports = { retrieveTopChunks, retrieveTopChunksLexical, selectRelevantChunks, validateAnswerGrounding, tokenize, documentTitleMatchesQuery };
