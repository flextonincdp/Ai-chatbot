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

// DOCX extraction can contain the original image as a data URI.  Those strings
// are not searchable knowledge and, when they become a retrieval candidate,
// their embedding can crowd out the document's actual text.
function searchableText(text) {
  return String(text || '')
    .replace(/!?\[[^\]]*\]\(data:[^)]+\)/gi, ' ')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, ' ')
    // Extractors can split a data URI across chunks, leaving base64 fragments
    // without the `data:image` prefix. Natural-language text never contains
    // one uninterrupted 32-character base64 token.
    .replace(/[a-z0-9+/=]{32,}/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasEmbeddedBinary(text) {
  return /data:image\//i.test(String(text || '')) || /[a-z0-9+/=]{32,}/i.test(String(text || ''));
}

function isSearchableChunk(chunk) {
  // A meaningful sentence is long enough to produce a useful embedding.  This
  // also removes image-only chunks without excluding short factual entries.
  return searchableText(chunk && chunk.text).length >= 20;
}

function lexicalScore(chunk, queryTerms) {
  const chunkTerms = tokenize(searchableText(chunk.text));
  return queryTerms.reduce(
    (score, term) => score + chunkTerms.filter(chunkTerm => chunkTerm === term || chunkTerm.includes(term)).length,
    0
  );
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
  const queryTerms = tokenize(query).filter(term => !STOPWORDS.has(term));
  const namedDocuments = new Map();

  for (const chunk of allChunks || []) {
    if (!documentTitleMatchesQuery(chunk, query) || !isSearchableChunk(chunk)) continue;
    const documentKey = chunk.docId || chunk.documentId || chunk.docName || chunk.id;
    if (!namedDocuments.has(documentKey)) namedDocuments.set(documentKey, []);
    namedDocuments.get(documentKey).push(chunk);
  }

  // Do not settle for the first stored chunk of a named document: it is often
  // a cover image.  Give the semantic selector a small set of the document's
  // clean, lexically relevant text chunks instead.
  for (const chunks of namedDocuments.values()) {
    chunks
      .map(chunk => ({ chunk, score: lexicalScore(chunk, queryTerms) }))
      .sort((left, right) => right.score - left.score || searchableText(right.chunk.text).length - searchableText(left.chunk.text).length)
      .slice(0, 5)
      .forEach(({ chunk }) => {
        if (!selectedIds.has(chunk.id)) {
          result.push(chunk);
          selectedIds.add(chunk.id);
        }
      });
  }
  return result;
}

function validateContextScope(chunks, intentJson, query) {
  if (!intentJson) return chunks;
  
  const targetDoc = String(intentJson.targetDocument || '').toLowerCase();
  const topic = String(intentJson.topic || '').toLowerCase();
  const allowCrossDocument = /\b(across|all|compare)\b/i.test(query);

  return chunks.filter(chunk => {
    // 1. Scope Relevance
    if (targetDoc && targetDoc !== 'null' && !allowCrossDocument) {
      const docName = String(chunk.docName || chunk.documentName || '').toLowerCase();
      // If the target document is specified, and this chunk's document doesn't match it (or substring), reject.
      if (!docName.includes(targetDoc) && !targetDoc.includes(docName.replace(/\.[^/.]+$/, ''))) {
        chunk.rejectReason = `Document mismatch: expected ${targetDoc}, got ${docName}`;
        return false;
      }
    }
    
    // 2. Semantic Relevance
    // Removed strict lexical topic rejection. If a chunk made it this far,
    // it has already passed the vector similarity threshold. Requiring literal
    // keywords defeats the purpose of semantic search and discards adjacent
    // highly-relevant context that simply doesn't repeat the section heading.

    return true;
  });
}

// Candidate retrieval can be internally consistent while still answering a
// previous topic. This independent check asks whether the *evidence* aligns
// with the current request; it deliberately does not use summaries/history.
function hasQueryAlignment(query, chunk) {
  const queryTerms = tokenize(query).filter(term => !STOPWORDS.has(term));
  const evidenceTerms = new Set(tokenize(searchableText(chunk.text)));
  if (!queryTerms.length) return false;
  const overlap = queryTerms.filter(term => evidenceTerms.has(term) || [...evidenceTerms].some(value => value.includes(term) || term.includes(value))).length;
  // A phrase named in a document title is also an explicit document scope,
  // but must not by itself make unrelated document content answer the query.
  return overlap > 0;
}

function scopeTokens(value) {
  return tokenize(value).filter(term => !STOPWORDS.has(term)).map(term => {
    if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`;
    return term.endsWith('s') && term.length > 3 ? term.slice(0, -1) : term;
  });
}

function headingMatchesScope(heading, scope) {
  const requested = scopeTokens(scope);
  const actual = new Set(scopeTokens(heading));
  return requested.length > 0 && requested.every(term => actual.has(term));
}

function isRequestedParentScope(chunk, intentJson) {
  const topic = String(intentJson && intentJson.topic || '').trim();
  const parents = chunk && chunk.metadata && Array.isArray(chunk.metadata.parentHeadings)
    ? chunk.metadata.parentHeadings : [];
  return Boolean(topic && parents.some(heading => headingMatchesScope(heading, topic)));
}

function requestedParentHeading(chunks, intentJson) {
  const topic = String(intentJson && intentJson.topic || '').trim();
  if (!topic) return null;
  for (const chunk of chunks || []) {
    const parents = chunk && chunk.metadata && Array.isArray(chunk.metadata.parentHeadings)
      ? chunk.metadata.parentHeadings : [];
    const match = [...parents].reverse().find(heading => headingMatchesScope(heading, topic));
    if (match) return match;
  }
  return null;
}

async function expandParentSectionCandidates(candidates, organizationId, intentJson) {
  if (!intentJson || !intentJson.targetDocument || !candidates.some(chunk => isRequestedParentScope(chunk, intentJson))) return candidates;
  const documentIds = [...new Set(candidates.map(chunk => chunk.docId || chunk.documentId).filter(Boolean))];
  if (!documentIds.length) return candidates;
  const pool = getPool();
  if (!pool) return candidates;
  const result = await pool.query(`
    SELECT c.id, c.chunk_index AS "chunkIndex", c.metadata, c.content AS text,
      d.id AS "docId", d.original_filename AS "docName"
    FROM chunks c
    JOIN document_versions dv ON c.document_version_id = dv.id
    JOIN documents d ON dv.document_id = d.id
    WHERE d.organization_id = $1 AND d.id = ANY($2::varchar[]) AND dv.status = 'READY'
    ORDER BY c.chunk_index ASC
  `, [organizationId, documentIds]);
  const byId = new Map(candidates.map(chunk => [chunk.id, chunk]));
  for (const chunk of result.rows) {
    if (isRequestedParentScope(chunk, intentJson) && !byId.has(chunk.id)) {
      byId.set(chunk.id, { ...chunk, section_scope_match: true });
    }
  }
  return [...byId.values()];
}

function orderChunksForPresentation(chunks) {
  const documentOrder = new Map();
  chunks.forEach(chunk => {
    const key = chunk.docId || chunk.documentId || chunk.docName || '';
    if (!documentOrder.has(key)) documentOrder.set(key, documentOrder.size);
  });
  return [...chunks].sort((left, right) => {
    const leftDoc = documentOrder.get(left.docId || left.documentId || left.docName || '') || 0;
    const rightDoc = documentOrder.get(right.docId || right.documentId || right.docName || '') || 0;
    if (leftDoc !== rightDoc) return leftDoc - rightDoc;
    const leftIndex = Number.isInteger(left.chunkIndex) ? left.chunkIndex : Number.MAX_SAFE_INTEGER;
    const rightIndex = Number.isInteger(right.chunkIndex) ? right.chunkIndex : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function explicitProperTopic(query) {
  // Preserve a user-supplied title/entity such as "The Entrepreneurial
  // State". Generic embedding similarity to an economic document is not
  // enough to prove that a specifically named work/topic is in the corpus.
  const raw = String(query || '').trim();
  const match = raw.match(/^(?:Explain|Describe|Define|Discuss|What is|Tell me about)\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Converts retrieval candidates into final evidence. Retrieval rank is only
 * a candidate signal; every chunk must also match the query semantically.
 */
async function selectRelevantChunks(candidates, query, intentJson) {
  if (!candidates || candidates.length === 0) return { top: [], rejected: [] };

  const MIN_RELEVANCE_SCORE = parseFloat(process.env.MIN_RELEVANCE_SCORE || '0.25');
  
  // If the query is globally scoped, be aggressive with lexical filtering to
  // avoid surfacing noise that happens to share rare words with the query.
  const isDocumentScoped = !!(intentJson && (intentJson.targetDocument || intentJson.activeDocumentId));
  const eligible = [];
  const rejected = candidates
    .filter(candidate => !isSearchableChunk(candidate))
    .map(candidate => ({ ...candidate, rejectReason: 'Chunk contains no searchable text' }));
  candidates = candidates.filter(isSearchableChunk);
  if (!candidates.length) return { top: [], rejected };

  const provider = getEmbeddingProvider();
  
  // Try to use existing vector_score (cosine similarity from pgvector) first.
  // If vector_score is missing (e.g. candidates came through RRF which only has
  // an RRF fusion score), we need to re-compute similarity via embeddings.
  let scored = [...candidates];
  let needsEmbedding = scored.some(c =>
    (c.vector_score === undefined && c.vector_score !== 0) || hasEmbeddedBinary(c.text)
  );
  
  if (needsEmbedding && provider.isConfigured()) {
    try {
      // Strip base64 data URIs from chunk text before embedding — they produce
      // garbage vectors and penalise chunks that contain real text alongside images.
      const textsToEmbed = [query, ...candidates.map(c => searchableText(c.text))];
      const vectors = await provider.generateEmbeddings(textsToEmbed);
      scored = candidates.map((candidate, index) => {
        const vectorScore = candidate.vector_score !== undefined && !hasEmbeddedBinary(candidate.text)
          ? candidate.vector_score : cosineSimilarity(vectors[0], vectors[index + 1]);
        return { ...candidate, text: searchableText(candidate.text), vector_score: vectorScore, relevanceScore: vectorScore };
      });
    } catch (error) {
      console.warn('[Retrieval] Evidence embedding failed; using conservative lexical boundary:', error.message);
      scored = scored.map(c => ({ ...c, text: searchableText(c.text), relevanceScore: c.vector_score || 0 }));
    }
  } else {
    // vector_score is the canonical cosine similarity (0..1, higher = better).
    // c.score is the RRF fusion score (~0.01–0.03) which is NOT a similarity —
    // never use it as a similarity threshold comparison.
    scored = scored.map(c => ({ ...c, text: searchableText(c.text), relevanceScore: c.vector_score ?? 0 }));
  }

  // Sort by relevance (cosine similarity, higher = better)
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  
  const namedPref = preferNamedDocuments(scored, query);
  const best = namedPref.length > 0 ? namedPref[0].relevanceScore : 0;
  
  // Threshold selection:
  // - Document-scoped queries: chunks are already from the named document,
  //   so use a very lenient threshold.
  // - Global queries: use a stricter threshold to filter cross-document noise.
  const threshold = isDocumentScoped
    ? Math.max(0.05, best * 0.3)
    : Math.max(MIN_RELEVANCE_SCORE, best - 0.15);
  
  console.log(`[Retrieval] isDocumentScoped=${isDocumentScoped} best=${best.toFixed(4)} threshold=${threshold.toFixed(4)} candidates=${namedPref.length}`);
  
  for (const c of namedPref) {
    if (c.relevanceScore >= threshold || isRequestedParentScope(c, intentJson)) {
      eligible.push(c);
    } else {
      c.rejectReason = `Low embedding similarity (${c.relevanceScore.toFixed(3)} < ${threshold.toFixed(3)})`;
      rejected.push(c);
    }
  }

  // Fallback if no eligible chunks and we never had any embeddings
  if (eligible.length === 0 && !provider.isConfigured() && !candidates[0].vector_score) {
    const queryTerms = new Set(tokenize(query));
    scored = candidates.map(candidate => {
      const terms = new Set(tokenize(candidate.text));
      const overlap = [...queryTerms].filter(term => terms.has(term)).length;
      return { ...candidate, relevanceScore: queryTerms.size ? overlap / queryTerms.size : 0 };
    }).sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    const namedPrefLexical = preferNamedDocuments(scored, query);
    const bestLexical = namedPrefLexical.length > 0 ? namedPrefLexical[0].relevanceScore : 0;
    // A dynamic floor based on the best match helps drop irrelevant trailing chunks.
    // Use the MIN_RELEVANCE_SCORE environment variable (default 0.70) as the hard floor for global queries
    // to prevent cross-document contamination. For scoped queries, use a lower floor since the scope is known.
    const dynamicFloor = isDocumentScoped 
      ? Math.max(0.12, bestLexical - 0.15)
      : Math.max(MIN_RELEVANCE_SCORE, bestLexical - 0.15);
    
    // Fallback cutoff point
    const fallbackThreshold = isDocumentScoped ? 0.05 : MIN_RELEVANCE_SCORE;
    
    for (const c of namedPrefLexical) {
      if (c.relevanceScore >= dynamicFloor && c.relevanceScore >= fallbackThreshold) eligible.push(c);
      else { c.rejectReason = `Low lexical overlap (${c.relevanceScore.toFixed(3)} < ${dynamicFloor.toFixed(3)})`; rejected.push(c); }
    }
  }

  // Final Scope & Topic Validation
  const validated = [];
  for (const chunk of eligible) {
    const valid = validateContextScope([chunk], intentJson, query);
    const semanticScore = Number(chunk.relevanceScore || 0);
    const semanticAligned = semanticScore >= 0.18;
    // Embedding models give unrelated prose a small positive baseline. When
    // there is no lexical anchor, require a distinctly strong semantic match;
    // otherwise an old document can look "relevant" to a wholly new topic.
    const semanticStrong = semanticScore >= 0.35;
    const lexicalAligned = hasQueryAlignment(query, chunk);
    const explicitDocumentScope = Boolean(intentJson && (intentJson.targetDocument || intentJson.activeDocumentId));
    const properTopic = explicitProperTopic(query);
    const namesProperTopic = !properTopic || searchableText(chunk.text).toLowerCase().includes(properTopic);
    // Scoped retrieval is allowed to use a lower semantic score only when the
    // requested document is actually selected. It still needs query overlap.
    const queryAligned = isRequestedParentScope(chunk, intentJson) || semanticStrong || (semanticAligned && lexicalAligned) || (explicitDocumentScope && lexicalAligned);
    if (valid.length > 0 && queryAligned && namesProperTopic) {
      chunk.queryAligned = true;
      validated.push(chunk);
    } else {
      chunk.rejectReason = chunk.rejectReason || (namesProperTopic ? 'Evidence does not align with the current query' : 'Named topic is absent from the evidence');
      rejected.push(chunk);
    }
  }

  return { top: orderChunksForPresentation(validated), rejected };
}

async function validateAnswerGrounding(answer, query, evidence) {
  if (!answer || !evidence || !evidence.length) return false;
  const provider = getEmbeddingProvider();
  try {
    const cleanAnswer = answer
      .replace(/<[^>]+>/g, ' ')
      .replace(/\(\s*source\s*:\s*[^)]+\)/gi, ' ')
      .replace(/\[\s*source\s*:\s*[^\]]+\]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Filter out heading lines, generic intro/outro sentences, and short
    // bullet-point fragments before grounding checks. These structural
    // elements don't carry substantive claims and should not penalize a
    // well-synthesized answer.
    const sentences = cleanAnswer
      .split(/\n+|(?<=[.!?])\s+/)
      .map(s => s.trim().replace(/^#{1,6}\s*/, '').replace(/^[-*•\d+.)]\s*/, '').replace(/\*{1,3}/g, ''))
      .filter(s => {
        if (s.length < 25) return false;
        if (/^(here is|the following|summary of|below is|this document|in summary|based on|according to|the case stud)/i.test(s)) return false;
        // Bullet-style labels like "Document Management – upload and organize..."
        // are synthesis artifacts, not hallucinations.
        if (/^[A-Z][a-z]+\s+(Management|Access|Search|Security|Control)\b/.test(s) && s.length < 80) return false;
        return true;
      });

    if (!sentences.length) return true; // If only structural headings, allow presentation

    const vectors = await provider.generateEmbeddings([query, ...evidence.map(c => c.text || ''), ...sentences]);
    const evidenceVectors = vectors.slice(1, evidence.length + 1);
    const answerVectors = vectors.slice(evidence.length + 1);

    const scores = answerVectors.map(sentenceVector => 
      Math.max(...evidenceVectors.map(evidenceVector => cosineSimilarity(sentenceVector, evidenceVector)))
    );

    // MiniLM embeddings produce lower cosine similarity for paraphrased text
    // than for verbatim matches. A threshold of 0.12 catches genuine
    // hallucinations while allowing well-synthesized answers to pass.
    const GROUNDING_THRESHOLD = parseFloat(process.env.GROUNDING_THRESHOLD || '0.12');
    const GROUNDING_PASS_RATIO = parseFloat(process.env.GROUNDING_PASS_RATIO || '0.50');

    const passingCount = scores.filter(score => score >= GROUNDING_THRESHOLD).length;
    const passRatio = passingCount / scores.length;

    console.log(`[GROUNDING] sentences=${sentences.length} passing=${passingCount} passRatio=${passRatio.toFixed(2)} threshold=${GROUNDING_THRESHOLD} requiredRatio=${GROUNDING_PASS_RATIO} scores=[${scores.map(s => s.toFixed(3)).join(',')}]`);

    // Grounded if at least 50% of substantive sentences match evidence
    return passRatio >= GROUNDING_PASS_RATIO;
  } catch (error) {
    console.warn('[Retrieval] Answer grounding validation unavailable:', error.message);
    return true;
  }
}

// Simple, dependency-free lexical retrieval (term-frequency scoring & FTS).
async function retrieveTopChunksLexical(query, k = 5, organizationId = 'org_default', intentJson = null) {
  const qTerms = tokenize(query).filter(t => !STOPWORDS.has(t));
  if (!qTerms.length) return [];
  const pool = getPool();
  if (!pool) return [];
  
  // Clean query text: remove target document name from query text if document is scoped, so FTS doesn't demand title words in chunk text
  let searchTerms = query.trim();
  if (intentJson && intentJson.targetDocument && intentJson.targetDocument !== 'null') {
    const docNameRegex = new RegExp(`\\b${intentJson.targetDocument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    searchTerms = searchTerms.replace(docNameRegex, ' ').replace(/\s+/g, ' ').trim();
  }

  const limit = Math.max(k * 2, 50);
  let rows = [];

  if (intentJson && intentJson.activeDocumentId) {
    // 1. Try websearch_to_tsquery FTS on active document
    const ftsRes = await pool.query(`
      SELECT c.id, c.content as text, c.chunk_index AS "chunkIndex", c.metadata,
             d.id as "docId", d.original_filename as "docName",
             ts_rank_cd(to_tsvector('english', c.content), websearch_to_tsquery('english', $1)) as lexical_score
      FROM chunks c
      JOIN document_versions dv ON c.document_version_id = dv.id
      JOIN documents d ON dv.document_id = d.id
      WHERE d.organization_id = $2 AND dv.status = 'READY'
        AND d.id = $3
        AND to_tsvector('english', c.content) @@ websearch_to_tsquery('english', $1)
      ORDER BY lexical_score DESC
      LIMIT $4
    `, [searchTerms || query, organizationId, intentJson.activeDocumentId, limit]);
    
    rows = ftsRes.rows;
    // Fallback: if FTS matches 0 rows in the active document, load chunks of active document
    if (rows.length === 0) {
      const docRes = await pool.query(`
        SELECT c.id, c.content as text, c.chunk_index AS "chunkIndex", c.metadata,
               d.id as "docId", d.original_filename as "docName",
               1.0 as lexical_score
        FROM chunks c
        JOIN document_versions dv ON c.document_version_id = dv.id
        JOIN documents d ON dv.document_id = d.id
        WHERE d.organization_id = $1 AND dv.status = 'READY' AND d.id = $2
        ORDER BY c.chunk_index ASC
        LIMIT $3
      `, [organizationId, intentJson.activeDocumentId, limit]);
      rows = docRes.rows;
    }
  } else if (intentJson && intentJson.targetDocument && intentJson.targetDocument !== 'null') {
    const allowCrossDocument = /\b(across|all|compare)\b/i.test(query);
    if (!allowCrossDocument) {
      const docPattern = `%${intentJson.targetDocument.trim()}%`;
      const ftsRes = await pool.query(`
        SELECT c.id, c.content as text, c.chunk_index AS "chunkIndex", c.metadata,
               d.id as "docId", d.original_filename as "docName",
               ts_rank_cd(to_tsvector('english', c.content), websearch_to_tsquery('english', $1)) as lexical_score
        FROM chunks c
        JOIN document_versions dv ON c.document_version_id = dv.id
        JOIN documents d ON dv.document_id = d.id
        WHERE d.organization_id = $2 AND dv.status = 'READY'
          AND d.original_filename ILIKE $3
          AND to_tsvector('english', c.content) @@ websearch_to_tsquery('english', $1)
        ORDER BY lexical_score DESC
        LIMIT $4
      `, [searchTerms || query, organizationId, docPattern, limit]);

      rows = ftsRes.rows;
      // Fallback: if FTS matches 0 rows in target document, load chunks of target document
      if (rows.length === 0) {
        const docRes = await pool.query(`
          SELECT c.id, c.content as text, c.chunk_index AS "chunkIndex", c.metadata,
                 d.id as "docId", d.original_filename as "docName",
                 1.0 as lexical_score
          FROM chunks c
          JOIN document_versions dv ON c.document_version_id = dv.id
          JOIN documents d ON dv.document_id = d.id
          WHERE d.organization_id = $1 AND dv.status = 'READY'
            AND d.original_filename ILIKE $2
          ORDER BY c.chunk_index ASC
          LIMIT $3
        `, [organizationId, docPattern, limit]);
        rows = docRes.rows;
      }
    }
  }

  if (rows.length === 0) {
    const res = await pool.query(`
      SELECT c.id, c.content as text, c.chunk_index AS "chunkIndex", c.metadata,
             d.id as "docId", d.original_filename as "docName",
             ts_rank_cd(to_tsvector('english', c.content), websearch_to_tsquery('english', $1)) as lexical_score
      FROM chunks c
      JOIN document_versions dv ON c.document_version_id = dv.id
      JOIN documents d ON dv.document_id = d.id
      WHERE d.organization_id = $2 AND dv.status = 'READY'
        AND to_tsvector('english', c.content) @@ websearch_to_tsquery('english', $1)
      ORDER BY lexical_score DESC
      LIMIT $3
    `, [query.trim(), organizationId, limit]);
    rows = res.rows;

    if (rows.length === 0 && qTerms.length > 0) {
      const orQueryStr = qTerms.slice(0, 8).join(' | ');
      try {
        const orRes = await pool.query(`
          SELECT c.id, c.content as text, c.chunk_index AS "chunkIndex", c.metadata,
                 d.id as "docId", d.original_filename as "docName",
                 ts_rank_cd(to_tsvector('english', c.content), to_tsquery('english', $1)) as lexical_score
          FROM chunks c
          JOIN document_versions dv ON c.document_version_id = dv.id
          JOIN documents d ON dv.document_id = d.id
          WHERE d.organization_id = $2 AND dv.status = 'READY'
            AND to_tsvector('english', c.content) @@ to_tsquery('english', $1)
          ORDER BY lexical_score DESC
          LIMIT $3
        `, [orQueryStr, organizationId, limit]);
        rows = orRes.rows;
      } catch (e) {
        /* ignore invalid tsquery parse errors */
      }
    }
  }

  const scored = rows.map(c => ({ ...c, score: c.lexical_score }));
  scored.sort((a, b) => b.score - a.score);
  return includeNamedDocumentCandidates(scored.slice(0, k), scored, query);
}

// New Hybrid Retrieval
async function retrieveTopChunks(kb, query, k = 5, organizationId = 'org_default', intentJson = null) {
  const pool = getPool();
  const provider = getEmbeddingProvider();
  
  // If no DB pool or embedding provider is not configured, fallback to purely lexical
  if (!pool || !provider.isConfigured()) {
    return await expandParentSectionCandidates(await retrieveTopChunksLexical(query, k, organizationId, intentJson), organizationId, intentJson);
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
    return await expandParentSectionCandidates(await retrieveTopChunksLexical(query, k, organizationId, intentJson), organizationId, intentJson);
  }

  try {
    // 1. Vector Search
    const qEmbed = await provider.generateEmbedding(query);
    let docFilter = '';
    const params = [`[${qEmbed.join(',')}]`, k * 2, organizationId];
    
    if (intentJson) {
      const allowCrossDocument = /\b(across|all|compare)\b/i.test(query);
      if (!allowCrossDocument) {
        if (intentJson.activeDocumentId) {
          docFilter = ` AND d.id = $4`;
          params.push(intentJson.activeDocumentId);
        } else if (intentJson.targetDocument && intentJson.targetDocument !== 'null') {
          docFilter = ` AND d.original_filename ILIKE $4`;
          params.push(`%${intentJson.targetDocument.trim()}%`);
        }
      }
    }

    const vectorRes = await pool.query(`
      SELECT 
        c.id, 
        c.chunk_index AS "chunkIndex",
        c.metadata,
        c.content as text, 
        d.id as "docId",
        d.original_filename as docName,
        1 - (e.embedding <=> $1::vector) as vector_score
      FROM chunks c
      JOIN embeddings e ON e.chunk_id = c.id
      JOIN document_versions dv ON c.document_version_id = dv.id
      JOIN documents d ON dv.document_id = d.id
      WHERE dv.status = 'READY' AND d.organization_id = $3${docFilter}
      ORDER BY e.embedding <=> $1::vector ASC
      LIMIT $2
    `, params);
    
    const vectorCandidates = vectorRes.rows;

    // 2. Lexical Search on DB results or existing KB chunks
    const lexicalCandidates = await retrieveTopChunksLexical(query, Math.max(k * 2, 50), organizationId, intentJson);

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
          chunkIndex: chunk.chunkIndex,
          metadata: chunk.metadata,
          rrf_score: 0,
          final_score: 0,
          score: 0,
          // Preserve vector_score (cosine similarity) from the vector search
          // leg so that selectRelevantChunks can use it directly without
          // expensive re-embedding. Only vector candidates have this field.
          vector_score: chunk.vector_score
        });
      } else if (isVector && chunk.vector_score !== undefined) {
        // If the chunk was already added by lexical search, attach the
        // vector_score from the vector search leg.
        chunksDict.get(id).vector_score = chunk.vector_score;
      }
    };

    vectorCandidates.forEach((c, idx) => addScore(c, idx + 1, true));
    lexicalCandidates.forEach((c, idx) => addScore(c, idx + 1, false));

    const final = Array.from(chunksDict.values()).map(c => {
      c.rrf_score = scores.get(c.id);
      c.final_score = c.rrf_score;
      c.score = c.final_score;
      return c;
    });

    final.sort((a, b) => b.score - a.score);
    // Include only documents that the query explicitly names; do not append a
    // representative from every document in the organization.
    return await expandParentSectionCandidates(includeNamedDocumentCandidates(final.slice(0, Math.max(k, 25)), kb.chunks, query), organizationId, intentJson);

  } catch (err) {
    console.error('[Retrieval] Vector search failed, falling back to keyword search.', err.message);
    return expandParentSectionCandidates(await retrieveTopChunksLexical(query, k, organizationId, intentJson), organizationId, intentJson);
  }
}

module.exports = { retrieveTopChunks, retrieveTopChunksLexical, selectRelevantChunks, validateAnswerGrounding, tokenize, documentTitleMatchesQuery, hasQueryAlignment, orderChunksForPresentation, requestedParentHeading };
