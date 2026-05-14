# Kanban Board Creation Tool for Copilot

## Problem

Users cannot create Kanban boards through the AI Copilot chat. The existing `docCreate` tool only supports
standard markdown blocks (paragraph, list, code, etc.) and cannot create `affine:database` blocks which are
required for Kanban views.

## Solution

Add a `kanbanCreate` Copilot backend tool that constructs a full document containing an `affine:database`
block with Kanban view configuration using Yjs binary manipulation, then pushes it to storage via the
existing `DocWriter` pipeline.

## Architecture

### Flow

```
User chat: "tạo kanban board quản lý task"
  → Copilot LLM selects `kanbanCreate` tool with parsed args
  → Tool handler execution:
    1. Build Yjs binary (page → note → database → columns → rows → kanban view)
    2. Register doc via addDocToRootDoc()
    3. Push root doc update + new doc update to PgWorkspaceDocStorageAdapter
    4. EventBus emits 'doc.updates.pushed'
  → Client sync layer picks up update
  → BlockSuite renders database block with Kanban view
  → Tool returns { docId, databaseId }
```

## Input Schema

```typescript
z.object({
  title: z.string().describe('The title of the Kanban board document'),
  columns: z.array(z.object({
    name: z.string().describe('Column display name (e.g. "Status", "Assignee")'),
    type: z.enum(['title', 'select', 'number', 'rich-text']).default('rich-text')
      .describe('Column data type'),
    options: z.array(z.string()).optional()
      .describe('Options for select-type columns (e.g. ["To Do", "In Progress", "Done"])'),
  })).describe('Column definitions for the board').default([{ name: 'Status', type: 'select' }]),
  statuses: z.array(z.string()).default(['To Do', 'In Progress', 'Done'])
    .describe('Status groups for the Kanban columns'),
  cards: z.array(z.object({
    title: z.string().describe('Card title / task name'),
    status: z.string().optional().describe('Which status group this card belongs to'),
  })).describe('Cards to place on the board'),
})
```

## Yjs Block Structure

The tool constructs the following Yjs document structure:

```
blocks Map (Y.Map):
  "<pageId>" → Y.Map {
    sys:id → "<pageId>"
    sys:flavour → "affine:page"
    sys:version → 2
    sys:children → Y.Array ["<surfaceId>", "<noteId>"]
    prop:title → Y.Text "<board title>"
  }
  "<surfaceId>" → Y.Map {
    sys:id → "<surfaceId>"
    sys:flavour → "affine:surface"
    sys:version → 5
    sys:children → Y.Array []
  }
  "<noteId>" → Y.Map {
    sys:id → "<noteId>"
    sys:flavour → "affine:note"
    sys:version → 1
    sys:children → Y.Array ["<dbId>"]
    prop:xywh → "[0,0,800,95]"
    prop:displayMode → "both"
  }
  "<dbId>" → Y.Map {
    sys:id → "<dbId>"
    sys:flavour → "affine:database"
    sys:version → 3
    sys:children → Y.Array ["<rowId-1>", "<rowId-2>", ...]
    prop:title → Y.Text "<board title>"
    prop:columns → Y.Array [
      Y.Map { id → "<colId>", type → "select", name → "Status", data → Y.Map { options → Y.Array [{id, value, color}, ...] } }
    ]
    prop:cells → Y.Map {
      "<rowId-1>" → Y.Map { "<colId>" → Y.Map { columnId → "<colId>", value → "opt-0" } }
    }
    prop:views → Y.Array [
      Y.Map {
        id → "<viewId>", name → "Kanban View", mode → "kanban",
        columns → Y.Array [ Y.Map { id → "<colId>" } ],
        groupBy → Y.Map { type → "groupBy", columnId → "<colId>", name → "select" },
        header → Y.Map { titleColumn → "<colId>", iconColumn → "type" },
        filter → Y.Map { type → "group", op → "and", conditions → Y.Array [] },
        groupProperties → Y.Array [],
      }
    ]
  }
  "<rowId-N>" → Y.Map {
    sys:id → "<rowId-N>"
    sys:flavour → "affine:paragraph"
    sys:version → 1
    sys:children → Y.Array []
    prop:type → "text"
    prop:text → Y.Text "<card title>"
  }
```

### Key constants

- Page block version: `2`
- Surface block version: `5` (required for gfx/whiteboard layer)
- Note block version: `1`
- Database block version: `3`
- Paragraph (row) block version: `1`
- Note `prop:xywh`: `"[0,0,800,95]"` (default position/size)
- Note `prop:displayMode`: `"both"`

## Files Changed

| File | Change |
|---|---|
| `packages/backend/server/src/plugins/copilot/providers/types.ts` | Add `'kanbanCreate'` to `PromptToolsSchema` zod enum (line ~92) |
| `packages/backend/server/src/plugins/copilot/tools/doc-write.ts` | Add `buildKanbanHandler()` and `createKanbanTool()` |
| `packages/backend/server/src/plugins/copilot/tools/index.ts` | Export `createKanbanTool` |
| `packages/backend/server/src/plugins/copilot/runtime/tool-runtime.ts` | Add `case 'kanbanCreate'` to getTools() switch (after `docCompose`). Gate behind `env.dev || env.namespaces.canary` check alongside existing `docCreate`/`docUpdate` gates |

## Implementation Details

### DocWriter extension

Add a method `createDocWithKanban()` to `DocWriter` that:
1. Takes workspaceId, title, columns, statuses, cards, optional editorId
2. Generates IDs for all blocks (nanoid)
3. Constructs Yjs `Y.Doc` with the full block tree
4. Calls `Y.encodeStateAsUpdate(ydoc)` to get binary
5. Calls `addDocToRootDoc(rootDocBin, docId, title)` to get root doc update
6. Pushes both updates via `storage.pushDocUpdates()`
7. Returns `{ docId, databaseId }`

### Tool handler

```typescript
buildKanbanHandler(docWriter: DocWriter) {
  return (workspaceId: string, options: CopilotChatOptions) =>
    createKanbanTool({
      execute: async ({ title, columns, statuses, cards }) => {
        return docWriter.createDocWithKanban(workspaceId, title, {
          columns, statuses, cards,
        }, options.user);
      },
    });
}
```

### Edge cases

- **Cards status mismatch**: If a card's status doesn't match any status option, the cell value is set to the first status option by default
- **Empty cards**: Board is created with columns only, no rows — still renders correctly
- **No columns specified**: Default to a single `Status` select column with default statuses
- **Deeply nested text**: Card titles are plain text only (single-line)
- **Block schema versions**: Must stay in sync with blocksuite's `DatabaseBlockSchema.version` (currently 3)

### Color palette for status options

Use a predefined set of tag colors (matching blocksuite's `getTagColor()` palette):

```typescript
const TAG_COLORS = [
  'var(--affine-tag-pink)',
  'var(--affine-tag-blue)',
  'var(--affine-tag-green)',
  'var(--affine-tag-orange)',
  'var(--affine-tag-purple)',
  'var(--affine-tag-teal)',
  'var(--affine-tag-yellow)',
];
```

Assign colors to status options cyclically: `TAG_COLORS[i % TAG_COLORS.length]`.

### Permission check

The handler must assert `Workspace.CreateDoc` before executing, matching the existing `buildDocCreateHandler` pattern:

```typescript
const ac = await this.ac.get();
ac.user().workspace(workspaceId).assert('Workspace.CreateDoc');
```

### Prompt registration

The tool name `kanbanCreate` must be included in the relevant Copilot prompt's `config.tools` array so the LLM knows it's available. This can be done by updating the prompt seed data (e.g., `packages/backend/server/src/plugins/copilot/prompt/`) or via a database migration for the default chat prompt.

## Non-Goals

- Support for updating existing documents with a database block (v1 only creates new docs)
- Support for `multi-select`, `progress`, `date`, `link`, `checkbox` column types (v1)
- Mermaid, gantt, or other view presets (v1 only Kanban)
- Frontend Agent tool (out of scope for this implementation)
