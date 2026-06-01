const express = require('express');
const cors = require('cors');
const path = require('path');
const { pool, initSchema } = require('./db');
const { embedText, chatStream } = require('./nim');
const { searchSimilar, buildPrompt } = require('./rag');
const { getOrCreateConversation, saveMessage, getHistory } = require('./history');
const { ingestAll, ingestFile } = require('./ingest');

const app = express();
const PORT = process.env.CHATBOT_PORT || 3099;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve widget static files
app.use('/widget', express.static(path.join(__dirname, '..', 'widget')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'affine-chatbot', timestamp: new Date().toISOString() });
});

// OpenAI Compatible Endpoints (for AFFiNE Copilot via OpenAI provider)
const copilotRouter = require('./copilot');
app.use('/v1', copilotRouter);

// Gemini-path Endpoints (for AFFiNE Copilot via Gemini provider)
// AFFiNE's @ai-sdk/google uses /v1beta as its base URL — we reuse the same
// copilot router since all requests get remapped to NIM anyway.
app.use('/v1beta', copilotRouter);

// REST API endpoints for ChatGPT Integration (Documents, Folders, Collections, etc. under /api)
const docsRouter = require('./docs');
app.use('/api', docsRouter);

// Chat endpoint (streaming via SSE)
app.post('/api/chat', async (req, res) => {
  const { message, sessionId, userId, teamId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  try {
    // 1. Get or create conversation
    const conversation = await getOrCreateConversation(sessionId, userId, teamId);

    // 2. Save user message
    await saveMessage(conversation.id, 'user', message);

    // 3. Get compressed history
    const { summary, recentMessages } = await getHistory(conversation.id);

    // 4. Embed user question
    const queryEmbedding = await embedText(message);

    // 5. RAG: search similar documents
    const context = await searchSimilar(queryEmbedding, teamId, 5);

    // 6. Build augmented prompt
    const promptMessages = buildPrompt(
      message,
      context,
      summary,
      // Exclude the last message (current question) from recent since we add it in buildPrompt
      recentMessages.slice(0, -1)
    );

    // 7. Stream response via SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const stream = await chatStream(promptMessages);
    let fullResponse = '';

    // Process the SSE stream from NIM
    const reader = stream.getReader
      ? stream.getReader()
      : null;

    if (reader) {
      // Node 18+ ReadableStream
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              res.write('data: [DONE]\n\n');
              continue;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                fullResponse += content;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
            } catch (e) {
              // skip malformed JSON
            }
          }
        }
      }
    } else {
      // Fallback: pipe raw stream
      for await (const chunk of stream) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              res.write('data: [DONE]\n\n');
              continue;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                fullResponse += content;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
            } catch (e) {
              // skip
            }
          }
        }
      }
    }

    // 8. Save bot response
    if (fullResponse) {
      await saveMessage(conversation.id, 'assistant', fullResponse);
    }

    res.end();
  } catch (err) {
    console.error('[Chat] Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// Ingest knowledge base
app.post('/api/ingest', async (req, res) => {
  try {
    await ingestAll();
    res.json({ status: 'ok', message: 'Knowledge base ingested successfully' });
  } catch (err) {
    console.error('[Ingest] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Ingest single file (for team-specific docs)
app.post('/api/ingest/file', async (req, res) => {
  const { filePath, teamId } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }
  try {
    const count = await ingestFile(filePath, teamId);
    res.json({ status: 'ok', chunks: count });
  } catch (err) {
    console.error('[Ingest] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Clear conversation history
app.delete('/api/history/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  try {
    const result = await pool.query(
      'DELETE FROM chatbot_conversations WHERE session_id = $1',
      [sessionId]
    );
    const deleted = result.rowCount > 0;
    res.json({ status: 'ok', deleted });
  } catch (err) {
    console.error('[History] Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
async function start() {
  await initSchema();
  console.log('[DB] Schema ready');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Chatbot] 🤖 Server running on http://0.0.0.0:${PORT}`);
    console.log(`[Chatbot] Widget: http://0.0.0.0:${PORT}/widget/chat-widget.js`);
    console.log(`[Chatbot] Health: http://0.0.0.0:${PORT}/api/health`);
  });
}

start().catch(err => {
  console.error('[Chatbot] Fatal:', err);
  process.exit(1);
});
