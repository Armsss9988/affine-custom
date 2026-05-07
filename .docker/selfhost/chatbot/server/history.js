const { pool } = require('./db');
const { chatComplete } = require('./nim');

const RECENT_MESSAGES_FULL = 6;      // Keep last 6 messages uncompressed
const COMPRESS_THRESHOLD = 10;       // Compress when total > 10 messages
const SUMMARY_MAX_LENGTH = 500;      // Max chars for compressed summary

/**
 * Get or create a conversation
 */
async function getOrCreateConversation(sessionId, userId = null, teamId = null) {
  // Try to find existing conversation
  const existing = await pool.query(
    'SELECT * FROM chatbot_conversations WHERE session_id = $1 ORDER BY updated_at DESC LIMIT 1',
    [sessionId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // Create new conversation
  const result = await pool.query(
    `INSERT INTO chatbot_conversations (session_id, user_id, team_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [sessionId, userId, teamId]
  );

  return result.rows[0];
}

/**
 * Save a message to conversation
 */
async function saveMessage(conversationId, role, content) {
  await pool.query(
    `INSERT INTO chatbot_messages (conversation_id, role, content)
     VALUES ($1, $2, $3)`,
    [conversationId, role, content]
  );

  await pool.query(
    `UPDATE chatbot_conversations
     SET message_count = message_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [conversationId]
  );
}

/**
 * Get conversation history with compression
 * Returns: { summary, recentMessages }
 *
 * Strategy:
 * - If total messages <= RECENT_MESSAGES_FULL: return all as recent
 * - If total messages > COMPRESS_THRESHOLD: compress old messages into summary
 * - Always return last RECENT_MESSAGES_FULL messages in full
 */
async function getHistory(conversationId) {
  // Get conversation
  const conv = await pool.query(
    'SELECT * FROM chatbot_conversations WHERE id = $1',
    [conversationId]
  );

  if (conv.rows.length === 0) {
    return { summary: '', recentMessages: [] };
  }

  const conversation = conv.rows[0];

  // Get all messages
  const allMessages = await pool.query(
    `SELECT role, content, created_at FROM chatbot_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId]
  );

  const messages = allMessages.rows;

  if (messages.length <= RECENT_MESSAGES_FULL) {
    return { summary: conversation.summary || '', recentMessages: messages };
  }

  // Split into old (to compress) and recent (keep full)
  const oldMessages = messages.slice(0, -RECENT_MESSAGES_FULL);
  const recentMessages = messages.slice(-RECENT_MESSAGES_FULL);

  // Check if we need to compress
  if (messages.length > COMPRESS_THRESHOLD && oldMessages.length > 0) {
    const newSummary = await compressMessages(conversation.summary, oldMessages);

    // Save compressed summary
    await pool.query(
      'UPDATE chatbot_conversations SET summary = $1 WHERE id = $2',
      [newSummary, conversationId]
    );

    // Mark old messages as compressed (optional: could delete them)
    const oldIds = oldMessages.map((_, i) => i);
    await pool.query(
      `UPDATE chatbot_messages SET is_compressed = TRUE
       WHERE conversation_id = $1
       AND id IN (
         SELECT id FROM chatbot_messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC
         LIMIT $2
       )`,
      [conversationId, oldMessages.length]
    );

    return { summary: newSummary, recentMessages };
  }

  return { summary: conversation.summary || '', recentMessages };
}

/**
 * Compress old messages into a concise summary using LLM
 */
async function compressMessages(existingSummary, messages) {
  const messageText = messages
    .map(m => `${m.role === 'user' ? 'Người dùng' : 'Bot'}: ${m.content}`)
    .join('\n');

  const prompt = [
    {
      role: 'system',
      content: `Tóm tắt cuộc hội thoại sau thành 2-3 câu ngắn gọn bằng tiếng Việt.
Giữ lại các thông tin quan trọng: câu hỏi chính, vấn đề đã giải quyết, bối cảnh.
Tối đa ${SUMMARY_MAX_LENGTH} ký tự.`,
    },
    {
      role: 'user',
      content: existingSummary
        ? `Tóm tắt trước đó: ${existingSummary}\n\nTin nhắn mới cần nén:\n${messageText}`
        : `Tóm tắt cuộc hội thoại:\n${messageText}`,
    },
  ];

  try {
    const summary = await chatComplete(prompt);
    return summary.slice(0, SUMMARY_MAX_LENGTH);
  } catch (err) {
    console.error('[History] Compression failed:', err.message);
    // Fallback: simple truncation
    return messages
      .slice(-3)
      .map(m => `${m.role}: ${m.content.slice(0, 50)}...`)
      .join(' | ');
  }
}

module.exports = { getOrCreateConversation, saveMessage, getHistory };
