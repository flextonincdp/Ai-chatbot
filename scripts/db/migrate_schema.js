require('dotenv').config();
const { initPool, query, closePool } = require('../../lib/db');

async function migrateSchema() {
  await initPool();
  console.log('[Schema Migrate] Creating and updating all PostgreSQL tables...');

  // 1. Enable pgvector when it is installed. The application can still run
  // with keyword retrieval on a standard local PostgreSQL installation.
  let vectorEnabled = false;
  const vectorPackage = await query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
    ) AS available
  `);
  if (vectorPackage.rows[0].available) {
    await query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    vectorEnabled = true;
    console.log('[Schema Migrate] pgvector enabled.');
  } else {
    console.warn('[Schema Migrate] pgvector is not installed; using keyword retrieval until it is available.');
  }

  // 2. Organizations & Users
  await query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(255) PRIMARY KEY,
      organization_id VARCHAR(255) REFERENCES organizations(id),
      username VARCHAR(255) UNIQUE NOT NULL,
      role VARCHAR(50) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 3. Documents & Chunks
  await query(`
    CREATE TABLE IF NOT EXISTS documents (
      id VARCHAR(255) PRIMARY KEY,
      organization_id VARCHAR(255) NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type VARCHAR(255),
      extension VARCHAR(50),
      size_bytes BIGINT,
      sha256 VARCHAR(64),
      storage_key TEXT,
      status VARCHAR(50) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS document_versions (
      id VARCHAR(255) PRIMARY KEY,
      document_id VARCHAR(255) REFERENCES documents(id) ON DELETE CASCADE,
      version_number INT NOT NULL,
      page_count INT,
      slide_count INT,
      storage_key TEXT,
      sha256 VARCHAR(64),
      status VARCHAR(50) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id VARCHAR(255) PRIMARY KEY,
      document_version_id VARCHAR(255) REFERENCES document_versions(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      content TEXT NOT NULL,
      page_number INT,
      section TEXT,
      token_count INT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      content_hash VARCHAR(64) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await query(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;`);

  await query(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id VARCHAR(255) PRIMARY KEY,
      chunk_id VARCHAR(255) REFERENCES chunks(id) ON DELETE CASCADE,
      model VARCHAR(255) NOT NULL,
      dimensions INT NOT NULL,
      version VARCHAR(50),
      embedding ${vectorEnabled ? 'vector' : 'TEXT'},
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 4. Job Queue
  await query(`
    CREATE TABLE IF NOT EXISTS document_jobs (
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

  // 5. Conversations & Messages (Memory)
  await query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id VARCHAR(255) PRIMARY KEY,
      user_identifier VARCHAR(255),
      organization_id VARCHAR(255),
      last_message_id VARCHAR(255),
      last_chart_id VARCHAR(255),
      title TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Keep sidebar controls persistent across browser refreshes and devices.
  // IF NOT EXISTS makes this safe for established local databases.
  await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;`);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(255) PRIMARY KEY,
      conversation_id VARCHAR(255) REFERENCES conversations(id) ON DELETE CASCADE,
      role VARCHAR(50) NOT NULL,
      answer_id VARCHAR(255),
      content TEXT,
      source_ids JSONB,
      source_document_ids JSONB,
      artifact_ids JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS answers (
      id VARCHAR(255) PRIMARY KEY,
      conversation_id VARCHAR(255) REFERENCES conversations(id) ON DELETE CASCADE,
      organization_id VARCHAR(255) NOT NULL,
      user_message_id VARCHAR(255),
      answer_text TEXT NOT NULL,
      source_document_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      topic TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id VARCHAR(255) PRIMARY KEY,
      conversation_id VARCHAR(255) REFERENCES conversations(id) ON DELETE CASCADE,
      organization_id VARCHAR(255),
      source_answer_id VARCHAR(255),
      source_message_id VARCHAR(255),
      source_document_ids JSONB,
      source_chunk_ids JSONB,
      format VARCHAR(50),
      generation_plan JSONB,
      validated_data JSONB,
      storage_key TEXT,
      filename TEXT,
      mime_type VARCHAR(255),
      size_bytes BIGINT,
      storage_provider VARCHAR(50),
      storage_bucket TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id VARCHAR(255) PRIMARY KEY,
      conversation_id VARCHAR(255) REFERENCES conversations(id) ON DELETE CASCADE,
      summary_text TEXT,
      version INT DEFAULT 1,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS charts (
      id VARCHAR(255) PRIMARY KEY,
      conversation_id VARCHAR(255) REFERENCES conversations(id) ON DELETE CASCADE,
      source_message_id VARCHAR(255),
      title TEXT,
      chart_type VARCHAR(50),
      config JSONB,
      data JSONB,
      version INT DEFAULT 1,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS context_snapshots (
      id VARCHAR(255) PRIMARY KEY,
      message_id VARCHAR(255) REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id VARCHAR(255) REFERENCES conversations(id) ON DELETE CASCADE,
      previous_message_ids JSONB,
      summary_version INT,
      document_ids JSONB,
      rag_chunk_ids JSONB,
      chart_ids JSONB,
      artifact_ids JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 6. Indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_documents_org ON documents(organization_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_doc_version ON chunks(document_version_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_embeddings_chunk ON embeddings(chunk_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_document_jobs_status ON document_jobs(status);`);
  
  await query(`CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_answers_conv ON answers(conversation_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_artifacts_source_message ON artifacts(source_message_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_session_summaries_conv ON session_summaries(conversation_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_charts_conv ON charts(conversation_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_context_snapshots_msg ON context_snapshots(message_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_conversations_user_pinned_updated ON conversations(user_identifier, organization_id, is_pinned DESC, updated_at DESC);`);

  console.log('[Schema Migrate] All tables and indexes created/verified successfully.');
  await closePool();
}

migrateSchema().catch(err => {
  console.error('[Schema Migrate] Fatal error:', err);
  process.exit(1);
});
