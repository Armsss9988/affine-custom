const { pool } = require('./db');
const { embedText } = require('./nim');

const SYSTEM_PROMPT = `Bạn là trợ lý AI hỗ trợ sử dụng AFFiNE — ứng dụng workspace tích hợp Docs, Whiteboard và Kanban.

Quy tắc:
1. Luôn trả lời bằng tiếng Việt, rõ ràng và thân thiện
2. Trả lời DỰA TRÊN context được cung cấp bên dưới
3. Nếu context không đủ thông tin, nói thẳng "Mình chưa có thông tin chi tiết về vấn đề này, bạn có thể mô tả thêm không?"
4. Hướng dẫn cụ thể, từng bước, dùng bullet points
5. Dùng emoji phù hợp để thân thiện hơn 😊
6. Nếu câu hỏi ngoài phạm vi AFFiNE/workspace, nhẹ nhàng hướng về chủ đề liên quan
7. Trả lời ngắn gọn, tối đa 300 từ trừ khi cần hướng dẫn chi tiết`;

/**
 * Search similar documents from pgvector
 * @param {number[]} embedding - query embedding
 * @param {string|null} teamId - filter by team (null = global only)
 * @param {number} topK - number of results
 * @returns {Promise<Array<{content: string, source: string, similarity: number}>>}
 */
async function searchSimilar(embedding, teamId = null, topK = 5) {
  const vectorStr = `[${embedding.join(',')}]`;

  // Search global docs + team-specific docs
  const query = `
    SELECT content, source, metadata,
           1 - (embedding <=> $1::vector) AS similarity
    FROM chatbot_documents
    WHERE team_id IS NULL ${teamId ? 'OR team_id = $3' : ''}
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;

  const params = teamId
    ? [vectorStr, topK, teamId]
    : [vectorStr, topK];

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Build augmented prompt with RAG context + compressed history
 * @param {string} question - user's question
 * @param {Array} context - retrieved documents
 * @param {string} historySummary - compressed history summary
 * @param {Array} recentMessages - last N messages (full)
 * @returns {Array<{role: string, content: string}>}
 */
function buildPrompt(question, context, historySummary = '', recentMessages = []) {
  const contextText = context
    .map((doc, i) => `[${i + 1}] ${doc.content}`)
    .join('\n\n');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  // Add compressed history summary if exists
  if (historySummary) {
    messages.push({
      role: 'system',
      content: `Tóm tắt cuộc hội thoại trước đó:\n${historySummary}`,
    });
  }

  // Add recent messages (full, uncompressed)
  for (const msg of recentMessages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Add current question with RAG context
  const userPrompt = contextText
    ? `Context từ knowledge base:\n${contextText}\n\n---\nCâu hỏi: ${question}`
    : `Câu hỏi: ${question}`;

  messages.push({ role: 'user', content: userPrompt });

  return messages;
}

module.exports = { searchSimilar, buildPrompt, SYSTEM_PROMPT };
