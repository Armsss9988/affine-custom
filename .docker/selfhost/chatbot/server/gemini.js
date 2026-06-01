/**
 * gemini.js - Vertex AI Gemini backend using Application Default Credentials (ADC)
 *
 * Auth priority:
 *  1. GOOGLE_APPLICATION_CREDENTIALS env var → service account JSON file
 *  2. ADC well-known file (~/.config/gcloud/application_default_credentials.json)
 *     mounted into container via compose volume
 *
 * Token is cached and auto-refreshed 5 minutes before expiry.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const VERTEX_PROJECT   = process.env.VERTEX_PROJECT   || '';
const VERTEX_LOCATION  = process.env.VERTEX_LOCATION  || 'us-central1';
const GEMINI_MODEL     = process.env.GEMINI_LLM_MODEL  || 'gemini-3.5-flash';

// Scopes required for Vertex AI
const VERTEX_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

// ─── Token cache ────────────────────────────────────────────────────────────
let _cachedToken = null;       // { access_token, expires_at_ms }

async function getAccessToken() {
  const now = Date.now();
  if (_cachedToken && _cachedToken.expires_at_ms > now + 5 * 60 * 1000) {
    return _cachedToken.access_token;
  }

  // Load credentials
  const creds = loadCredentials();
  if (!creds) throw new Error('[Gemini ADC] No credentials found. Run gcloud auth application-default login or set GOOGLE_APPLICATION_CREDENTIALS.');

  let token;
  if (creds.type === 'service_account') {
    token = await fetchSAToken(creds);
  } else if (creds.type === 'authorized_user') {
    token = await refreshUserToken(creds);
  } else {
    throw new Error(`[Gemini ADC] Unsupported credential type: ${creds.type}`);
  }

  _cachedToken = {
    access_token: token.access_token,
    expires_at_ms: now + (token.expires_in || 3600) * 1000,
  };
  console.log(`[Gemini ADC] Token refreshed, expires in ${token.expires_in || 3600}s`);
  return _cachedToken.access_token;
}

function loadCredentials() {
  // 1. Explicit env var
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[Gemini ADC] Using GOOGLE_APPLICATION_CREDENTIALS: ${envPath}`);
    return JSON.parse(fs.readFileSync(envPath, 'utf8'));
  }

  // 2. ADC well-known file (gcloud auth application-default login)
  const adcPath = path.join(
    process.env.CLOUDSDK_CONFIG || path.join(process.env.HOME || '/root', '.config', 'gcloud'),
    'application_default_credentials.json'
  );
  if (fs.existsSync(adcPath)) {
    console.log(`[Gemini ADC] Using ADC file: ${adcPath}`);
    return JSON.parse(fs.readFileSync(adcPath, 'utf8'));
  }

  return null;
}

// ─── Service Account JWT → access token ─────────────────────────────────────
async function fetchSAToken(sa) {
  // Build JWT manually (no external deps)
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: VERTEX_SCOPES.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  const signingInput = `${header}.${payload}`;
  const privateKey = sa.private_key;
  const signature = await signRS256(signingInput, privateKey);
  const jwt = `${signingInput}.${signature}`;

  return fetchToken({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt });
}

// ─── Refresh authorized_user (gcloud ADC) token ─────────────────────────────
async function refreshUserToken(creds) {
  return fetchToken({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  });
}

function fetchToken(params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (json.error) return reject(new Error(`[Gemini ADC] Token error: ${json.error} - ${json.error_description}`));
        resolve(json);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── JWT helpers (no external deps) ─────────────────────────────────────────
function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

async function signRS256(data, privateKeyPem) {
  const { createSign } = require('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(data);
  return sign.sign(privateKeyPem, 'base64url');
}

// ─── Vertex AI endpoint builder ──────────────────────────────────────────────
function getVertexEndpoint(model, action) {
  if (!VERTEX_PROJECT) {
    // Fallback: use generativelanguage (Google AI) endpoint
    // Only works with a valid API key, not ADC
    throw new Error('[Gemini] VERTEX_PROJECT is not set. Please set VERTEX_PROJECT in .env');
  }
  // Use /publishers/google/models/ path (no project/location needed for public models)
  // This works with any valid access token from ADC
  return {
    hostname: `${VERTEX_LOCATION}-aiplatform.googleapis.com`,
    path: `/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:${action}`,
  };
}

// ─── Convert OpenAI messages → Gemini contents ──────────────────────────────
function toGeminiContents(messages) {
  const contents = [];
  let systemText = '';

  for (const m of messages) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + (m.content || '');
      continue;
    }
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.tool_call_id || 'tool', response: safeParseJson(m.content) } }],
      });
      continue;
    }
    if (m.tool_calls) {
      contents.push({
        role: 'model',
        parts: m.tool_calls.map(tc => ({
          functionCall: { name: tc.function.name, args: safeParseJson(tc.function.arguments) },
        })),
      });
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (m.content) {
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }

  return { contents, systemText };
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return { value: str }; }
}

// ─── Convert OpenAI tools → Gemini functionDeclarations ─────────────────────
function toGeminiFunctionDeclarations(tools) {
  if (!tools || tools.length === 0) return null;
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || {},
    })),
  }];
}

// ─── Convert Gemini response → OpenAI delta chunk ───────────────────────────
function geminiChunkToOpenAI(candidate, model) {
  const parts = candidate?.content?.parts || [];
  const textParts = parts.filter(p => p.text != null);
  const funcParts = parts.filter(p => p.functionCall);

  const delta = {};
  if (textParts.length > 0) delta.content = textParts.map(p => p.text).join('');

  if (funcParts.length > 0) {
    delta.tool_calls = funcParts.map((p, i) => ({
      index: i,
      id: `call_${p.functionCall.name}_${Date.now()}`,
      type: 'function',
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
    }));
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : null }],
  };
}

// ─── Streaming chat ──────────────────────────────────────────────────────────
async function geminiChatStream(messages, options = {}) {
  const model = options.model || GEMINI_MODEL;
  const token = await getAccessToken();
  const { contents, systemText } = toGeminiContents(messages);

  const body = {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.max_tokens ?? 4096,
    },
  };

  const gTools = toGeminiFunctionDeclarations(options.tools);
  if (gTools) body.tools = gTools;

  const { hostname, path: urlPath } = getVertexEndpoint(model, 'streamGenerateContent');

  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    let responseStarted = false;

    const req = https.request({
      hostname,
      path: urlPath + '?alt=sse',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let errData = '';
        res.on('data', d => errData += d);
        res.on('end', () => reject(new Error(`[Gemini] HTTP ${res.statusCode}: ${errData}`)));
        return;
      }

      // Convert Gemini SSE → OpenAI SSE as a ReadableStream
      const { Readable } = require('stream');
      const readable = new Readable({ read() {} });

      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const candidate = parsed.candidates?.[0];
            if (!candidate) continue;
            const openaiChunk = geminiChunkToOpenAI(candidate, model);
            readable.push(`data: ${JSON.stringify(openaiChunk)}\n\n`);
          } catch {}
        }
      });

      res.on('end', () => {
        readable.push('data: [DONE]\n\n');
        readable.push(null);
      });

      res.on('error', (e) => readable.destroy(e));

      if (!responseStarted) {
        responseStarted = true;
        resolve(readable);
      }
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Non-streaming chat ──────────────────────────────────────────────────────
async function geminiChatComplete(messages, options = {}) {
  const model = options.model || GEMINI_MODEL;
  const token = await getAccessToken();
  const { contents, systemText } = toGeminiContents(messages);

  const body = {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.max_tokens ?? 4096,
    },
  };

  const gTools = toGeminiFunctionDeclarations(options.tools);
  if (gTools) body.tools = gTools;

  const { hostname, path: urlPath } = getVertexEndpoint(model, 'generateContent');

  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`[Gemini] HTTP ${res.statusCode}: ${data}`));
        const parsed = JSON.parse(data);
        const text = parsed.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        resolve(text);
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Gemini Embedding ─────────────────────────────────────────────────────────
async function geminiEmbedText(text, model = 'text-embedding-004') {
  const token = await getAccessToken();
  const { hostname, path: urlPath } = getVertexEndpoint(model, 'embedContent');
  const body = JSON.stringify({ content: { parts: [{ text }] } });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`[Gemini Embed] HTTP ${res.statusCode}: ${data}`));
        const parsed = JSON.parse(data);
        resolve(parsed.embedding?.values || []);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Health check — test if ADC is configured ────────────────────────────────
async function testADC() {
  try {
    const token = await getAccessToken();
    console.log(`[Gemini ADC] ✅ Credentials loaded, token starts with: ${token.slice(0, 20)}...`);
    return true;
  } catch (err) {
    console.warn(`[Gemini ADC] ⚠️  ${err.message}`);
    return false;
  }
}

// Run health check at startup (non-blocking)
testADC();

module.exports = { geminiChatStream, geminiChatComplete, geminiEmbedText, getAccessToken, GEMINI_MODEL };
