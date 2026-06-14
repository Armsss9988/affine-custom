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

// 19. GET /api/tags - List all tags (calls list_tags MCP tool)
router.get('/tags', async (req, res) => {
  try {
    const mcpResult = await callMcp('list_tags', {});
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error listing tags:', error);
    res.status(500).json({ error: error.message });
  }
});

// 20. POST /api/tags - Create a new tag (calls create_tag MCP tool)
router.post('/tags', async (req, res) => {
  const { value } = req.body;
  if (!value) {
    return res.status(400).json({ error: 'value is required' });
  }
  try {
    const mcpResult = await callMcp('create_tag', { value });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error creating tag:', error);
    res.status(500).json({ error: error.message });
  }
});

// 21. POST /api/tags/add - Add tag to document (calls add_tag_to_doc MCP tool)
router.post('/tags/add', async (req, res) => {
  const { docId, tagId } = req.body;
  if (!docId || !tagId) {
    return res.status(400).json({ error: 'docId and tagId are required' });
  }
  try {
    const mcpResult = await callMcp('add_tag_to_doc', { docId, tagId });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error adding tag to doc:', error);
    res.status(500).json({ error: error.message });
  }
});

// 22. POST /api/tags/remove - Remove tag from document (calls remove_tag_from_doc MCP tool)
router.post('/tags/remove', async (req, res) => {
  const { docId, tagId } = req.body;
  if (!docId || !tagId) {
    return res.status(400).json({ error: 'docId and tagId are required' });
  }
  try {
    const mcpResult = await callMcp('remove_tag_from_doc', { docId, tagId });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error removing tag from doc:', error);
    res.status(500).json({ error: error.message });
  }
});

// 23. GET /api/favorites - List all favorites (calls list_favorites MCP tool)
router.get('/favorites', async (req, res) => {
  try {
    const mcpResult = await callMcp('list_favorites', {});
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error listing favorites:', error);
    res.status(500).json({ error: error.message });
  }
});

// 24. POST /api/favorites/add - Add favorite (calls add_favorite MCP tool)
router.post('/favorites/add', async (req, res) => {
  const { type, id } = req.body;
  if (!type || !id) {
    return res.status(400).json({ error: 'type and id are required' });
  }
  try {
    const mcpResult = await callMcp('add_favorite', { type, id });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error adding favorite:', error);
    res.status(500).json({ error: error.message });
  }
});

// 25. POST /api/favorites/remove - Remove favorite (calls remove_favorite MCP tool)
router.post('/favorites/remove', async (req, res) => {
  const { type, id } = req.body;
  if (!type || !id) {
    return res.status(400).json({ error: 'type and id are required' });
  }
  try {
    const mcpResult = await callMcp('remove_favorite', { type, id });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error removing favorite:', error);
    res.status(500).json({ error: error.message });
  }
});

// 26. POST /api/databases - Create database (calls create_database MCP tool)
router.post('/databases', async (req, res) => {
  const { title, columns, rows, viewMode } = req.body;
  if (!title || !columns) {
    return res.status(400).json({ error: 'title and columns are required' });
  }
  try {
    const mcpResult = await callMcp('create_database', { title, columns, rows, viewMode });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error creating database:', error);
    res.status(500).json({ error: error.message });
  }
});

// 27. GET /api/databases/:docId - Query database (calls query_database MCP tool)
router.get('/databases/:docId', async (req, res) => {
  const { docId } = req.params;
  try {
    const mcpResult = await callMcp('query_database', { docId });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error querying database:', error);
    res.status(500).json({ error: error.message });
  }
});

// 28. POST /api/databases/add-row - Add row to database (calls add_database_row MCP tool)
router.post('/databases/add-row', async (req, res) => {
  const { docId, cells } = req.body;
  if (!docId || !cells) {
    return res.status(400).json({ error: 'docId and cells are required' });
  }
  try {
    const mcpResult = await callMcp('add_database_row', { docId, cells });
    const text = mcpResult.content?.[0]?.text || '{}';
    res.json(JSON.parse(text));
  } catch (error) {
    console.error('[Docs API] Error adding database row:', error);
    res.status(500).json({ error: error.message });
  }
});

// 30. POST /api/copilot/chat - Unified Coordination Hub (Agentic multi-tool loop)
router.post('/copilot/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Set up streaming response headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const WORKSPACE_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'list_documents',
        description: 'List all documents in the workspace. Returns docId, title, createdAt, and inTrash status.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_document',
        description: 'Read the markdown content of a document by its ID.',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: 'The unique ID of the document' }
          },
          required: ['docId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_document',
        description: 'Create a new document with the given title and body content.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Title of the document' },
            content: { type: 'string', description: 'Markdown body content' }
          },
          required: ['title', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'update_document',
        description: 'Update the body content (markdown) of an existing document. Does not change title.',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: 'The unique ID of the document' },
            content: { type: 'string', description: 'The complete new markdown body' }
          },
          required: ['docId', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'update_document_meta',
        description: 'Update document metadata such as title.',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: 'The unique ID of the document' },
            title: { type: 'string', description: 'The new title' }
          },
          required: ['docId', 'title']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_folders',
        description: 'List the hierarchical folder tree in the workspace.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_folder',
        description: 'Create a folder in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The name of the new folder' },
            parentId: { type: 'string', description: 'Parent folder ID (optional)' }
          },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'add_doc_to_folder',
        description: 'Move/add a document to a folder.',
        parameters: {
          type: 'object',
          properties: {
            folderId: { type: 'string', description: 'The ID of the folder' },
            docId: { type: 'string', description: 'The ID of the document' }
          },
          required: ['folderId', 'docId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remove_doc_from_folder',
        description: 'Remove a document from a folder.',
        parameters: {
          type: 'object',
          properties: {
            folderId: { type: 'string', description: 'The ID of the folder' },
            docId: { type: 'string', description: 'The ID of the document' }
          },
          required: ['folderId', 'docId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_tags',
        description: 'List all tags in the workspace.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_tag',
        description: 'Create a new tag in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string', description: 'The name of the tag' }
          },
          required: ['value']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'add_tag_to_doc',
        description: 'Add a tag to a document.',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: 'Document ID' },
            tagId: { type: 'string', description: 'Tag ID' }
          },
          required: ['docId', 'tagId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remove_tag_from_doc',
        description: 'Remove a tag from a document.',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: 'Document ID' },
            tagId: { type: 'string', description: 'Tag ID' }
          },
          required: ['docId', 'tagId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_collections',
        description: 'List all collections in the workspace.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_collection',
        description: 'Create a new collection in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The name of the collection to create' }
          },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'add_doc_to_collection',
        description: 'Add a document to a collection.',
        parameters: {
          type: 'object',
          properties: {
            collectionId: { type: 'string', description: 'The ID of the collection' },
            docId: { type: 'string', description: 'The ID of the document' }
          },
          required: ['collectionId', 'docId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remove_doc_from_collection',
        description: 'Remove a document from a collection.',
        parameters: {
          type: 'object',
          properties: {
            collectionId: { type: 'string', description: 'The ID of the collection' },
            docId: { type: 'string', description: 'The ID of the document' }
          },
          required: ['collectionId', 'docId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_favorites',
        description: 'List the current user\'s favorite documents, folders, tags, or collections.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'add_favorite',
        description: 'Favorite a document, tag, or collection.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['doc', 'collection', 'tag'], description: 'Item type' },
            id: { type: 'string', description: 'Item ID' }
          },
          required: ['type', 'id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remove_favorite',
        description: 'Unfavorite a document, tag, or collection.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['doc', 'collection', 'tag'], description: 'Item type' },
            id: { type: 'string', description: 'Item ID' }
          },
          required: ['type', 'id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_database',
        description: 'Create a database document with custom schema and rows.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Title of the database document' },
            columns: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string', enum: ['title', 'rich-text', 'number', 'select', 'multi-select', 'date', 'checkbox'] }
                },
                required: ['name', 'type']
              }
            },
            rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  cells: { type: 'object' }
                },
                required: ['cells']
              }
            },
            viewMode: { type: 'string', enum: ['table', 'kanban'] }
          },
          required: ['title', 'columns']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_database',
        description: 'Query columns and rows of a database document.',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: 'ID of the database document' }
          },
          required: ['docId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'add_database_row',
        description: 'Add a new row to an existing database document.',
        parameters: {
          type: 'object',
          properties: {
            docId: { type: 'string', description: 'ID of the database document' },
            cells: { type: 'object', description: 'Key-value cell pairs' }
          },
          required: ['docId', 'cells']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Perform a web search query (DuckDuckGo).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keywords' }
          },
          required: ['query']
        }
      }
    }
  ];

  try {
    const { geminiChatStream } = require('./gemini');

    const messages = [
      {
        role: 'system',
        content: `You are an agentic workspace assistant for AFFiNE. You have direct access to the workspace via tools. 
When the user asks to manage documents, folders, tags, favorites, databases, or search the web, use the appropriate tools.
If you need to retrieve document list first before searching or reading, do so.
Always perform multi-step planning (e.g. if the user says "Add doc titled Project X, add it to folder Work, tag it important", create the document, get folders list, add the document to the folder, create/add tag).
Only output the final response back to the user after completing all tool calls.`
      },
      { role: 'user', content: message }
    ];

    let loopCount = 0;
    const maxLoops = 10;

    while (loopCount < maxLoops) {
      loopCount++;
      console.log(`[Coordination Hub] Loop ${loopCount}...`);

      const stream = await geminiChatStream(messages, {
        tools: WORKSPACE_TOOLS,
        temperature: 0.1
      });

      let textChunk = '';
      let toolCalls = [];

      let buffer = '';
      await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
          const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString();
          buffer += chunkStr;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta;
                if (delta?.content) {
                  textChunk += delta.content;
                  res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
                }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    if (!toolCalls[idx]) {
                      toolCalls[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
                    }
                    if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                    if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                    if (tc.thought_signature) toolCalls[idx].thought_signature = tc.thought_signature;
                  }
                }
              } catch (e) {
                // skip
              }
            }
          }
        });

        stream.on('end', () => {
          if (buffer) {
            const lines = buffer.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const dataStr = line.slice(6).trim();
                if (dataStr === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(dataStr);
                  const delta = parsed.choices?.[0]?.delta;
                  if (delta?.content) {
                    textChunk += delta.content;
                    res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
                  }
                  if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index;
                      if (!toolCalls[idx]) {
                        toolCalls[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
                      }
                      if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                      if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                      if (tc.thought_signature) toolCalls[idx].thought_signature = tc.thought_signature;
                    }
                  }
                } catch (e) {
                  // skip
                }
              }
            }
          }
          resolve();
        });

        stream.on('error', (err) => {
          reject(err);
        });
      });

      toolCalls = toolCalls.filter(Boolean);

      if (toolCalls.length === 0) {
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const assistantMessage = { role: 'assistant', tool_calls: toolCalls };
      messages.push(assistantMessage);

      for (const toolCall of toolCalls) {
        const name = toolCall.function.name;
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          console.error(`[Coordination Hub] Error parsing arguments for ${name}:`, toolCall.function.arguments);
        }

        console.log(`[Coordination Hub] Executing tool ${name} with args`, args);
        res.write(`data: ${JSON.stringify({ status: `Calling tool: ${name}...` })}\n\n`);

        let toolResultText = '';
        try {
          const mcpResult = await callMcp(name, args);
          const content = mcpResult.content || [];
          toolResultText = content.map(item => item.text).join('\n');
        } catch (err) {
          console.error(`[Coordination Hub] Tool execution failed for ${name}:`, err);
          toolResultText = `Error: ${err.message}`;
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: name,
          content: toolResultText
        });
      }
    }

    res.write(`data: ${JSON.stringify({ content: '\nMax tool execution loop limit reached.' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('[Coordination Hub] Error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

module.exports = router;
