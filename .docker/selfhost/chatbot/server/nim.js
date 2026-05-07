const BASE_URL = process.env.NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const API_KEY = process.env.NIM_API_KEY || '';
const LLM_MODEL = process.env.NIM_LLM_MODEL || 'meta/llama-3.1-70b-instruct';
const EMBEDDING_MODEL = process.env.NIM_EMBEDDING_MODEL || 'nvidia/nv-embedqa-e5-v5';

/**
 * Generate text embedding using NIM API
 * @param {string} text
 * @returns {Promise<number[]>} embedding vector (1024 dims)
 */
async function embedText(text) {
  const resp = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      input_type: 'query',
      encoding_format: 'float',
      truncate: 'END',
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`NIM Embedding error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.data[0].embedding;
}

/**
 * Chat completion using NIM LLM (streaming)
 * @param {Array<{role: string, content: string}>} messages
 * @returns {ReadableStream} SSE stream
 */
async function chatStream(messages) {
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      stream: true,
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`NIM LLM error ${resp.status}: ${err}`);
  }

  return resp.body;
}

/**
 * Chat completion (non-streaming, for summarization)
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>}
 */
async function chatComplete(messages) {
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      stream: false,
      temperature: 0.2,
      max_tokens: 512,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`NIM LLM error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.choices[0].message.content;
}

module.exports = { embedText, chatStream, chatComplete };
