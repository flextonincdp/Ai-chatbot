require('dotenv').config();
const { initPool, query, closePool } = require('../lib/db');

async function migrateMemory() {
  await initPool();

  console.log('[Migrate] Creating memory tables...');

  // Conversations
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

  // Messages
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

  // Artifacts
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

  // Summaries
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

  // Charts
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

  // Context Snapshots
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

  await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS organization_id VARCHAR(255);`);
  await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_id VARCHAR(255);`);
  await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_chart_id VARCHAR(255);`);
  await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title TEXT;`);
  await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_document_ids JSONB;`);
  await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS answer_id VARCHAR(255);`);
  await query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS organization_id VARCHAR(255);`);
  await query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source_chunk_ids JSONB;`);
  await query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source_message_id VARCHAR(255);`);
  await query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_key TEXT;`);
  await query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS filename TEXT;`);
  await query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS mime_type VARCHAR(255);`);
  await query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS size_bytes BIGINT;`);
  await query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(50);`);
  await query(`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_bucket TEXT;`);

  // Indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_answers_conv ON answers(conversation_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_artifacts_source_message ON artifacts(source_message_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_session_summaries_conv ON session_summaries(conversation_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_charts_conv ON charts(conversation_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_context_snapshots_msg ON context_snapshots(message_id);`);

  console.log('[Migrate] Memory tables created successfully.');
  await closePool();
}

migrateMemory().catch(err => {
  console.error('[Migrate] Fatal error:', err);
  process.exit(1);
});
