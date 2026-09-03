/**
 * Concurrency Control and Limiters
 * 
 * Provides async semaphores to prevent memory exhaustion or external rate-limiting
 * from overloading the server.
 */

class AsyncSemaphore {
  constructor(maxConcurrency) {
    this.max = maxConcurrency;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next(); // Give the token to the next waiting promise
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  // Execute a function with concurrency control
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// Read limits from env, or fall back to conservative defaults
const chatLimit = parseInt(process.env.MAX_CONCURRENT_CHAT_REQUESTS || '10', 10);
const llmLimit = parseInt(process.env.MAX_CONCURRENT_LLM_REQUESTS || process.env.GROQ_MAX_CONCURRENT_REQUESTS || '1', 10);
const embedLimit = parseInt(process.env.MAX_CONCURRENT_EMBEDDINGS || '2', 10);

const chatLimiter = new AsyncSemaphore(chatLimit);
const llmLimiter = new AsyncSemaphore(llmLimit);
const embedLimiter = new AsyncSemaphore(embedLimit);

module.exports = {
  chatLimiter,
  llmLimiter,
  embedLimiter,
  AsyncSemaphore
};
