/**
 * Document Processing Job Queue (PostgreSQL Backed)
 * 
 * Provides a reliable queue for async document processing.
 * Designed so it can be swapped for Redis/BullMQ in the future.
 */
const { getPool, query } = require('../db');

class JobQueue {
  constructor() {
    this.tableName = 'document_jobs';
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    const pool = getPool();
    if (!pool) return; // DB not configured

    // Ensure job table exists
    await query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id VARCHAR(50) PRIMARY KEY,
        document_id VARCHAR(50) NOT NULL,
        organization_id VARCHAR(50) NOT NULL,
        status VARCHAR(30) DEFAULT 'QUEUED',
        attempts INT DEFAULT 0,
        max_attempts INT DEFAULT 3,
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        locked_at TIMESTAMP WITH TIME ZONE,
        locked_by VARCHAR(100)
      );
    `);
    
    // Create an index to quickly find QUEUED/PROCESSING jobs
    await query(`
      CREATE INDEX IF NOT EXISTS idx_document_jobs_status 
      ON ${this.tableName}(status);
    `);

    this.initialized = true;
    console.log('[JobQueue] Initialized PostgreSQL queue table.');
  }

  /**
   * Enqueue a new document processing job
   */
  async enqueue(jobId, documentId, organizationId) {
    if (!this.initialized) await this.init();
    
    await query(`
      INSERT INTO ${this.tableName} (id, document_id, organization_id, status)
      VALUES ($1, $2, $3, 'QUEUED')
      ON CONFLICT (id) DO NOTHING
    `, [jobId, documentId, organizationId]);
    
    console.log(`[JobQueue] Enqueued job ${jobId} for document ${documentId}`);
    return jobId;
  }

  /**
   * Dequeue a job for processing (atomic lock)
   */
  async dequeue(workerId = 'worker-1') {
    if (!this.initialized) await this.init();

    // Find the oldest QUEUED job, or a PROCESSING job that has been locked for too long (stalled)
    // and attempt to lock it. This query is atomic.
    const res = await query(`
      UPDATE ${this.tableName}
      SET 
        status = 'PROCESSING',
        locked_at = CURRENT_TIMESTAMP,
        locked_by = $1,
        attempts = attempts + 1
      WHERE id = (
        SELECT id FROM ${this.tableName}
        WHERE status = 'QUEUED'
           OR (status = 'PROCESSING' AND locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes')
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *;
    `, [workerId]);

    if (res.rowCount > 0) {
      return res.rows[0];
    }
    return null;
  }

  /**
   * Update job status
   */
  async updateStatus(jobId, status, errorMsg = null) {
    if (!this.initialized) await this.init();

    await query(`
      UPDATE ${this.tableName}
      SET 
        status = $2,
        error_message = $3,
        updated_at = CURRENT_TIMESTAMP,
        locked_at = CASE WHEN $4::text IN ('READY', 'FAILED') THEN NULL ELSE locked_at END
      WHERE id = $1
    `, [jobId, status, errorMsg, status]);
  }

  /**
   * Mark a job as completely failed
   */
  async markFailed(jobId, errorMsg) {
    await this.updateStatus(jobId, 'FAILED', errorMsg);
    console.error(`[JobQueue] Job ${jobId} FAILED: ${errorMsg}`);
  }

  /**
   * Check if a job should be retried based on max attempts
   */
  async canRetry(jobId) {
    if (!this.initialized) await this.init();
    
    const res = await query(`SELECT attempts, max_attempts FROM ${this.tableName} WHERE id = $1`, [jobId]);
    if (res.rowCount > 0) {
      return res.rows[0].attempts < res.rows[0].max_attempts;
    }
    return false;
  }

  /**
   * Put a job back in the queue for retry
   */
  async retry(jobId, errorMsg) {
    const retryable = await this.canRetry(jobId);
    if (retryable) {
      await query(`
        UPDATE ${this.tableName}
        SET 
          status = 'QUEUED',
          error_message = $2,
          updated_at = CURRENT_TIMESTAMP,
          locked_at = NULL
        WHERE id = $1
      `, [jobId, `Retry pending after error: ${errorMsg}`]);
      console.log(`[JobQueue] Job ${jobId} re-queued for retry.`);
    } else {
      await this.markFailed(jobId, errorMsg);
    }
  }
}

// Singleton export
const queueInstance = new JobQueue();

module.exports = queueInstance;
