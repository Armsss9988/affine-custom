const express = require('express');
const { pool } = require('./db');

const router = express.Router();

// Configuration
const AFFINE_EMAIL = process.env.AFFINE_EMAIL;
const AFFINE_PASSWORD = process.env.AFFINE_PASSWORD;
const AFFINE_WORKSPACE_ID = process.env.AFFINE_WORKSPACE_ID;
const CHATGPT_API_KEY = process.env.CHATGPT_API_KEY;

// Session Cache
let cachedCookie = '';
let cookieExpiry = 0;

// Middleware: Authenticate requests using the API Key (Bearer token OR query param)
router.use((req, res, next) => {
  if (!CHATGPT_API_KEY) {
    console.warn('[Docs API] Warning: CHATGPT_API_KEY is not configured. Endpoints are unprotected.');
    return next();
  }

  // Log incoming auth info for debugging
  const authHeader = req.headers.authorization || '';
  const queryKey = req.query.api_key || '';
  const customHeader = req.headers['x-api-key'] || '';
  console.log('[Docs API] Auth check — Authorization:', authHeader ? 'present' : 'missing', '| X-Api-Key:', customHeader ? 'present' : 'missing', '| Query:', queryKey ? 'present' : 'missing', '| UA:', req.headers['user-agent'] || 'unknown');

  // Option 1: Bearer token in Authorization header
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (token === CHATGPT_API_KEY) {
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
  }

  // Option 2: X-Api-Key custom header (ChatGPT Actions Custom auth)
  if (customHeader === CHATGPT_API_KEY) {
    return next();
  }

  // Option 3: API key as query parameter
  if (queryKey === CHATGPT_API_KEY) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
});

// Helper: Programmatically login to the AFFiNE NestJS server
async function loginToAffine() {
  console.log('[Docs API] Logging in to AFFiNE...');
  if (!AFFINE_EMAIL || !AFFINE_PASSWORD) {
    throw new Error('AFFINE_EMAIL or AFFINE_PASSWORD is not configured in environment.');
  }

  const response = await fetch('http://affine:3010/api/auth/sign-in', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: AFFINE_EMAIL,
      password: AFFINE_PASSWORD,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Login failed with status ${response.status}: ${errorText}`);
  }

  // Extract cookies from Set-Cookie headers
  const setCookieHeaders = response.headers.getSetCookie 
    ? response.headers.getSetCookie() 
    : [response.headers.get('set-cookie')].filter(Boolean);

  if (setCookieHeaders.length === 0) {
    throw new Error('Login response did not return any cookies.');
  }

  // Combine cookies into a single string for subsequent request headers
  const cookies = setCookieHeaders.map(c => c.split(';')[0]).join('; ');
  cachedCookie = cookies;
  // Cache for 10 minutes (or we can just reuse until 401)
  cookieExpiry = Date.now() + 10 * 60 * 1000;
  console.log('[Docs API] Logged in successfully. Cookies cached.');
  return cookies;
}

// Helper: Send JSON-RPC requests to the AFFiNE MCP endpoint
async function callMcp(toolName, toolArgs, retry = true) {
  let cookie = cachedCookie;
  if (!cookie || Date.now() > cookieExpiry) {
    cookie = await loginToAffine();
  }

  const workspaceId = AFFINE_WORKSPACE_ID;
  if (!workspaceId) {
    throw new Error('AFFINE_WORKSPACE_ID is not configured.');
  }

  const url = `http://affine:3010/api/workspaces/${workspaceId}/mcp`;
  console.log(`[Docs API] Calling MCP tool "${toolName}"...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArgs,
      },
      id: 1,
    }),
  });

  if (response.status === 401 && retry) {
    console.log('[Docs API] Received 401 Unauthorized. Retrying login...');
    cachedCookie = '';
    return callMcp(toolName, toolArgs, false);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`MCP request failed with status ${response.status}: ${errText}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(`MCP execution error: ${JSON.stringify(json.error)}`);
  }

  return json.result;
}// 1. GET /api/docs - List all documents in the workspace (Direct SQL Query)
router.get('/docs', async (req, res) => {
  const workspaceId = req.query.workspaceId || AFFINE_WORKSPACE_ID;
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId query parameter or AFFINE_WORKSPACE_ID env is required' });
  }

  try {
    const query = `
      SELECT page_id AS id, title,
        LEFT(REGEXP_REPLACE(summary, '[\n\r\t]+', ' ', 'g'), 120) AS summary,
        mode, public, published_at AS "publishedAt"
      FROM workspace_pages
      WHERE workspace_id = $1 AND blocked = false
      ORDER BY published_at DESC, page_id ASC
    `;
    const result = await pool.query(query, [workspaceId]);
    // Sanitize for ChatGPT JSON parser compatibility
    const docs = result.rows.map(r => ({
      id: r.id,
      title: (r.title || '').replace(/[ - ]/g, ' '),
      summary: (r.summary || "").replace(/[\x00-\x1f"{}\[\]\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 100),
      mode: r.mode,
      public: r.public
    }));
    res.json({ docs });
  } catch (error) {
    console.error('[Docs API] Error listing documents:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. GET /api/docs/:id - Read a specific document (calls read_document MCP tool)
router.get('/docs/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Get title from DB metadata
    const dbResult = await pool.query(
      'SELECT title FROM workspace_pages WHERE page_id = $1 LIMIT 1',
      [id]
    );
    const title = dbResult.rows[0]?.title || 'Untitled';

    // Retrieve markdown content via MCP
    const mcpResult = await callMcp('read_document', { docId: id });
    const contentText = mcpResult.content?.[0]?.text || '';

    res.json({
      id,
      title,
      content: contentText,
    });
  } catch (error) {
    console.error(`[Docs API] Error reading document ${id}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 3. POST /api/docs - Create a new document (calls create_document MCP tool)
router.post('/docs', async (req, res) => {
  const { title, content } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  try {
    const mcpResult = await callMcp('create_document', {
      title,
      content: content || '',
    });

    const resultText = mcpResult.content?.[0]?.text;
    if (!resultText) {
      throw new Error('Invalid response from create_document MCP tool');
    }

    const payload = JSON.parse(resultText);
    res.status(201).json(payload);
  } catch (error) {
    console.error('[Docs API] Error creating document:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. PUT /api/docs/:id - Update an existing document (calls update_document & update_document_meta MCP tools)
router.put('/docs/:id', async (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;

  if (title === undefined && content === undefined) {
    return res.status(400).json({ error: 'Either title or content must be provided for update' });
  }

  try {
    const updates = [];

    // If title is updated, call update_document_meta
    if (title !== undefined) {
      console.log(`[Docs API] Updating document meta title for ${id}...`);
      const metaResult = await callMcp('update_document_meta', {
        docId: id,
        title: title || 'Untitled',
      });
      updates.push({ type: 'meta', result: metaResult });
    }

    // If body content is updated, call update_document
    if (content !== undefined) {
      console.log(`[Docs API] Updating document content body for ${id}...`);
      const bodyResult = await callMcp('update_document', {
        docId: id,
        content,
      });
      updates.push({ type: 'body', result: bodyResult });
    }

    res.json({
      success: true,
      docId: id,
      message: 'Document updated successfully',
      details: updates,
    });
  } catch (error) {
    console.error(`[Docs API] Error updating document ${id}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 5. POST /api/docs/search - Search documents (calls semantic_search or keyword_search MCP tools)
router.post('/docs/search', async (req, res) => {
  const { query, type } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  const searchType = type === 'keyword' ? 'keyword_search' : 'semantic_search';

  try {
    const mcpResult = await callMcp(searchType, { query });
    const content = mcpResult.content || [];

    // Format search results nicely
    const results = content.map(item => {
      try {
        return JSON.parse(item.text);
      } catch (e) {
        return { text: item.text };
      }
    });

    res.json({ results });
  } catch (error) {
    console.error(`[Docs API] Error searching documents with type ${searchType}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 6. GET /api/folders - List folder tree (calls list_folders MCP tool)
router.get('/folders', async (req, res) => {
  try {
    const mcpResult = await callMcp('list_folders', {});
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error listing folders:', error);
    res.status(500).json({ error: error.message });
  }
});

// 7. POST /api/folders - Create folder (calls create_folder MCP tool)
router.post('/folders', async (req, res) => {
  const { name, parentId } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const mcpResult = await callMcp('create_folder', { name, parentId });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error creating folder:', error);
    res.status(500).json({ error: error.message });
  }
});

// 8. POST /api/folders/add - Add document to folder (calls add_doc_to_folder MCP tool)
router.post('/folders/add', async (req, res) => {
  const { folderId, docId } = req.body;
  if (!folderId || !docId) {
    return res.status(400).json({ error: 'folderId and docId are required' });
  }
  try {
    const mcpResult = await callMcp('add_doc_to_folder', { folderId, docId });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error adding doc to folder:', error);
    res.status(500).json({ error: error.message });
  }
});

// 9. POST /api/folders/remove - Remove document from folder (calls remove_doc_from_folder MCP tool)
router.post('/folders/remove', async (req, res) => {
  const { folderId, docId } = req.body;
  if (!folderId || !docId) {
    return res.status(400).json({ error: 'folderId and docId are required' });
  }
  try {
    const mcpResult = await callMcp('remove_doc_from_folder', { folderId, docId });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error removing doc from folder:', error);
    res.status(500).json({ error: error.message });
  }
});

// 10. GET /api/collections - List custom collections (calls list_collections MCP tool)
router.get('/collections', async (req, res) => {
  try {
    const mcpResult = await callMcp('list_collections', {});
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error listing collections:', error);
    res.status(500).json({ error: error.message });
  }
});

// 11. POST /api/collections - Create collection (calls create_collection MCP tool)
router.post('/collections', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const mcpResult = await callMcp('create_collection', { name });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error creating collection:', error);
    res.status(500).json({ error: error.message });
  }
});

// 12. POST /api/collections/add - Add document to collection (calls add_doc_to_collection MCP tool)
router.post('/collections/add', async (req, res) => {
  const { collectionId, docId } = req.body;
  if (!collectionId || !docId) {
    return res.status(400).json({ error: 'collectionId and docId are required' });
  }
  try {
    const mcpResult = await callMcp('add_doc_to_collection', { collectionId, docId });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error adding doc to collection:', error);
    res.status(500).json({ error: error.message });
  }
});

// 13. POST /api/collections/remove - Remove document from collection (calls remove_doc_from_collection MCP tool)
router.post('/collections/remove', async (req, res) => {
  const { collectionId, docId } = req.body;
  if (!collectionId || !docId) {
    return res.status(400).json({ error: 'collectionId and docId are required' });
  }
  try {
    const mcpResult = await callMcp('remove_doc_from_collection', { collectionId, docId });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error removing doc from collection:', error);
    res.status(500).json({ error: error.message });
  }
});

// 14. POST /api/web-search - Web search (calls web_search MCP tool)
router.post('/web-search', async (req, res) => {
  const { query, limit } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }
  try {
    const mcpResult = await callMcp('web_search', { query, limit: limit || 10 });
    const text = mcpResult.content?.[0]?.text || '[]';
    res.json({ results: JSON.parse(text) });
  } catch (error) {
    console.error('[Docs API] Error in web search:', error);
    res.status(500).json({ error: error.message });
  }
});

// 15. POST /api/url-reader - Read URL content (calls url_content_read MCP tool)
router.post('/url-reader', async (req, res) => {
  const { url, maxLength } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }
  try {
    const mcpResult = await callMcp('url_content_read', { url, maxLength: maxLength || 50000 });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error in url reader:', error);
    res.status(500).json({ error: error.message });
  }
});

// 16. POST /api/ui-features - Query UI features (calls query_ui_features MCP tool)
router.post('/ui-features', async (req, res) => {
  const { query, category, platform } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }
  try {
    const mcpResult = await callMcp('query_ui_features', { query, category: category || 'all', platform });
    const text = mcpResult.content?.[0]?.text || '[]';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error querying UI features:', error);
    res.status(500).json({ error: error.message });
  }
});

// 17. GET /api/kanban/:docId - Fetch tasks on Kanban view (calls list_kanban_tasks MCP tool)
router.get('/kanban/:docId', async (req, res) => {
  const { docId } = req.params;
  try {
    const mcpResult = await callMcp('list_kanban_tasks', { docId });
    const text = mcpResult.content?.[0]?.text || '[]';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error listing Kanban tasks:', error);
    res.status(500).json({ error: error.message });
  }
});

// 18. POST /api/kanban/update - Update Kanban task status (calls update_kanban_task_status MCP tool)
router.post('/kanban/update', async (req, res) => {
  const { docId, taskId, status } = req.body;
  if (!docId || !taskId || !status) {
    return res.status(400).json({ error: 'docId, taskId, and status are required' });
  }
  try {
    const mcpResult = await callMcp('update_kanban_task_status', { docId, taskId, status });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error updating Kanban task status:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
