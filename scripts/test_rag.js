require('dotenv').config();
const { initPool, closePool } = require('../lib/db');
const { loadKB } = require('../lib/kbStore');
const { retrieveTopChunks } = require('../lib/retrieval');
const { buildGroundedPrompt, callClaude } = require('../lib/claude');
const { getEmbeddingProvider, initPipeline } = require('../lib/embeddings');

async function testRag() {
  console.log('==================================================');
  console.log('RAG PIPELINE TEST (HYBRID RETRIEVAL)');
  console.log('==================================================\n');

  initPool();
  
  // Ensure model is loaded
  const provider = getEmbeddingProvider();
  if (provider.isConfigured()) {
    await initPipeline();
  }

  const kb = loadKB();
  const questions = [
    { type: 'exact keyword', q: 'What is the knowledge base?' },
    { type: 'paraphrased', q: 'Can you explain the main purpose of this application?' },
    { type: 'semantic', q: 'How does it handle document ingestion and searching?' },
    { type: 'multi-document', q: 'What are the rules and the project requirements together?' },
    { type: 'unknown', q: 'What is the recipe for chocolate chip cookies?' }
  ];

  for (const item of questions) {
    console.log(`\n--- Test: ${item.type.toUpperCase()} ---`);
    console.log(`Question: "${item.q}"`);
    
    try {
      console.log('1. Generating query embedding & searching...');
      const top = await retrieveTopChunks(kb, item.q, 5);
      
      console.log(`2. Retrieved ${top.length} chunks.`);
      if (top.length > 0) {
        console.log(`   Top match score: ${top[0].score?.toFixed(4) || 'N/A'}`);
        console.log(`   Top match source: ${top[0].docName}`);
      }

      console.log('3. Building grounded prompt and calling LLM...');
      const prompt = buildGroundedPrompt(item.q, top);
      
      if (process.env.GROQ_API_KEY) {
        const answer = await callClaude(prompt, 300);
        console.log('\nAnswer:');
        console.log(answer);
      } else {
        console.log('\nAnswer: (SKIPPED - GROQ_API_KEY not set)');
      }
      
      const sources = [...new Set(top.map(c => c.docName))];
      console.log('\nSources:', sources.join(', '));
      
      console.log('\nResult: PASS');
    } catch (err) {
      console.error('Error during test:', err);
      console.log('Result: FAIL');
    }
  }

  await closePool();
}

testRag().catch(err => {
  console.error(err);
  process.exit(1);
});
