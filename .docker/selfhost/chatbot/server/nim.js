const LLM_BASE_URL = process.env.NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const LLM_API_KEY = process.env.NIM_API_KEY || '';
const LLM_MODEL = process.env.NIM_LLM_MODEL || 'stepfun-ai/step-3.5-flash';

const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || process.env.NIM_API_KEY || '';
const EMBEDDING_MODEL = process.env.NIM_EMBEDDING_MODEL || 'nvidia/llama-3.2-nv-embed-qa-4';

/**
 * Generate text embedding using NIM API
 * @param {string} text
 * @returns {Promise<number[]>} embedding vector (1024 dims)
 */
async function embedText(text) {
  const resp = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${EMBEDDING_API_KEY}`,
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
 * @param {Object} options additional options like tools
 * @returns {ReadableStream} SSE stream
 */
async function chatStream(messages, options = {}) {
  const body = {
    model: LLM_MODEL,
    messages,
    stream: true,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.max_tokens ?? 2048,
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
  }

  const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
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
async function chatComplete(messages, options = {}) {
  const body = {
    model: LLM_MODEL,
    messages,
    stream: false,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.max_tokens ?? 4096,
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
  }

  const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`NIM LLM error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

module.exports = { embedText, chatStream, chatComplete };
