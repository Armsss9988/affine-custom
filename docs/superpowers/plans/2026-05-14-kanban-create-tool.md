# Kanban Create Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `kanbanCreate` Copilot backend tool that creates documents with an `affine:database` block containing a Kanban view.

**Architecture:** The tool handler constructs a full Yjs document binary (page → surface → note → database block with columns/cells/rows/kanban view), registers it via `addDocToRootDoc()`, and pushes updates through the existing `PgWorkspaceDocStorageAdapter` pipeline.

**Tech Stack:** NestJS, yjs, Zod, nanoid, PgWorkspaceDocStorageAdapter

---

### Task 1: Add `kanbanCreate` to PromptToolsSchema

**Files:**
- Modify: `packages/backend/server/src/plugins/copilot/providers/types.ts:76-96`

- [ ] **Step 1: Add `'kanbanCreate'` to the enum**

In `types.ts`, add `'kanbanCreate'` after `'sectionEdit'`:

```typescript
export const PromptToolsSchema = z
  .enum([
    'blobRead',
    'codeArtifact',
    'conversationSummary',
    // work with indexer
    'docRead',
    'docCreate',
    'docUpdate',
    'docUpdateMeta',
    'docKeywordSearch',
    // work with embeddings
    'docSemanticSearch',
    // work with exa/model internal tools
    'webSearch',
    // artifact tools
    'docCompose',
    // section editing
    'sectionEdit',
    // kanban board creation
    'kanbanCreate',
  ])
  .array();
```

- [ ] **Step 2: Commit**

```bash
git add packages/backend/server/src/plugins/copilot/providers/types.ts
git commit --no-verify -m "feat(copilot): add kanbanCreate to PromptToolsSchema"
```

---

### Task 2: Add `createDocWithKanban` to DocWriter

**Files:**
- Modify: `packages/backend/server/src/core/doc/writer.ts`

- [ ] **Step 1: Add Yjs import**

Add at the top of `writer.ts` (with existing imports):
```typescript
import * as Y from 'yjs';
```

- [ ] **Step 2: Add result type interfaces**

After `UpdateDocResult` (around line 21):
```typescript
export interface KanbanColumnDef {
  name: string;
  type: 'title' | 'select' | 'number' | 'rich-text';
  options?: string[];
}

export interface KanbanCardDef {
  title: string;
  status?: string;
}

export interface CreateDocWithKanbanResult {
  docId: string;
  databaseId: string;
}
```

- [ ] **Step 3: Add `createDocWithKanban()` method**

Before `emitDocUpdatesPushed()` (the last private method), add:

```typescript
private readonly TAG_COLORS = [
  'var(--affine-tag-pink)',
  'var(--affine-tag-blue)',
  'var(--affine-tag-green)',
  'var(--affine-tag-orange)',
  'var(--affine-tag-purple)',
  'var(--affine-tag-teal)',
  'var(--affine-tag-yellow)',
];

async createDocWithKanban(
  workspaceId: string,
  title: string,
  columns: KanbanColumnDef[],
  statuses: string[],
  cards: KanbanCardDef[],
  editorId?: string
): Promise<CreateDocWithKanbanResult> {
  const rootDoc = await this.storage.getDoc(workspaceId, workspaceId);
  if (!rootDoc?.bin) {
    throw new NotFoundException(`Workspace ${workspaceId} not found`);
  }

  const rootDocBin = Buffer.isBuffer(rootDoc.bin)
    ? rootDoc.bin
    : Buffer.from(rootDoc.bin.buffer, rootDoc.bin.byteOffset, rootDoc.bin.byteLength);

  const docId = nanoid();
  const pageId = nanoid();
  const surfaceId = nanoid();
  const noteId = nanoid();
  const databaseId = nanoid();

  this.logger.log(`Creating kanban doc ${docId} in workspace ${workspaceId}`);

  const ydoc = new Y.Doc();
  const blocks = ydoc.getMap('blocks');

  // --- Page block ---
  const pageMap = new Y.Map() as any;
  pageMap.set('sys:id', pageId);
  pageMap.set('sys:flavour', 'affine:page');
  pageMap.set('sys:version', 2);
  const pageChildren = new Y.Array() as any;
  pageChildren.insert(0, [surfaceId, noteId]);
  pageMap.set('sys:children', pageChildren);
  pageMap.set('prop:title', new Y.Text(title));
  blocks.set(pageId, pageMap);

  // --- Surface block ---
  const surfaceMap = new Y.Map() as any;
  surfaceMap.set('sys:id', surfaceId);
  surfaceMap.set('sys:flavour', 'affine:surface');
  surfaceMap.set('sys:version', 5);
  surfaceMap.set('sys:children', new Y.Array() as any);
  blocks.set(surfaceId, surfaceMap);

  // --- Note block ---
  const noteMap = new Y.Map() as any;
  noteMap.set('sys:id', noteId);
  noteMap.set('sys:flavour', 'affine:note');
  noteMap.set('sys:version', 1);
  const noteChildren = new Y.Array() as any;
  noteChildren.insert(0, [databaseId]);
  noteMap.set('sys:children', noteChildren);
  noteMap.set('prop:xywh', '[0,0,800,95]');
  noteMap.set('prop:displayMode', 'both');
  blocks.set(noteId, noteMap);

  // --- Determine effective columns ---
  const colNameToId: Record<string, string> = {};
  const hasStatusCol = columns.some(c => c.name === 'Status');
  const allCols = hasStatusCol ? columns : [
    { name: 'Status', type: 'select' as const, options: statuses },
    ...columns,
  ];

  // --- Build columns Y.Array ---
  const columnIds: string[] = [];
  const colsArray = new Y.Array() as any;
  for (const col of allCols) {
    const colId = nanoid();
    columnIds.push(colId);
    colNameToId[col.name] = colId;
    const colMap = new Y.Map() as any;
    colMap.set('id', colId);
    colMap.set('type', col.type);
    colMap.set('name', col.name);

    const dataMap = new Y.Map() as any;
    if (col.type === 'select' && col.options?.length) {
      const optsArray = new Y.Array() as any;
      optsArray.insert(0, col.options.map((opt, i) => {
        const optMap = new Y.Map() as any;
        optMap.set('id', `opt-${i}`);
        optMap.set('value', opt);
        optMap.set('color', this.TAG_COLORS[i % this.TAG_COLORS.length]);
        return optMap;
      }));
      dataMap.set('options', optsArray);
    }
    colMap.set('data', dataMap);
    colsArray.push([colMap]);
  }

  // --- Build row blocks + cells ---
  const childIds: string[] = [];
  const cellsMap = new Y.Map() as any;
  for (const card of cards) {
    const rowId = nanoid();
    childIds.push(rowId);

    const rowMap = new Y.Map() as any;
    rowMap.set('sys:id', rowId);
    rowMap.set('sys:flavour', 'affine:paragraph');
    rowMap.set('sys:version', 1);
    rowMap.set('sys:children', new Y.Array() as any);
    rowMap.set('prop:type', 'text');
    rowMap.set('prop:text', new Y.Text(card.title));
    blocks.set(rowId, rowMap);

    const statusColId = colNameToId['Status'];
    if (statusColId && statuses.length > 0) {
      const optIdx = card.status ? Math.max(0, statuses.indexOf(card.status)) : 0;
      const rowCells = new Y.Map() as any;
      rowCells.set(statusColId, {
        columnId: statusColId,
        value: [{ id: `opt-${optIdx}`, value: statuses[optIdx] }],
      } as any);
      cellsMap.set(rowId, rowCells);
    }
  }

  // --- Build kanban view ---
  const viewsArray = new Y.Array() as any;
  const statusColId = colNameToId['Status'];
  if (statusColId) {
    const viewMap = new Y.Map() as any;
    viewMap.set('id', nanoid());
    viewMap.set('name', 'Kanban View');
    viewMap.set('mode', 'kanban');

    const viewCols = new Y.Array() as any;
    viewCols.insert(0, columnIds.map(id => {
      const m = new Y.Map() as any;
      m.set('id', id);
      return m;
    }));
    viewMap.set('columns', viewCols);

    const filterMap = new Y.Map() as any;
    filterMap.set('type', 'group');
    filterMap.set('op', 'and');
    filterMap.set('conditions', new Y.Array() as any);
    viewMap.set('filter', filterMap);

    const groupByMap = new Y.Map() as any;
    groupByMap.set('type', 'groupBy');
    groupByMap.set('columnId', statusColId);
    groupByMap.set('name', 'select');
    viewMap.set('groupBy', groupByMap);

    const headerMap = new Y.Map() as any;
    headerMap.set('titleColumn', statusColId);
    headerMap.set('iconColumn', 'type');
    viewMap.set('header', headerMap);

    viewMap.set('groupProperties', new Y.Array() as any);
    viewsArray.push([viewMap]);
  }

  // --- Assemble database block ---
  const dbMap = new Y.Map() as any;
  dbMap.set('sys:id', databaseId);
  dbMap.set('sys:flavour', 'affine:database');
  dbMap.set('sys:version', 3);
  const dbChildren = new Y.Array() as any;
  dbChildren.insert(0, childIds);
  dbMap.set('sys:children', dbChildren);
  dbMap.set('prop:title', new Y.Text(title));
  dbMap.set('prop:columns', colsArray);
  dbMap.set('prop:cells', cellsMap);
  dbMap.set('prop:views', viewsArray);
  blocks.set(databaseId, dbMap);

  // Encode full Yjs binary
  const binary = Buffer.from(Y.encodeStateAsUpdate(ydoc));

  // Register in root doc
  const rootDocUpdate = addDocToRootDoc(rootDocBin, docId, title);

  // Push root doc update
  const rootTimestamp = await this.storage.pushDocUpdates(
    workspaceId, workspaceId, [rootDocUpdate], editorId
  );
  this.emitDocUpdatesPushed({
    spaceId: workspaceId, docId: workspaceId,
    updates: [rootDocUpdate], timestamp: rootTimestamp, editor: editorId,
  });

  // Push new doc binary
  const docTimestamp = await this.storage.pushDocUpdates(
    workspaceId, docId, [binary], editorId
  );
  this.emitDocUpdatesPushed({
    spaceId: workspaceId, docId,
    updates: [binary], timestamp: docTimestamp, editor: editorId,
  });

  await this.updateDocProperties(
    workspaceId, docId,
    { createdBy: editorId, updatedBy: editorId },
    editorId
  );

  this.logger.log(`Created kanban doc ${docId} (database ${databaseId})`);
  return { docId, databaseId };
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/backend/server/src/core/doc/writer.ts
git commit --no-verify -m "feat(doc): add createDocWithKanban method"
```

---

### Task 3: Add kanban handler and tool to doc-write.ts

**Files:**
- Modify: `packages/backend/server/src/plugins/copilot/tools/doc-write.ts`

- [ ] **Step 1: Add handler and tool factory**

Add at the end of `doc-write.ts`:

```typescript
export const buildKanbanHandler = (
  ac: AccessController,
  writer: DocWriter
) => {
  return async (
    options: CopilotChatOptions,
    title: string,
    columns: { name: string; type: string; options?: string[] },
    statuses: string[],
    cards: { title: string; status?: string }[]
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Kanban Create Failed',
        'Missing user or workspace context'
      );
    }

    await ac
      .user(options.user)
      .workspace(options.workspace)
      .assert('Workspace.CreateDoc');

    const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
    if (!sanitizedTitle) {
      return toolError('Kanban Create Failed', 'Title cannot be empty');
    }

    const result = await writer.createDocWithKanban(
      options.workspace,
      sanitizedTitle,
      columns.map(c => ({
        name: c.name,
        type: c.type as any || 'rich-text',
        options: c.options,
      })),
      statuses,
      cards.map(c => ({
        title: (c.title || '').replace(/[\r\n]+/g, ' ').trim() || c.title,
        status: c.status,
      })),
      options.user
    );

    return {
      success: true,
      docId: result.docId,
      databaseId: result.databaseId,
      message: `Kanban board "${sanitizedTitle}" created successfully`,
    };
  };
};

export const createKanbanTool = (
  createKanban: (
    title: string,
    columns: { name: string; type: string; options?: string[] }[],
    statuses: string[],
    cards: { title: string; status?: string }[]
  ) => Promise<object>
) => {
  return defineTool({
    description:
      'Create a new document containing a Kanban board (database block with Kanban view). ' +
      'Users can specify columns, status groups for the Kanban lanes, and cards/tasks. ' +
      'The board is grouped by the Status column by default.',
    inputSchema: z.object({
      title: z.string().min(1).describe('The title of the Kanban board document'),
      columns: z
        .array(
          z.object({
            name: z.string().describe('Column display name (e.g. "Status", "Assignee")'),
            type: z
              .enum(['title', 'select', 'number', 'rich-text'])
              .default('rich-text')
              .describe('Column data type'),
            options: z
              .array(z.string())
              .optional()
              .describe('Options for select-type columns'),
          })
        )
        .default([{ name: 'Status', type: 'select' }])
        .describe('Column definitions for the board'),
      statuses: z
        .array(z.string())
        .default(['To Do', 'In Progress', 'Done'])
        .describe('Status groups for the Kanban lanes'),
      cards: z
        .array(
          z.object({
            title: z.string().describe('Card title'),
            status: z.string().optional().describe('Status group this card belongs to'),
          })
        )
        .default([])
        .describe('Cards to add to the board'),
    }),
    execute: async ({ title, columns, statuses, cards }) => {
      try {
        return await createKanban(title, columns, statuses, cards);
      } catch (err: any) {
        logger.error(`Failed to create kanban board: ${title}`, err);
        return toolError('Kanban Create Failed', err.message);
      }
    },
  });
};
```

- [ ] **Step 2: Commit**

```bash
git add packages/backend/server/src/plugins/copilot/tools/doc-write.ts
git commit --no-verify -m "feat(copilot): add kanbanCreate handler and tool factory"
```

---

### Task 4: Wire kanbanCreate into ToolRuntime

**Files:**
- Modify: `packages/backend/server/src/plugins/copilot/runtime/tool-runtime.ts`

- [ ] **Step 1: Update import**

In the import block at the top, add `buildKanbanHandler` and `createKanbanTool`:

```typescript
import {
  buildDocCreateHandler,
  buildDocUpdateHandler,
  buildDocUpdateMetaHandler,
  buildKanbanHandler,
  createDocCreateTool,
  createDocUpdateTool,
  createDocUpdateMetaTool,
  createKanbanTool,
} from '../tools/doc-write';
```

- [ ] **Step 2: Add switch case**

After `sectionEdit` case (before switch closing brace), add:

```typescript
case 'kanbanCreate': {
  if (!(env.dev || env.namespaces.canary)) {
    continue;
  }
  const createKanban = buildKanbanHandler(this.ac, this.docWriter);
  tools.kanban_create = createKanbanTool(createKanban.bind(null, options));
  break;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/backend/server/src/plugins/copilot/runtime/tool-runtime.ts
git commit --no-verify -m "feat(copilot): wire kanbanCreate into ToolRuntime"
```

---

### Task 5: Build the image, pull, and test

- [ ] **Step 1: Push to GitHub**

```bash
git push
```

Wait for the auto-build workflow to complete on GitHub Actions.

- [ ] **Step 2: Pull new image and restart**

```bash
docker compose pull affine
docker compose up -d --force-recreate affine
```

- [ ] **Step 3: Test via chat**

Open AFFiNE chat and try: "tạo kanban board quản lý task với các cột Status, Assignee và 3 card"
