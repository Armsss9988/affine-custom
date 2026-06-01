const express = require('express');
const { chatStream, chatComplete } = require('./nim');
const { geminiChatStream, geminiChatComplete, GEMINI_MODEL } = require('./gemini');

const router = express.Router();
const NIM_MODEL = process.env.NIM_LLM_MODEL || 'stepfun-ai/step-3.5-flash';
const LLM_MODEL = NIM_MODEL; // kept for backward compat in log messages

// ─── Smart routing helpers ────────────────────────────────────────────────────
/**
 * Return true if the model should be served by Vertex AI / Gemini backend.
 * Patterns: gemini-*, text-embedding-*, gemini-embedding-*
 */
function isGeminiModel(modelName) {
  if (!modelName) return false;
  const m = modelName.toLowerCase();
  return m.startsWith('gemini') || m.startsWith('text-embedding') || m.startsWith('gemini-embedding');
}

/**
 * Resolve the final model name:
 * - For Gemini models → keep as-is (Vertex uses real model names)
 * - For anything else → remap to NIM_MODEL
 */
function resolveModel(requestedModel) {
  if (isGeminiModel(requestedModel)) {
    console.log(`[Copilot Proxy] Gemini route: ${requestedModel} → Vertex AI`);
    return { model: requestedModel, backend: 'gemini' };
  }
  const mapped = requestedModel || NIM_MODEL;
  if (mapped !== requestedModel && requestedModel) {
    console.log(`[Copilot Proxy] NIM route: ${requestedModel} → ${NIM_MODEL}`);
  }
  return { model: NIM_MODEL, backend: 'nim' };
}

/** Backward-compat alias — just pick NIM model */
function remapModel(requestedModel) {
  return resolveModel(requestedModel).model;
}

const INTERACTIVE_BLOCKS_GUIDE = `
[AFFiNE INTERACTIVE BLOCKS SYSTEM GUIDE]
You are running inside AFFiNE, a next-gen collaborative workspace.
When generating or modifying document pages, you should use standard Markdown fenced code blocks to trigger powerful interactive widgets:
1. For standard programming code or interactive code play, use:
   \`\`\`python
   # Python execution sandbox
   \`\`\`
   or
   \`\`\`javascript
   // JS execution sandbox
   \`\`\`
2. For testing API requests and letting users send HTTP requests directly, use:
   \`\`\`http
   { "method": "GET", "url": "https://example.com" }
   \`\`\`
3. For displaying structured data, trees, or collapsible configuration lists, use:
   \`\`\`json
   { "key": "value" }
   \`\`\`
4. For creating presentations or slide decks, use:
   \`\`\`slides
   # Slide 1
   ---
   # Slide 2
   \`\`\`
Use these blocks appropriately whenever the user's request fits one of these use cases (e.g. they want a code playground, an API request tool, a structured data tree explorer, or slide presentation slides). Do not write any conversational text or filler outside of the document body.
`;

/**
 * Remap any model name requested by AFFiNE to the actual NIM LLM model.
 * AFFiNE may request 'gemini-2.5-flash', 'gpt-4o', etc. from its DB config —
 * we accept all of them and route to our NIM backend transparently.
 */
function remapModel(requestedModel) {
  if (!requestedModel || requestedModel === LLM_MODEL) return LLM_MODEL;
  console.log(`[Copilot Proxy] Model remap: ${requestedModel} → ${LLM_MODEL}`);
  return LLM_MODEL;
}

// Log all incoming requests
router.use((req, res, next) => {
  console.log(`[Copilot Proxy] ${req.method} ${req.url}`);
  next();
});

// Handle CORS preflight for all /v1 routes
router.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.send();
});

// Add CORS headers to all responses
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// ─── Helpers ───────────────────────────────────────────────

function responsesInputToMessages(input, instructions, hasTools = false) {
  const messages = [];

  let systemPrompt = instructions || '';
  if (systemPrompt) {
    if (hasTools) {
      systemPrompt += '\n\nIMPORTANT: You have access to tools. Call the appropriate tool immediately. Do NOT retry a failed tool indefinitely.';
    } else {
      systemPrompt += '\n\nOutput ONLY the final user-facing content. Do NOT include reasoning, analysis, <think> tags, or conversational filler like "Okay" or "I understand".';
    }
    systemPrompt += '\n' + INTERACTIVE_BLOCKS_GUIDE;
    messages.push({ role: 'system', content: systemPrompt });
  } else if (hasTools) {
    messages.push({ role: 'system', content: 'You are a helpful assistant with tools.\n' + INTERACTIVE_BLOCKS_GUIDE });
  } else {
    messages.push({ role: 'system', content: 'Output only the final user-facing content. Do not include reasoning, analysis, or <think> tags.\n' + INTERACTIVE_BLOCKS_GUIDE });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (item.type === 'message' || item.role) {
        const role = item.role || 'user';
        // Content can be a string or array of content parts
        let content = '';
        if (typeof item.content === 'string') {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          content = item.content
            .map(part => {
              if (typeof part === 'string') return part;
              if (part.type === 'input_text' || part.type === 'text') return part.text || '';
              if (part.type === 'output_text') return part.text || '';
              return '';
            })
            .filter(Boolean)
            .join('\n');
        }
        if (content) {
          messages.push({ role, content });
        }
      } else if (item.type === 'function_call_output') {
        // Tool results: convert to assistant tool_call + tool response pair
        messages.push({
          role: 'tool',
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
          tool_call_id: item.call_id || 'unknown',
        });
      }
    }
  }

  // Ensure we have at least one user message
  if (messages.length === 0 || !messages.some(m => m.role === 'user')) {
    messages.push({ role: 'user', content: 'Hello' });
  }

  return messages;
}

/**
 * Generate a unique response ID
 */
function genResponseId() {
  return `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Endpoints ─────────────────────────────────────────────

// 1. Models Endpoint — advertise both NIM + Gemini models
router.get('/models', (req, res) => {
  const ts = Math.floor(Date.now() / 1000);
  const geminiModels = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash', 'text-embedding-004', 'gemini-embedding-001'];
  const nimAliases = ['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small'];
  
  console.log(`[Models Endpoint] req.originalUrl=${req.originalUrl}, req.baseUrl=${req.baseUrl}`);
  
  if (req.originalUrl.includes('/v1beta') || req.baseUrl.includes('v1beta')) {
    // Gemini format
    return res.json({
      models: [
        ...geminiModels.map(id => ({ name: `models/${id}` })),
        { name: `models/${NIM_MODEL}` },
        ...nimAliases.map(id => ({ name: `models/${id}` }))
      ]
    });
  }

  // OpenAI format
  res.json({
    object: 'list',
    data: [
      { id: NIM_MODEL, object: 'model', created: ts, owned_by: 'nvidia-nim' },
      ...geminiModels.map(id => ({ id, object: 'model', created: ts, owned_by: 'google-vertex' })),
      ...nimAliases.map(id => ({ id, object: 'model', created: ts, owned_by: 'proxy' })),
    ],
  });
});

// ─── Shared stream pipe helper ───────────────────────────────────────────────
async function pipeStream(backendStream, res) {
  const reader = backendStream.getReader ? backendStream.getReader() : null;
  if (reader) {
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
          if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
          try {
            const parsed = JSON.parse(data);
            parsed.id = parsed.id || `chatcmpl-${Date.now()}`;
            parsed.object = 'chat.completion.chunk';
            res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          } catch (e) {
            res.write(`data: ${data}\n\n`);
          }
        }
      }
    }
  } else {
    for await (const chunk of backendStream) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) res.write(`${line}\n`);
      }
    }
  }
}

// 2. Chat Completions Endpoint — smart routes to Gemini or NIM
router.post('/chat/completions', async (req, res) => {
  const { messages, stream, model: rawModel, temperature, max_tokens, max_output_tokens } = req.body;
  const { model, backend } = resolveModel(rawModel);
  const opts = { model, temperature, max_tokens: max_tokens || max_output_tokens || 4096 };

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
  }

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const s = backend === 'gemini' ? await geminiChatStream(messages, opts) : await chatStream(messages, opts);
      await pipeStream(s, res);
      res.end();
    } else {
      const content = backend === 'gemini'
        ? await geminiChatComplete(messages, opts)
        : await chatComplete(messages, opts);
      res.json({
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  } catch (err) {
    console.error('[Copilot Proxy] Chat Completions Error:', err.message);
    res.status(500).json({ error: { message: err.message, type: 'api_error' } });
  }
});

// 3. OpenAI Responses API (used by AFFiNE Copilot via @ai-sdk/openai)
//    Converts Responses format → Chat Completions → backend → Responses format back
router.post('/responses', async (req, res) => {
  const { model: rawModel, input, instructions, stream, tools, toolChoice, temperature, max_tokens, text } = req.body;
  const { model, backend } = resolveModel(rawModel);
  const requestId = genResponseId();

  console.log(`[Copilot Responses] ${requestId} model=${rawModel}→${model} stream=${!!stream} tools=${(tools||[]).length} text=${JSON.stringify(text)}`);
  console.log(`[Copilot Responses] ${requestId} FULL BODY KEYS:`, Object.keys(req.body));
  console.log(`[Copilot Responses] ${requestId} INPUT TYPE:`, typeof input, Array.isArray(input) ? `array[${input.length}]` : '');
  if (tools && tools.length > 0) {
    console.log(`[Copilot Responses] ${requestId} TOOLS:`, tools.map(t => t.name || t.type || 'unknown').join(', '));
  }

  try {
    // Map tools to Chat Completions format FIRST so we know whether tools are present
    let openaiTools = [];
    if (tools && Array.isArray(tools)) {
      openaiTools = tools.filter(t => t.type === 'function' && t.name).map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || {}
        }
      }));
      console.log(`[Copilot Responses] mapped ${openaiTools.length} function tools for NIM`);
    }
    const hasTools = openaiTools.length > 0;

    // Convert Responses API input → Chat Completions messages with hasTools flag
    const messages = responsesInputToMessages(input, instructions, hasTools);

    const nimOptions = {
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 10000,
      tools: hasTools ? openaiTools : undefined
    };

    if (stream) {
      // ── Streaming Responses API (SSE) ──
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // Send initial response.created event
      const responseObj = {
        id: requestId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: model || LLM_MODEL,
        status: 'in_progress',
        output: [],
      };
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: responseObj })}\n\n`);

      // Signal output item creation
      const outputItemId = `msg_${Date.now()}`;
      const outputItem = {
        type: 'message',
        id: outputItemId,
        role: 'assistant',
        status: 'in_progress',
        content: [],
      };
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: outputItem })}\n\n`);

      // Signal content part creation
      const contentPart = { type: 'output_text', text: '', annotations: [] };
      res.write(`data: ${JSON.stringify({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: contentPart })}\n\n`);

      // Stream from backend (Gemini or NIM)
      const nimStream = backend === 'gemini'
        ? await geminiChatStream(messages, { ...nimOptions, model })
        : await chatStream(messages, nimOptions);
      const reader = nimStream.getReader ? nimStream.getReader() : null;
      let fullText = '';
      let fullReasoning = '';
      let isThinking = false; 
      let reasoningPartAdded = false;
      const ongoingToolCalls = {}; // To keep track of tool calls

      if (reader) {
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
                // Send done events for all ongoing tool calls
                for (const index in ongoingToolCalls) {
                  const tc = ongoingToolCalls[index];
                  res.write(`data: ${JSON.stringify({
                    type: 'response.output_item.done',
                    output_index: Number(index),
                    item: {
                      type: 'function_call',
                      id: tc.id,
                      call_id: tc.id,
                      name: tc.name,
                      arguments: tc.arguments,
                      status: 'completed'
                    }
                  })}\n\n`);
                }
                res.write('data: [DONE]\n\n');
                continue;
              }
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content || '';
                const reasoningDelta = parsed.choices?.[0]?.delta?.reasoning_content || '';
                const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;

                // Helper to send reasoning delta
                const sendReasoning = (text) => {
                  fullReasoning += text;
                  if (!reasoningPartAdded) {
                    res.write(`data: ${JSON.stringify({
                      type: 'response.content_part.added',
                      output_index: 0,
                      content_index: 1,
                      part: { type: 'reasoning', text: '' }
                    })}\n\n`);
                    reasoningPartAdded = true;
                  }
                  res.write(`data: ${JSON.stringify({
                    type: 'response.content_part.delta',
                    output_index: 0,
                    content_index: 1,
                    delta: text,
                  })}\n\n`);
                };

                // Handle reasoning (either from dedicated field or <think> tags)
                if (reasoningDelta) {
                  sendReasoning(reasoningDelta);
                }

                if (delta) {
                  let textToSend = delta;
                  
                  // Check for <think> tags if reasoning_content is not provided natively
                  if (!reasoningDelta) {
                    if (delta.includes('<think>')) {
                      isThinking = true;
                      const parts = delta.split('<think>');
                      // text before <think> (if any)
                      if (parts[0]) {
                        res.write(`data: ${JSON.stringify({
                          type: 'response.output_text.delta',
                          output_index: 0,
                          content_index: 0,
                          delta: parts[0],
                        })}\n\n`);
                      }
                      textToSend = parts[1] || '';
                    }

                    if (isThinking) {
                      if (textToSend.includes('</think>')) {
                        isThinking = false;
                        const parts = textToSend.split('</think>');
                        // reasoning before </think>
                        if (parts[0]) {
                          sendReasoning(parts[0]);
                        }
                        // actual content after </think>
                        textToSend = parts[1] || '';
                      } else {
                        // All is reasoning
                        sendReasoning(textToSend);
                        textToSend = '';
                      }
                    }
                  }

                  if (textToSend) {
                    fullText += textToSend;
                    res.write(`data: ${JSON.stringify({
                      type: 'response.output_text.delta',
                      output_index: 0,
                      content_index: 0,
                      delta: textToSend,
                    })}\n\n`);
                  }
                }

                if (parsed.choices?.[0]?.finish_reason) {
                  console.log(`[Copilot Proxy] NIM stream finished with reason: ${parsed.choices[0].finish_reason}`);
                }

                if (toolCalls && toolCalls.length > 0) {
                  console.log(`[Copilot Proxy] Received tool_calls delta:`, JSON.stringify(toolCalls));

                  for (const tc of toolCalls) {
                    const outputIdx = tc.index + 1; // offset by 1 because text is 0
                    if (!ongoingToolCalls[outputIdx]) {
                      ongoingToolCalls[outputIdx] = {
                        id: tc.id || `call_${Date.now()}`,
                        name: tc.function?.name || '',
                        arguments: ''
                      };
                    }
                    
                    if (tc.function?.name) {
                      ongoingToolCalls[outputIdx].name = tc.function.name;
                      res.write(`data: ${JSON.stringify({
                        type: 'response.output_item.added',
                        output_index: outputIdx,
                        item: {
                          type: 'function_call',
                          id: ongoingToolCalls[outputIdx].id,
                          call_id: ongoingToolCalls[outputIdx].id,
                          name: tc.function.name,
                          arguments: ''
                        }
                      })}\n\n`);
                    }
                    if (tc.function?.arguments) {
                      ongoingToolCalls[outputIdx].arguments += tc.function.arguments;
                      res.write(`data: ${JSON.stringify({
                        type: 'response.function_call_arguments.delta',
                        output_index: outputIdx,
                        item_id: ongoingToolCalls[outputIdx].id,
                        delta: tc.function.arguments
                      })}\n\n`);
                    }
                  }
                }
              } catch (e) { /* skip */ }
            }
          }
        }
      }

      // Send content part done
      res.write(`data: ${JSON.stringify({
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        text: fullText,
      })}\n\n`);

      if (reasoningPartAdded) {
        res.write(`data: ${JSON.stringify({
          type: 'response.content_part.done',
          output_index: 0,
          content_index: 1,
          part: { type: 'reasoning', text: fullReasoning, annotations: [] },
        })}\n\n`);
      }

      // Content part done
      res.write(`data: ${JSON.stringify({
        type: 'response.content_part.done',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: fullText, annotations: [] },
      })}\n\n`);

      // Output item done
      res.write(`data: ${JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: outputItemId,
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: fullText, annotations: [] },
            ...(reasoningPartAdded ? [{ type: 'reasoning', text: fullReasoning, annotations: [] }] : [])
          ],
        },
      })}\n\n`);

      // Response completed
      responseObj.status = 'completed';
      responseObj.output = [{
        type: 'message',
        id: outputItemId,
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: fullText, annotations: [] },
          ...(reasoningPartAdded ? [{ type: 'reasoning', text: fullReasoning, annotations: [] }] : [])
        ],
      }];
      responseObj.usage = {
        input_tokens: 0,
        output_tokens: fullText.length,
        total_tokens: fullText.length,
      };
      res.write(`data: ${JSON.stringify({ type: 'response.completed', response: responseObj })}\n\n`);

      res.end();
      console.log(`[Copilot Responses] ${requestId} completed (${fullText.length} chars)`);

    } else {
      // ── Non-streaming Responses API ──
      const content = backend === 'gemini'
        ? await geminiChatComplete(messages, { ...nimOptions, model })
        : await chatComplete(messages, nimOptions);

      const responseObj = {
        id: requestId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: model || LLM_MODEL,
        status: 'completed',
        output: [{
          type: 'message',
          id: `msg_${Date.now()}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: content, annotations: [] }],
        }],
        usage: {
          input_tokens: 0,
          output_tokens: content.length,
          total_tokens: content.length,
        },
      };

      res.json(responseObj);
      console.log(`[Copilot Responses] ${requestId} completed (${content.length} chars)`);
    }
  } catch (err) {
    console.error(`[Copilot Responses] ${requestId} Error:`, err.message);
    console.error(err.stack);
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: err.message, type: 'api_error', code: 'internal_error' }
      });
    } else {
      res.end();
    }
  }
});

// 4a. Gemini Embedding API — single item: embedContent
//     Called by AFFiNE Gemini provider for single-text embedding
router.post('/models/:modelName\\:embedContent', async (req, res) => {
  const { modelName } = req.params;
  const { content, taskType } = req.body;
  const requestId = genResponseId();

  console.log(`[Copilot Gemini EmbedContent] ${requestId} model=${modelName} taskType=${taskType}`);

  try {
    const { embedText } = require('./nim');

    // Extract text from Gemini format: content.parts[].text
    const parts = content?.parts || [];
    const text = parts.map(p => p.text || '').join(' ').trim() || 'empty';

    const vector = await embedText(text);

    // Gemini embedContent response format
    res.json({
      embedding: {
        values: vector
      }
    });
    console.log(`[Copilot Gemini EmbedContent] ${requestId} completed dim=${vector.length}`);
  } catch (err) {
    console.error(`[Copilot Gemini EmbedContent] ${requestId} Error:`, err.message);
    if (!res.headersSent) { res.status(500).json({ error: { message: err.message } }); }
  }
});

// 4b. Gemini Embedding API — batch: batchEmbedContents
//     Converts Gemini embedding format → NIM OpenAI embedding format → Gemini format back
router.post('/models/:modelName\\:batchEmbedContents', async (req, res) => {
  const { modelName } = req.params;
  const { requests } = req.body;
  const requestId = genResponseId();

  console.log(`[Copilot Gemini Embed] ${requestId} model=${modelName} requests=${(requests||[]).length}`);

  if (!requests || !Array.isArray(requests) || requests.length === 0) {
    return res.json({ embeddings: [] });
  }

  try {
    const { embedText } = require('./nim');

    // Extract texts from Gemini format: requests[].content.parts[].text
    const texts = requests.map(r => {
      const parts = r.content?.parts || [];
      return parts.map(p => p.text || '').join(' ').trim() || 'empty';
    });

    // Call NIM embedding for each text (batch)
    const embeddings = await Promise.all(texts.map(async (text) => {
      try {
        const vector = await embedText(text);
        return { values: vector };
      } catch (e) {
        console.error(`[Copilot Gemini Embed] ${requestId} embedding error:`, e.message);
        // Return zero vector on error
        return { values: new Array(1024).fill(0) };
      }
    }));

    res.json({ embeddings });
    console.log(`[Copilot Gemini Embed] ${requestId} completed ${embeddings.length} embeddings`);
  } catch (err) {
    console.error(`[Copilot Gemini Embed] ${requestId} Error:`, err.message);
    if (!res.headersSent) { res.status(500).json({ error: { message: err.message } }); }
  }
});

// 4b. Gemini API format interceptor (used when AFFiNE uses gemini provider)
//    Path example: /models/gemini-2.5-flash:streamGenerateContent
//    If model is a real Gemini model AND Vertex is configured → proxy to Vertex directly
//    Otherwise → convert to OpenAI format and call NIM
router.post('/models/:modelName\\::action', async (req, res) => {
  const { modelName, action } = req.params;
  const isStream = action === 'streamGenerateContent';
  const { contents, systemInstruction, generationConfig, tools } = req.body;
  const requestId = genResponseId();
  const useGeminiBackend = isGeminiModel(modelName) && !!process.env.VERTEX_PROJECT;
  
  console.log(`[Copilot Gemini Proxy] ${requestId} model=${modelName} action=${action} stream=${isStream} backend=${useGeminiBackend ? 'vertex' : 'nim'}`);
  
  try {
    // Build tool list FIRST so we know whether to inject tool instructions
    let openaiTools = [];
    if (tools && tools[0]?.functionDeclarations) {
      openaiTools = tools[0].functionDeclarations.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.parameters || {} }
      }));
      console.log(`[Copilot Gemini Proxy] ${requestId} received tools:`, openaiTools.map(t => t.function.name).join(', '));
    }
    const hasTools = openaiTools.length > 0;

    const messages = [];
    let sysText = systemInstruction?.parts?.[0]?.text || 'You are a helpful assistant.';
    // Only inject tool instructions when the request actually has tools.
    // Sub-calls like "Write an article" have NO tools — we must not inject anything
    // or the model will output reasoning headers / tool instructions inside the doc.
    if (hasTools) {
      sysText += '\n\nIMPORTANT: You have access to tools. Call the appropriate tool immediately. Do NOT retry a failed tool indefinitely.';
    } else {
      sysText += '\n\nOutput ONLY the final user-facing content. Do NOT include reasoning, analysis, <think> tags, or conversational filler like "Okay" or "I understand".';
    }
    sysText += '\n' + INTERACTIVE_BLOCKS_GUIDE;
    messages.push({ role: 'system', content: sysText });
    
    // Track tool_call_ids so we can pair functionCall with functionResponse
    const toolCallIdMap = {}; // functionName -> id
    let toolCallCounter = 0;

    if (contents && Array.isArray(contents)) {
      for (const c of contents) {
        const parts = Array.isArray(c.parts) ? c.parts : [];
        const funcRespParts = parts.filter(p => p.functionResponse);
        if (funcRespParts.length > 0) {
          for (const part of funcRespParts) {
            const respName = part.functionResponse.name || '';
            const matchedId = toolCallIdMap[respName] || ('call_' + respName + '_' + (++toolCallCounter));
            messages.push({
              role: 'tool',
              tool_call_id: matchedId,
              content: JSON.stringify(part.functionResponse.response || {})
            });
          }
          continue;
        }

        if (c.role === 'model' || c.role === 'assistant') {
          // Check for function calls
          const funcCallParts = parts.filter(p => p.functionCall);
          if (funcCallParts.length > 0) {
            const tool_calls = funcCallParts.map(p => {
              const name = p.functionCall.name;
              const id = 'call_' + name + '_' + (++toolCallCounter);
              toolCallIdMap[name] = id; // track latest id for this function name
              return {
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(p.functionCall.args || {}) }
              };
            });
            messages.push({
              role: 'assistant',
              content: null,
              tool_calls
            });
            continue;
          }
        }
        
        const text = parts.map(p => p.text).filter(Boolean).join('') || '';
        if (text) {
          messages.push({
            role: c.role === 'model' ? 'assistant' : 'user',
            content: text
          });
        }
      }
    }
    
    const nimOptions = {
      temperature: generationConfig?.temperature ?? 0.3,
      max_tokens: generationConfig?.maxOutputTokens ?? 4096,
      tools: hasTools ? openaiTools : undefined
    };
    
    console.log(`[Copilot Gemini Proxy] ${requestId} sending ${messages.length} messages to NIM.`);
    for (const m of messages) {
      if (m.tool_calls) {
        console.log(`[Copilot Gemini Proxy] ${requestId}   [assistant tool_calls]:`, m.tool_calls.map(tc => `${tc.function.name}(${tc.id})`).join(', '));
      } else if (m.role === 'tool') {
        console.log(`[Copilot Gemini Proxy] ${requestId}   [tool response] id=${m.tool_call_id} content=${m.content.substring(0, 200)}`);
      }
    }
    
    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // If real Gemini model + Vertex configured, proxy directly in Gemini format
      if (useGeminiBackend) {
        const { getAccessToken, getVertexEndpoint } = require('./gemini');
        const accessToken = await getAccessToken();
        const https2 = require('https');
        const fwdBody = JSON.stringify(req.body);
        const { hostname, path: urlPath } = getVertexEndpoint(modelName, 'streamGenerateContent');
        const fwdReq = https2.request({
          hostname,
          path: `${urlPath}?alt=sse`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'Content-Length': Buffer.byteLength(fwdBody),
          },
        }, (fwdRes) => {
          if (fwdRes.statusCode !== 200) {
            let errData = '';
            fwdRes.on('data', d => errData += d);
            fwdRes.on('end', () => {
              console.error(`[Vertex Proxy] ${requestId} HTTP ${fwdRes.statusCode}: ${errData}`);
              if (!res.headersSent) res.status(fwdRes.statusCode).json({ error: { message: errData } });
              else res.end();
            });
            return;
          }
          fwdRes.pipe(res);
        });
        fwdReq.on('error', (e) => {
          console.error(`[Vertex Proxy] ${requestId} Error:`, e.message);
          if (!res.headersSent) res.status(500).json({ error: { message: e.message } });
          else res.end();
        });
        fwdReq.write(fwdBody);
        fwdReq.end();
        return;
      }
      
      const nimStream = await chatStream(messages, nimOptions);
      const reader = nimStream.getReader ? nimStream.getReader() : null;
      
      // We accumulate tool call arguments across chunks if it streams them
      let currentToolCall = null;
      let hasEmittedReasoningHeader = false;
      let hasEmittedReasoningFooter = false;

      const processOpenAIChunk = (data) => {
        if (data === '[DONE]') {
           if (currentToolCall) {
              let argsObj = {};
              try { argsObj = JSON.parse(currentToolCall.args || "{}"); } catch(e) {}
              res.write(`data: ${JSON.stringify({candidates:[{content:{parts:[{functionCall:{name:currentToolCall.name,args:argsObj}}],role:"model"}}]})}\n\n`);
              currentToolCall = null;
           }
           res.write(`data: ${JSON.stringify({candidates:[{finishReason:"STOP",content:{parts:[{text:""}],role:"model"}}],usageMetadata:{}})}\n\n`);
           return;
        }
        try {
          const parsed = JSON.parse(data);
          let textChunk = parsed.choices?.[0]?.delta?.content || '';
          const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;
          const reasoningChunk = parsed.choices?.[0]?.delta?.reasoning_content || '';
          
          if (toolCalls && toolCalls.length > 0) {
             const t = toolCalls[0].function;
             if (t) {
               if (t.name) {
                 // Start of a tool call
                 currentToolCall = { name: t.name, args: t.arguments || '' };
               } else if (t.arguments && currentToolCall) {
                 // Continuation of arguments
                 currentToolCall.args += t.arguments;
               }
             }
             return;
          }
          
          // If we had a tool call streaming, and now we get text or finish, emit the tool call!
          if (!toolCalls && currentToolCall) {
             let argsObj = {};
             try { argsObj = JSON.parse(currentToolCall.args || "{}"); } catch(e) {}
             res.write(`data: ${JSON.stringify({candidates:[{content:{parts:[{functionCall:{name:currentToolCall.name,args:argsObj}}],role:"model"}}]})}\n\n`);
             currentToolCall = null;
          }

          if (reasoningChunk && !textChunk) {
            return;
          }

          if (false && reasoningChunk) {
            if (!hasEmittedReasoningHeader) {
              res.write(`data: ${JSON.stringify({candidates:[{content:{parts:[{text:"--- \n**🧠 Quá trình suy luận:**\n\n" + reasoningChunk}],role:"model"}}]})}\n\n`);
              hasEmittedReasoningHeader = true;
            } else {
              res.write(`data: ${JSON.stringify({candidates:[{content:{parts:[{text:reasoningChunk}],role:"model"}}]})}\n\n`);
            }
            return;
          }
          
          if (textChunk) {
            res.write(`data: ${JSON.stringify({candidates:[{content:{parts:[{text:textChunk}],role:"model"}}]})}\n\n`);
          }
        } catch (e) {}
      };

      if (reader) {
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
              processOpenAIChunk(line.slice(6).trim());
            }
          }
        }
        // flush any pending tool call
        if (currentToolCall) {
           let argsObj = {};
           try { argsObj = JSON.parse(currentToolCall.args || "{}"); } catch(e) {}
           res.write(`data: ${JSON.stringify({candidates:[{content:{parts:[{functionCall:{name:currentToolCall.name,args:argsObj}}],role:"model"}}]})}\n\n`);
           currentToolCall = null;
        }
      } else {
        for await (const chunk of nimStream) {
          const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              processOpenAIChunk(line.slice(6).trim());
            }
          }
        }
        if (currentToolCall) {
           let argsObj = {};
           try { argsObj = JSON.parse(currentToolCall.args || "{}"); } catch(e) {}
           res.write(`data: ${JSON.stringify({candidates:[{content:{parts:[{functionCall:{name:currentToolCall.name,args:argsObj}}],role:"model"}}]})}\n\n`);
           currentToolCall = null;
        }
      }
      res.end();
    } else {
      // Non-streaming: use Gemini directly if applicable
      if (useGeminiBackend) {
        const { getAccessToken, getVertexEndpoint } = require('./gemini');
        const accessToken = await getAccessToken();
        const https2 = require('https');
        const fwdBody = JSON.stringify(req.body);
        const { hostname, path: urlPath } = getVertexEndpoint(modelName, 'generateContent');
        await new Promise((resolve, reject) => {
          const fwdReq = https2.request({
            hostname,
            path: urlPath,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'Content-Length': Buffer.byteLength(fwdBody),
            },
          }, (fwdRes) => {
            let data = '';
            fwdRes.on('data', d => data += d);
            fwdRes.on('end', () => {
              res.status(fwdRes.statusCode).set('Content-Type', 'application/json').send(data);
              resolve();
            });
          });
          fwdReq.on('error', reject);
          fwdReq.write(fwdBody);
          fwdReq.end();
        });
        return;
      }
      const content = await chatComplete(messages, nimOptions);
      res.json({
        candidates: [{
          content: { parts: [{ text: content }], role: 'model' },
          finishReason: 'STOP'
        }]
      });
    }
  } catch (err) {
    console.error('[Copilot Gemini Proxy] Error:', err.message);
    if (!res.headersSent) { res.status(500).json({ error: { message: err.message } }); }
  }
});

// 5. OpenAI Embeddings API
router.post('/embeddings', async (req, res) => {
  const { model, input } = req.body;
  const requestId = genResponseId();

  console.log(`[Copilot Embeddings] ${requestId} model=${model} inputType=${typeof input}`);

  if (!input) {
    return res.status(400).json({ error: { message: 'input is required' } });
  }

  try {
    const { embedText } = require('./nim');

    let texts = [];
    if (Array.isArray(input)) {
      texts = input;
    } else {
      texts = [input];
    }

    const vectors = await Promise.all(
      texts.map(async (text) => {
        return await embedText(text);
      })
    );

    const data = vectors.map((vector, index) => ({
      object: 'embedding',
      index: index,
      embedding: vector,
    }));

    res.json({
      object: 'list',
      data,
      model: model || process.env.NIM_EMBEDDING_MODEL || 'nvidia/nv-embedqa-e5-v5',
      usage: {
        prompt_tokens: 0,
        total_tokens: 0,
      },
    });
    console.log(`[Copilot Embeddings] ${requestId} completed ${data.length} embeddings`);
  } catch (err) {
    console.error(`[Copilot Embeddings] ${requestId} Error:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message, type: 'api_error' } });
    }
  }
});

module.exports = router;
