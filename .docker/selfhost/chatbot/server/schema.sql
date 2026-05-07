-- =============================================
-- AFFiNE Chatbot RAG — Database Schema
-- Shared PostgreSQL instance (AFFiNE + pgvector)
-- Run via: psql $DATABASE_URL -f schema.sql
-- Or auto-initialized by server/db.js on startup
-- =============================================

-- 1. Enable vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Knowledge base chunks (multi-tenant)
CREATE TABLE IF NOT EXISTS chatbot_documents (
    id BIGSERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    embedding VECTOR(1024),                   -- NIM embedding: 1024 dims
    source VARCHAR(255),                       -- Source markdown filename
    chunk_index INTEGER,                       -- Position within source file
    team_id VARCHAR(100) DEFAULT NULL,        -- NULL = global, else team-specific
    metadata JSONB DEFAULT '{}',              -- extra context (heading, etc.)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for fast cosine similarity search
-- Note: Requires pgvector >= 0.5 with HNSW support
CREATE INDEX IF NOT EXISTS idx_chatbot_doc_embedding
    ON chatbot_documents
    USING HNSW (embedding vector_cosine_ops);

-- Index for team filtering
CREATE INDEX IF NOT EXISTS idx_chatbot_doc_team
    ON chatbot_documents (team_id);

-- 3. Chat conversations (session persistence)
CREATE TABLE IF NOT EXISTS chatbot_conversations (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(100) NOT NULL,
    user_id VARCHAR(100) DEFAULT NULL,
    team_id VARCHAR(100) DEFAULT NULL,
    summary TEXT DEFAULT '',                  -- LLM-compressed conversation summary
    message_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for session lookup
CREATE INDEX IF NOT EXISTS idx_chatbot_conv_session
    ON chatbot_conversations (session_id, updated_at DESC);

-- 4. Chat messages
CREATE TABLE IF NOT EXISTS chatbot_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT REFERENCES chatbot_conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,                -- 'user' | 'assistant'
    content TEXT NOT NULL,
    is_compressed BOOLEAN DEFAULT FALSE,       -- TRUE once summarized into conversation.summary
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for message retrieval
CREATE INDEX IF NOT EXISTS idx_chatbot_msg_conv
    ON chatbot_messages (conversation_id, created_at ASC);