const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initSchema() {
  const client = await pool.connect();
  try {
    // Enable pgvector extension
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Knowledge base chunks (multi-tenant)
    await client.query(`
      CREATE TABLE IF NOT EXISTS chatbot_documents (
        id BIGSERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        embedding VECTOR(1024),
        source VARCHAR(255),
        chunk_index INTEGER,
        team_id VARCHAR(100) DEFAULT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // HNSW index for fast similarity search
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chatbot_doc_embedding
        ON chatbot_documents
        USING hnsw (embedding vector_cosine_ops)
    `);

    // Index for team filtering
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chatbot_doc_team
        ON chatbot_documents (team_id)
    `);

    // Chat conversations
    await client.query(`
      CREATE TABLE IF NOT EXISTS chatbot_conversations (
        id BIGSERIAL PRIMARY KEY,
        session_id VARCHAR(100) NOT NULL,
        user_id VARCHAR(100) DEFAULT NULL,
        team_id VARCHAR(100) DEFAULT NULL,
        summary TEXT DEFAULT '',
        message_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Chat messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS chatbot_messages (
        id BIGSERIAL PRIMARY KEY,
        conversation_id BIGINT REFERENCES chatbot_conversations(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        is_compressed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chatbot_msg_conv
        ON chatbot_messages (conversation_id, created_at)
    `);

    console.log('[DB] Schema initialized successfully');
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema };
