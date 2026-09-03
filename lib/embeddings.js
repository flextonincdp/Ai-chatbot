/**
 * Local Embedding Provider using Transformers.js (@xenova/transformers)
 * Model: Xenova/all-MiniLM-L6-v2
 * 
 * Runs entirely locally inside Node.js — no external API key required.
 * The model is lazily loaded on first use and cached for subsequent requests.
 */

let pipeline = null;  // Cached reference to the dynamic import
let embedPipeline = null;  // Cached model pipeline instance
let modelReady = false;
let modelError = null;
let modelDimensions = null;

const MODEL_NAME = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const MODEL_VERSION = '1';

/**
 * Lazily initialize the embedding pipeline.
 * Loads the model on first call, then caches it.
 */
async function initPipeline() {
  if (embedPipeline) return embedPipeline;
  if (modelError) throw modelError;

  try {
    console.log(`[Embeddings] Loading local model: ${MODEL_NAME} ...`);
    const startTime = Date.now();

    // @xenova/transformers is ESM, so we use dynamic import
    const { pipeline: pipelineFn } = await import('@xenova/transformers');
    pipeline = pipelineFn;

    embedPipeline = await pipeline('feature-extraction', MODEL_NAME, {
      quantized: true  // Use quantized model for faster loading & lower memory
    });

    // Determine actual dimensions by running a test embedding
    const testOutput = await embedPipeline('test', { pooling: 'mean', normalize: true });
    modelDimensions = testOutput.data.length;
    modelReady = true;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Embeddings] Model loaded in ${elapsed}s. Dimensions: ${modelDimensions}`);

    return embedPipeline;
  } catch (err) {
    modelError = new Error(`[Embeddings] Failed to load model: ${err.message}`);
    console.error(modelError.message);
    throw modelError;
  }
}

class LocalEmbeddingProvider {
  constructor() {
    this.model = MODEL_NAME;
    this.version = MODEL_VERSION;
  }

  /**
   * Local embeddings are always "configured" — no API key needed.
   * Returns false only if the provider env var is explicitly set to something else.
   */
  isConfigured() {
    const provider = process.env.EMBEDDING_PROVIDER || 'local';
    return provider === 'local';
  }

  getEmbeddingInfo() {
    return {
      provider: 'local',
      model: this.model,
      dimensions: modelDimensions,
      version: this.version,
      distanceMetric: 'cosine',
      library: '@xenova/transformers'
    };
  }

  /**
   * Returns true if the model has been loaded and is ready.
   */
  isReady() {
    return modelReady;
  }

  /**
   * Generate a single embedding vector for the given text.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async generateEmbedding(text) {
    const pipe = await initPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  /**
   * Generate embeddings for an array of texts.
   * Processes them one at a time to avoid memory issues with large batches.
   * @param {string[]} texts 
   * @returns {Promise<number[][]>}
   */
  async generateEmbeddings(texts) {
    const pipe = await initPipeline();
    const results = [];
    for (const text of texts) {
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      results.push(Array.from(output.data));
    }
    return results;
  }

  /**
   * Get the verified dimension count (only available after first embedding).
   */
  getDimensions() {
    return modelDimensions;
  }
}

// Singleton instance
let providerInstance = null;

function getEmbeddingProvider() {
  if (!providerInstance) {
    providerInstance = new LocalEmbeddingProvider();
  }
  return providerInstance;
}

module.exports = {
  getEmbeddingProvider,
  LocalEmbeddingProvider,
  initPipeline  // Exported for scripts that need to pre-warm the model
};
