const express = require('express');
const { chatStream, chatComplete } = require('./nim');

const router = express.Router();
const LLM_MODEL = process.env.NIM_LLM_MODEL || 'stepfun-ai/step-3.5-flash';

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

/**
 * Convert OpenAI Responses API "input" to Chat Completions "messages"
 * The Responses API sends input as either a string or an array of items.
 */
function responsesInputToMessages(input, instructions) {
  const messages = [];

  // Add system instructions if present
  let systemPrompt = instructions || '';
  if (systemPrompt) {
    systemPrompt += '\n\nIMPORTANT: You have access to tools (functions). If the user asks you to create, read, search, or modify documents, you MUST use the provided tools instead of just telling the user you will do it. For example, if asked to create a document, use the doc_compose or docCreate tool immediately.';
    messages.push({ role: 'system', content: systemPrompt });
  } else {
    messages.push({ role: 'system', content: 'You are a helpful assistant. You have access to tools. If the user asks you to create, read, search, or modify documents, you MUST use the provided tools instead of just telling the user you will do it.' });
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

// 1. Models Endpoint — advertise NIM model under its real name AND all common aliases
//    so AFFiNE's model picker always finds a valid option
router.get('/models', (req, res) => {
  const ts = Math.floor(Date.now() / 1000);
  const aliases = ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gemini-2.5-flash', 'gemini-2.0-flash', 'claude-3-5-sonnet'];
  
  console.log(`[Models Endpoint] req.originalUrl=${req.originalUrl}, req.baseUrl=${req.baseUrl}`);
  
  if (req.originalUrl.includes('/v1beta') || req.baseUrl.includes('v1beta')) {
    // Gemini format
    return res.json({
      models: [
        { name: `models/${LLM_MODEL}` },
        ...aliases.map(id => ({ name: `models/${id}` }))
      ]
    });
  }

  // OpenAI format
  res.json({
    object: 'list',
    data: [
      { id: LLM_MODEL, object: 'model', created: ts, owned_by: 'nvidia-nim' },
      ...aliases.map(id => ({ id, object: 'model', created: ts, owned_by: 'proxy' })),
    ],
  });
});

// 2. Chat Completions Endpoint (legacy, kept for compatibility)
router.post('/chat/completions', async (req, res) => {
  const { messages, stream, model: rawModel, temperature, max_tokens, max_output_tokens } = req.body;
  const _model = remapModel(rawModel); // remap but NIM uses env var model internally
  const nimOptions = {
    temperature,
    max_tokens: max_tokens || max_output_tokens || 4096
  };

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: { message: 'messages array is required', type: 'invalid_request_error' }
    });
  }

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const nimStream = await chatStream(messages, nimOptions);
      const reader = nimStream.getReader ? nimStream.getReader() : null;

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
        for await (const chunk of nimStream) {
          const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) res.write(`${line}\n`);
          }
        }
      }
      res.end();
    } else {
      const content = await chatComplete(messages, nimOptions);
      res.json({
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: LLM_MODEL,
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
//    Converts Responses format → Chat Completions → NIM → Responses format back
router.post('/responses', async (req, res) => {
  const { model: rawModel, input, instructions, stream, tools, toolChoice, temperature, max_tokens, text } = req.body;
  const model = remapModel(rawModel);
  const requestId = genResponseId();

  console.log(`[Copilot Responses] ${requestId} model=${rawModel}→${model} stream=${!!stream} tools=${(tools||[]).length} text=${JSON.stringify(text)}`);
  console.log(`[Copilot Responses] ${requestId} FULL BODY KEYS:`, Object.keys(req.body));
  console.log(`[Copilot Responses] ${requestId} INPUT TYPE:`, typeof input, Array.isArray(input) ? `array[${input.length}]` : '');
  if (tools && tools.length > 0) {
    console.log(`[Copilot Responses] ${requestId} TOOLS:`, tools.map(t => t.name || t.type || 'unknown').join(', '));
  }

  try {
    // Convert Responses API input → Chat Completions messages
    const messages = responsesInputToMessages(input, instructions);

    // Map tools to Chat Completions format
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

      // Stream from NIM
      const nimOptions = { temperature, max_tokens };
      if (openaiTools.length > 0) {
        nimOptions.tools = openaiTools;
        nimOptions.tool_choice = toolChoice || 'auto';
      }
      
      const nimStream = await chatStream(messages, nimOptions);
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
      const nimOptions = { temperature, max_tokens };
      if (openaiTools.length > 0) {
        nimOptions.tools = openaiTools;
        nimOptions.tool_choice = toolChoice || 'auto';
      }
      const content = await chatComplete(messages, nimOptions);

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

module.exports = router;
