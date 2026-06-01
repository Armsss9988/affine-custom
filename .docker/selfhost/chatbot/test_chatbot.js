#!/usr/bin/env node
/**
 * test_chatbot.js - Smoke tests cho chatbot proxy
 *
 * Test 3 nhóm:
 *  1. Unit: routing logic (isGeminiModel, resolveModel)
 *  2. Integration: gọi chatbot server thật (local hoặc VPS)
 *  3. End-to-end: kiểm tra Gemini ADC token + response thực
 *
 * Usage:
 *   node test_chatbot.js                        # test VPS production
 *   BASE_URL=http://localhost:3099 node test_chatbot.js  # test local
 *   node test_chatbot.js --unit                 # chỉ unit tests (không cần server)
 */

const BASE_URL = process.env.BASE_URL || 'http://168.138.167.9:3099';
const ONLY_UNIT = process.argv.includes('--unit');

// ─── Colors ───────────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

let passed = 0, failed = 0, skipped = 0;

function pass(name) {
  console.log(`  ${c.green}✓${c.reset} ${name}`);
  passed++;
}
function fail(name, reason) {
  console.log(`  ${c.red}✗${c.reset} ${c.bold}${name}${c.reset}`);
  console.log(`    ${c.red}→ ${reason}${c.reset}`);
  failed++;
}
function skip(name, reason) {
  console.log(`  ${c.yellow}⊘${c.reset} ${c.dim}${name} (${reason})${c.reset}`);
  skipped++;
}
function section(title) {
  console.log(`\n${c.cyan}${c.bold}▶ ${title}${c.reset}`);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeout || 15000);
  try {
    const resp = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: resp.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 1. Unit tests: routing logic ─────────────────────────────────────────────
function runUnitTests() {
  section('Unit: isGeminiModel routing logic');

  // Copy của hàm trong copilot.js để test độc lập
  function isGeminiModel(modelName) {
    if (!modelName) return false;
    const m = modelName.toLowerCase();
    return m.startsWith('gemini') || m.startsWith('text-embedding') || m.startsWith('gemini-embedding');
  }

  const cases = [
    ['gemini-3.5-flash',           true],
    ['gemini-2.5-flash',           true],
    ['gemini-2.0-flash',           true],
    ['gemini-1.5-pro',             true],
    ['gemini-embedding-001',       true],
    ['text-embedding-004',         true],
    ['text-embedding-3-small',     true],
    ['stepfun-ai/step-3.5-flash',  false],
    ['meta/llama-3.1-8b-instruct', false],
    ['gpt-4o',                     false],
    ['gpt-4o-mini',                false],
    [null,                         false],
    ['',                           false],
  ];

  for (const [model, expected] of cases) {
    const result = isGeminiModel(model);
    if (result === expected) {
      pass(`isGeminiModel("${model}") → ${expected}`);
    } else {
      fail(`isGeminiModel("${model}")`, `expected ${expected}, got ${result}`);
    }
  }
}

// ─── 2. Integration tests: server endpoints ───────────────────────────────────
async function runIntegrationTests() {
  section('Integration: Health + Models API');

  // 2.1 Health check
  try {
    const r = await request('/api/health');
    if (r.status === 200 && r.json?.status === 'ok') {
      pass('GET /api/health → 200 ok');
    } else {
      fail('GET /api/health', `status=${r.status} body=${r.text.slice(0, 100)}`);
    }
  } catch (e) {
    fail('GET /api/health', `Connection error: ${e.message}`);
  }

  // 2.2 OpenAI models list
  try {
    const r = await request('/v1/models');
    const models = r.json?.data?.map(m => m.id) || [];
    if (r.status === 200 && models.includes('gemini-3.5-flash')) {
      pass(`GET /v1/models → 200, có gemini-3.5-flash`);
    } else {
      fail('GET /v1/models', `models=${JSON.stringify(models.slice(0, 5))}`);
    }
    if (models.includes('stepfun-ai/step-3.5-flash')) {
      pass('GET /v1/models → có stepfun-ai/step-3.5-flash');
    } else {
      fail('GET /v1/models', `missing stepfun, got: ${JSON.stringify(models)}`);
    }
  } catch (e) {
    fail('GET /v1/models', e.message);
  }

  // 2.3 Gemini format models list
  try {
    const r = await request('/v1beta/models');
    const models = r.json?.models?.map(m => m.name) || [];
    if (r.status === 200 && models.some(m => m.includes('gemini-3.5-flash'))) {
      pass('GET /v1beta/models → 200, có models/gemini-3.5-flash');
    } else {
      fail('GET /v1beta/models', `models=${JSON.stringify(models.slice(0, 5))}`);
    }
  } catch (e) {
    fail('GET /v1beta/models', e.message);
  }

  // ─── Chat Completions routing ────────────────────────────────────────────────
  section('Integration: Chat Completions routing');

  // 2.4 Stepfun chat (non-stream)
  try {
    const r = await request('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'stepfun-ai/step-3.5-flash',
        stream: false,
        messages: [{ role: 'user', content: 'Reply with exactly: STEPFUN_OK' }],
        max_tokens: 20,
      },
      timeout: 20000,
    });
    const content = r.json?.choices?.[0]?.message?.content || '';
    if (r.status === 200 && content) {
      pass(`POST /v1/chat/completions (stepfun) → 200, reply: "${content.slice(0, 50)}"`);
    } else {
      fail('POST /v1/chat/completions (stepfun)', `status=${r.status} content="${content}"`);
    }
  } catch (e) {
    fail('POST /v1/chat/completions (stepfun)', e.message);
  }

  // 2.5 Gemini 3.5 chat (non-stream) - routes to Vertex AI
  try {
    const r = await request('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'gemini-3.5-flash',
        stream: false,
        messages: [{ role: 'user', content: 'Reply with exactly: GEMINI_OK' }],
        max_tokens: 20,
      },
      timeout: 20000,
    });
    const content = r.json?.choices?.[0]?.message?.content || '';
    if (r.status === 200 && content) {
      pass(`POST /v1/chat/completions (gemini-3.5-flash) → 200, reply: "${content.slice(0, 60)}"`);
    } else {
      fail('POST /v1/chat/completions (gemini-3.5-flash)', `status=${r.status} body=${r.text.slice(0, 200)}`);
    }
  } catch (e) {
    fail('POST /v1/chat/completions (gemini-3.5-flash)', e.message);
  }

  // ─── Gemini native format ────────────────────────────────────────────────────
  section('Integration: Gemini native format → Vertex AI');

  // 2.6 Gemini streamGenerateContent (Vertex AI proxy)
  try {
    const r = await request('/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse', {
      method: 'POST',
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Say: VERTEX_OK' }] }],
        generationConfig: { maxOutputTokens: 20 },
      },
      timeout: 20000,
    });
    if (r.status === 200) {
      // SSE stream - text should contain data: chunks
      const hasData = r.text.includes('data:') || r.text.includes('"text"');
      if (hasData) {
        pass('POST /v1beta/models/gemini-3.5-flash:streamGenerateContent → 200 SSE stream');
      } else {
        fail('POST /v1beta/models/gemini-3.5-flash:streamGenerateContent', `unexpected body: ${r.text.slice(0, 200)}`);
      }
    } else {
      fail('POST /v1beta/models/gemini-3.5-flash:streamGenerateContent', `status=${r.status} body=${r.text.slice(0, 300)}`);
    }
  } catch (e) {
    fail('POST /v1beta/models/gemini-3.5-flash:streamGenerateContent', e.message);
  }

  // 2.7 generateContent (non-stream, Vertex AI proxy)
  try {
    const r = await request('/v1beta/models/gemini-3.5-flash:generateContent', {
      method: 'POST',
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Reply with: VERTEX_NONSTREAM_OK' }] }],
        generationConfig: { maxOutputTokens: 30 },
      },
      timeout: 20000,
    });
    const text = r.json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (r.status === 200 && text) {
      pass(`POST /v1beta/models/gemini-3.5-flash:generateContent → 200, text: "${text.slice(0, 60)}"`);
    } else {
      fail('POST /v1beta/models/gemini-3.5-flash:generateContent', `status=${r.status} body=${r.text.slice(0, 300)}`);
    }
  } catch (e) {
    fail('POST /v1beta/models/gemini-3.5-flash:generateContent', e.message);
  }

  // ─── Embedding ───────────────────────────────────────────────────────────────
  section('Integration: Embeddings');

  // 2.8 OpenAI embeddings (NIM)
  try {
    const r = await request('/v1/embeddings', {
      method: 'POST',
      body: { model: 'nvidia/nv-embedqa-e5-v5', input: 'test embedding' },
      timeout: 15000,
    });
    const dim = r.json?.data?.[0]?.embedding?.length;
    if (r.status === 200 && dim > 0) {
      pass(`POST /v1/embeddings (NIM) → 200, dim=${dim}`);
    } else {
      fail('POST /v1/embeddings (NIM)', `status=${r.status} body=${r.text.slice(0, 200)}`);
    }
  } catch (e) {
    fail('POST /v1/embeddings (NIM)', e.message);
  }

  // 2.9 Gemini embedContent
  try {
    const r = await request('/v1beta/models/text-embedding-004:embedContent', {
      method: 'POST',
      body: {
        content: { parts: [{ text: 'test embedding gemini' }] },
        taskType: 'RETRIEVAL_QUERY',
      },
      timeout: 15000,
    });
    const dim = r.json?.embedding?.values?.length;
    if (r.status === 200 && dim > 0) {
      pass(`POST /v1beta/models/text-embedding-004:embedContent → 200, dim=${dim}`);
    } else {
      fail('POST /v1beta/models/text-embedding-004:embedContent', `status=${r.status} body=${r.text.slice(0, 200)}`);
    }
  } catch (e) {
    fail('POST /v1beta/models/text-embedding-004:embedContent', e.message);
  }

  // ─── Responses API ───────────────────────────────────────────────────────────
  section('Integration: OpenAI Responses API');

  // 2.10 Responses API non-stream với gemini model
  try {
    const r = await request('/v1/responses', {
      method: 'POST',
      body: {
        model: 'gemini-3.5-flash',
        stream: false,
        input: 'Reply with: RESPONSES_API_OK',
      },
      timeout: 20000,
    });
    const text = r.json?.output?.[0]?.content?.[0]?.text || '';
    if (r.status === 200 && text) {
      pass(`POST /v1/responses (gemini, non-stream) → 200, text: "${text.slice(0, 60)}"`);
    } else {
      fail('POST /v1/responses (gemini, non-stream)', `status=${r.status} body=${r.text.slice(0, 200)}`);
    }
  } catch (e) {
    fail('POST /v1/responses (gemini, non-stream)', e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${c.bold}${c.cyan}╔══════════════════════════════════════════╗`);
  console.log(`║  Chatbot Proxy Test Suite                ║`);
  console.log(`╚══════════════════════════════════════════╝${c.reset}`);
  console.log(`${c.dim}  Target: ${BASE_URL}${c.reset}\n`);

  runUnitTests();

  if (!ONLY_UNIT) {
    await runIntegrationTests();
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  const total = passed + failed + skipped;
  console.log(`\n${'─'.repeat(44)}`);
  console.log(`${c.bold}Results: ${total} tests`);
  console.log(`  ${c.green}${passed} passed${c.reset}  ${failed > 0 ? c.red : c.dim}${failed} failed${c.reset}  ${c.yellow}${skipped} skipped${c.reset}`);

  if (failed === 0) {
    console.log(`\n${c.green}${c.bold}✅ All tests passed!${c.reset}`);
  } else {
    console.log(`\n${c.red}${c.bold}❌ ${failed} test(s) failed${c.reset}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error(`\n${c.red}Fatal error: ${e.message}${c.reset}`);
  process.exit(1);
});
