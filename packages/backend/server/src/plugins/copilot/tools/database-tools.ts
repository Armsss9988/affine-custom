import { Logger } from '@nestjs/common';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { z } from 'zod';

import { addDocToRootDoc } from '../../../native';
import { PgWorkspaceDocStorageAdapter } from '../../../core/doc/adapters/workspace';
import { AccessController } from '../../../core/permission';
import { Models } from '../../../models';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DatabaseTools');

const TAG_COLORS = [
  'var(--affine-tag-pink)',
  'var(--affine-tag-blue)',
  'var(--affine-tag-green)',
  'var(--affine-tag-orange)',
  'var(--affine-tag-purple)',
  'var(--affine-tag-teal)',
  'var(--affine-tag-yellow)',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function getOrCreateOptionId(colMap: Y.Map<any>, value: string): string {
  let dataMap = colMap.get('data');
  if (!(dataMap instanceof Y.Map)) {
    dataMap = new Y.Map();
    colMap.set('data', dataMap);
  }
  let optionsArray = dataMap.get('options');
  if (!(optionsArray instanceof Y.Array)) {
    optionsArray = new Y.Array();
    dataMap.set('options', optionsArray);
  }

  // Find option
  for (let i = 0; i < optionsArray.length; i++) {
    const optMap = optionsArray.get(i) as Y.Map<any>;
    if (optMap.get('value') === value) {
      return optMap.get('id') as string;
    }
  }

  // Create new option
  const optId = `opt-${nanoid(6)}`;
  const optMap = new Y.Map();
  optMap.set('id', optId);
  optMap.set('value', value);
  const color = TAG_COLORS[optionsArray.length % TAG_COLORS.length];
  optMap.set('color', color);
  optionsArray.push([optMap]);
  return optId;
}

function buildCreateDatabaseDoc(
  title: string,
  columns: Array<{ name: string; type: string; options?: string[] }>,
  rows: Array<{ cells: Record<string, any> }> = [],
  viewMode: 'table' | 'kanban' = 'table'
): { docId: string; binary: Uint8Array } {
  const docId = nanoid();
  const pageId = nanoid();
  const surfaceId = nanoid();
  const noteId = nanoid();
  const databaseId = nanoid();

  const ydoc = new Y.Doc();
  const blocks = ydoc.getMap('blocks');

  // --- Page block ---
  const pageMap = new Y.Map();
  pageMap.set('sys:id', pageId);
  pageMap.set('sys:flavour', 'affine:page');
  pageMap.set('sys:version', 2);
  const pageChildren = new Y.Array();
  pageChildren.insert(0, [surfaceId, noteId]);
  pageMap.set('sys:children', pageChildren);
  pageMap.set('prop:title', new Y.Text(title));
  blocks.set(pageId, pageMap);

  // --- Surface block ---
  const surfaceMap = new Y.Map();
  surfaceMap.set('sys:id', surfaceId);
  surfaceMap.set('sys:flavour', 'affine:surface');
  surfaceMap.set('sys:version', 5);
  surfaceMap.set('sys:children', new Y.Array());
  blocks.set(surfaceId, surfaceMap);

  // --- Note block ---
  const noteMap = new Y.Map();
  noteMap.set('sys:id', noteId);
  noteMap.set('sys:flavour', 'affine:note');
  noteMap.set('sys:version', 1);
  const noteChildren = new Y.Array();
  noteChildren.insert(0, [databaseId]);
  noteMap.set('sys:children', noteChildren);
  noteMap.set('prop:xywh', '[0,0,800,95]');
  noteMap.set('prop:displayMode', 'both');
  blocks.set(noteId, noteMap);

  // --- Columns list ---
  const columnIds: string[] = [];
  const colNameToId: Record<string, string> = {};
  const colNameToCol: Record<string, any> = {};
  const colsArray = new Y.Array();

  // Ensure first column is a title column
  const hasTitleCol = columns.some(c => c.type === 'title');
  const allCols = hasTitleCol
    ? columns
    : [{ name: 'Title', type: 'title' }, ...columns];

  for (const col of allCols) {
    const colId = nanoid();
    columnIds.push(colId);
    colNameToId[col.name] = colId;
    colNameToCol[col.name] = { id: colId, ...col };

    const colMap = new Y.Map();
    colMap.set('id', colId);
    colMap.set('type', col.type);
    colMap.set('name', col.name);

    const dataMap = new Y.Map();
    if (
      (col.type === 'select' || col.type === 'multi-select') &&
      col.options?.length
    ) {
      const optsArray = new Y.Array();
      optsArray.insert(
        0,
        col.options.map((opt, i) => {
          const optMap = new Y.Map();
          optMap.set('id', `opt-${nanoid(6)}`);
          optMap.set('value', opt);
          optMap.set('color', TAG_COLORS[i % TAG_COLORS.length]);
          return optMap;
        })
      );
      dataMap.set('options', optsArray);
    }
    colMap.set('data', dataMap);
    colsArray.push([colMap]);
  }

  // --- Row blocks + cells ---
  const childIds: string[] = [];
  const cellsMap = new Y.Map();

  for (const row of rows) {
    const rowId = nanoid();
    childIds.push(rowId);

    const rowMap = new Y.Map();
    rowMap.set('sys:id', rowId);
    rowMap.set('sys:flavour', 'affine:paragraph');
    rowMap.set('sys:version', 1);
    rowMap.set('sys:children', new Y.Array());
    rowMap.set('prop:type', 'text');

    // Title cell value
    const titleCol = allCols.find(c => c.type === 'title');
    const titleVal = titleCol ? String(row.cells[titleCol.name] || '') : '';
    rowMap.set('prop:text', new Y.Text(titleVal));
    blocks.set(rowId, rowMap);

    // Row cells Map
    const rowCells = new Y.Map();
    for (const [colName, val] of Object.entries(row.cells)) {
      const colInfo = colNameToCol[colName];
      if (!colInfo || colInfo.type === 'title') continue;

      const colId = colInfo.id;
      if (colInfo.type === 'select') {
        const valueStr = String(val);
        const colMap = colsArray
          .toArray()
          .find((c: any) => c.get('id') === colId) as Y.Map<any> | undefined;
        if (colMap) {
          const optId = getOrCreateOptionId(colMap, valueStr);
          rowCells.set(colId, {
            columnId: colId,
            value: optId,
          });
        }
      } else if (colInfo.type === 'multi-select') {
        const arr = Array.isArray(val) ? val : [val];
        const colMap = colsArray
          .toArray()
          .find((c: any) => c.get('id') === colId) as Y.Map<any> | undefined;
        if (colMap) {
          const optIds = arr.map(v => getOrCreateOptionId(colMap, String(v)));
          rowCells.set(colId, {
            columnId: colId,
            value: optIds,
          });
        }
      } else {
        rowCells.set(colId, {
          columnId: colId,
          value: val,
        });
      }
    }
    cellsMap.set(rowId, rowCells);
  }

  // --- Views ---
  const viewsArray = new Y.Array();
  const viewMap = new Y.Map();
  viewMap.set('id', nanoid());
  viewMap.set('name', viewMode === 'kanban' ? 'Kanban View' : 'Table View');
  viewMap.set('mode', viewMode);

  const viewCols = new Y.Array();
  viewCols.insert(
    0,
    columnIds.map(id => {
      const m = new Y.Map();
      m.set('id', id);
      return m;
    })
  );
  viewMap.set('columns', viewCols);

  const filterMap = new Y.Map();
  filterMap.set('type', 'group');
  filterMap.set('op', 'and');
  filterMap.set('conditions', new Y.Array());
  viewMap.set('filter', filterMap);

  if (viewMode === 'kanban') {
    const selectCol = allCols.find(c => c.type === 'select');
    const selectColId = selectCol ? colNameToId[selectCol.name] : null;
    if (selectColId) {
      const groupByMap = new Y.Map();
      groupByMap.set('type', 'groupBy');
      groupByMap.set('columnId', selectColId);
      groupByMap.set('name', 'select');
      viewMap.set('groupBy', groupByMap);
    }
  }

  const headerMap = new Y.Map();
  const titleColInfo = allCols.find(c => c.type === 'title');
  headerMap.set(
    'titleColumn',
    titleColInfo ? colNameToId[titleColInfo.name] : columnIds[0]
  );
  headerMap.set('iconColumn', 'type');
  viewMap.set('header', headerMap);

  viewMap.set('groupProperties', new Y.Array());
  viewsArray.push([viewMap]);

  // --- Database block ---
  const dbMap = new Y.Map();
  dbMap.set('sys:id', databaseId);
  dbMap.set('sys:flavour', 'affine:database');
  dbMap.set('sys:version', 3);
  const dbChildren = new Y.Array();
  dbChildren.insert(0, childIds);
  dbMap.set('sys:children', dbChildren);
  dbMap.set('prop:title', new Y.Text(title));
  dbMap.set('prop:columns', colsArray);
  dbMap.set('prop:cells', cellsMap);
  dbMap.set('prop:views', viewsArray);
  blocks.set(databaseId, dbMap);

  const binary = Y.encodeStateAsUpdate(ydoc);
  return { docId, binary };
}

function buildDatabaseRowUpdate(
  existingBin: Buffer,
  cellsData: Record<string, any>
): { update: Uint8Array; rowId: string } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, existingBin);
  const blocks = doc.getMap('blocks');

  let dbBlock: Y.Map<any> | undefined;
  for (const key of blocks.keys()) {
    const block = blocks.get(key) as Y.Map<any>;
    if (block.get('sys:flavour') === 'affine:database') {
      dbBlock = block;
      break;
    }
  }
  if (!dbBlock) throw new Error('No database block found in document');

  const colsArray = dbBlock.get('prop:columns') as Y.Array<any>;
  const cellsMap = dbBlock.get('prop:cells') as Y.Map<any>;
  const childrenArray = dbBlock.get('sys:children') as Y.Array<string>;

  const cols = colsArray.toJSON();
  const rowId = nanoid();

  doc.transact(() => {
    // 1. Create paragraph block for the row
    const rowMap = new Y.Map();
    rowMap.set('sys:id', rowId);
    rowMap.set('sys:flavour', 'affine:paragraph');
    rowMap.set('sys:version', 1);
    rowMap.set('sys:children', new Y.Array());
    rowMap.set('prop:type', 'text');

    // Title cell value
    const titleCol = cols.find((c: any) => c.type === 'title');
    const titleVal = titleCol ? String(cellsData[titleCol.name] || '') : '';
    rowMap.set('prop:text', new Y.Text(titleVal));
    blocks.set(rowId, rowMap);

    // 2. Add rowId to database block children list
    childrenArray.push([rowId]);

    // 3. Set cell values
    const rowCells = new Y.Map();
    for (const [colName, val] of Object.entries(cellsData)) {
      const colInfo = cols.find((c: any) => c.name === colName);
      if (!colInfo || colInfo.type === 'title') continue;

      const colId = colInfo.id;
      if (colInfo.type === 'select') {
        const valueStr = String(val);
        const colMap = colsArray
          .toArray()
          .find((c: any) => c.get('id') === colId) as Y.Map<any> | undefined;
        if (colMap) {
          const optId = getOrCreateOptionId(colMap, valueStr);
          rowCells.set(colId, {
            columnId: colId,
            value: optId,
          });
        }
      } else if (colInfo.type === 'multi-select') {
        const arr = Array.isArray(val) ? val : [val];
        const colMap = colsArray
          .toArray()
          .find((c: any) => c.get('id') === colId) as Y.Map<any> | undefined;
        if (colMap) {
          const optIds = arr.map(v => getOrCreateOptionId(colMap, String(v)));
          rowCells.set(colId, {
            columnId: colId,
            value: optIds,
          });
        }
      } else {
        rowCells.set(colId, {
          columnId: colId,
          value: val,
        });
      }
    }
    cellsMap.set(rowId, rowCells);
  });

  return { update: Y.encodeStateAsUpdate(doc), rowId };
}

function buildDatabaseViewUpdate(
  existingBin: Buffer,
  viewName: string,
  mode: 'table' | 'kanban' | 'gallery' | 'calendar'
): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, existingBin);
  const blocks = doc.getMap('blocks');

  let dbBlock: Y.Map<any> | undefined;
  for (const key of blocks.keys()) {
    const block = blocks.get(key) as Y.Map<any>;
    if (block.get('sys:flavour') === 'affine:database') {
      dbBlock = block;
      break;
    }
  }
  if (!dbBlock) throw new Error('No database block found in document');

  const viewsArray = dbBlock.get('prop:views') as Y.Array<any>;
  const colsArray = dbBlock.get('prop:columns') as Y.Array<any>;
  const columnIds = colsArray ? colsArray.map(c => c.get('id')) : [];

  doc.transact(() => {
    const viewMap = new Y.Map();
    viewMap.set('id', nanoid());
    viewMap.set('name', viewName);
    viewMap.set('mode', mode);

    const viewCols = new Y.Array();
    viewCols.insert(
      0,
      columnIds.map(id => {
        const m = new Y.Map();
        m.set('id', id);
        return m;
      })
    );
    viewMap.set('columns', viewCols);

    const filterMap = new Y.Map();
    filterMap.set('type', 'group');
    filterMap.set('op', 'and');
    filterMap.set('conditions', new Y.Array());
    viewMap.set('filter', filterMap);

    if (mode === 'kanban') {
      const selectCol = colsArray
        ? colsArray.toArray().find(c => c.get('type') === 'select')
        : null;
      if (selectCol) {
        const groupByMap = new Y.Map();
        groupByMap.set('type', 'groupBy');
        groupByMap.set('columnId', selectCol.get('id'));
        groupByMap.set('name', 'select');
        viewMap.set('groupBy', groupByMap);
      }
    }

    const headerMap = new Y.Map();
    const titleCol = colsArray
      ? colsArray.toArray().find(c => c.get('type') === 'title')
      : null;
    headerMap.set(
      'titleColumn',
      titleCol ? titleCol.get('id') : columnIds[0] || ''
    );
    headerMap.set('iconColumn', 'type');
    viewMap.set('header', headerMap);

    viewMap.set('groupProperties', new Y.Array());
    viewsArray.push([viewMap]);
  });

  return Y.encodeStateAsUpdate(doc);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export const buildDatabaseCreateHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (
    options: CopilotChatOptions,
    title: string,
    columns: Array<{ name: string; type: string; options?: string[] }>,
    rows: Array<{ cells: Record<string, any> }> = [],
    viewMode: 'table' | 'kanban' = 'table'
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Database Create Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.CreateDoc');
    if (!canAccess) {
      return toolError(
        'Database Create Failed',
        'No workspace update permission'
      );
    }

    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError(
        'Database Create Failed',
        'Workspace root doc not found'
      );
    }
    const rootDocBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );

    const { docId, binary } = buildCreateDatabaseDoc(
      title,
      columns,
      rows,
      viewMode
    );

    // Register database doc inside workspace root doc
    const rootDocUpdate = addDocToRootDoc(rootDocBin, docId, title);

    await storage.pushDocUpdates(
      options.workspace,
      options.workspace,
      [rootDocUpdate],
      options.user
    );

    // Push new doc binary
    await storage.pushDocUpdates(
      options.workspace,
      docId,
      [binary],
      options.user
    );

    return {
      success: true,
      docId,
      message: `Database doc '${title}' created successfully`,
    };
  };
};

export const buildDatabaseQueryHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions, docId: string) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Database Query Failed',
        'Missing user or workspace context'
      );
    }
    const canRead = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Read');
    if (!canRead) {
      return toolError(
        'Database Query Failed',
        `No read permission for doc ${docId}`
      );
    }

    const docSnapshot = await storage.getDoc(options.workspace, docId);
    if (!docSnapshot?.bin) {
      return toolError('Database Query Failed', `Doc ID ${docId} not found`);
    }

    const bin = Buffer.isBuffer(docSnapshot.bin)
      ? docSnapshot.bin
      : Buffer.from(
          docSnapshot.bin.buffer,
          docSnapshot.bin.byteOffset,
          docSnapshot.bin.byteLength
        );

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, bin);
    const blocks = ydoc.getMap('blocks');

    let dbBlock: Y.Map<any> | undefined;
    let dbBlockId: string | undefined;
    for (const key of blocks.keys()) {
      const block = blocks.get(key) as Y.Map<any>;
      if (block.get('sys:flavour') === 'affine:database') {
        dbBlock = block;
        dbBlockId = key;
        break;
      }
    }

    if (!dbBlock) {
      return toolError(
        'Database Query Failed',
        'No database block found in document'
      );
    }

    const colsArray = dbBlock.get('prop:columns') as Y.Array<any> | undefined;
    const cellsMap = dbBlock.get('prop:cells') as Y.Map<any> | undefined;
    const childrenArray = dbBlock.get('sys:children') as
      | Y.Array<string>
      | undefined;

    const cols = colsArray ? colsArray.toJSON() : [];
    const cells = cellsMap ? cellsMap.toJSON() : {};
    const rowIds = childrenArray ? childrenArray.toArray() : [];

    const rows = rowIds.map(rowId => {
      const rowBlock = blocks.get(rowId) as Y.Map<any> | undefined;
      const titleText = rowBlock?.get('prop:text');
      const title = titleText ? titleText.toString() : '';

      const rowCells = cells[rowId] || {};
      const rowData: Record<string, any> = { id: rowId };

      for (const col of cols) {
        if (col.type === 'title') {
          rowData[col.name] = title;
        } else {
          const cellData = rowCells[col.id];
          const rawValue = cellData?.value;
          if (rawValue === undefined || rawValue === null) {
            rowData[col.name] = null;
          } else if (col.type === 'select') {
            const opt = col.data?.options?.find((o: any) => o.id === rawValue);
            rowData[col.name] = opt ? opt.value : rawValue;
          } else if (col.type === 'multi-select') {
            const arr = Array.isArray(rawValue) ? rawValue : [];
            rowData[col.name] = arr.map((id: string) => {
              const opt = col.data?.options?.find((o: any) => o.id === id);
              return opt ? opt.value : id;
            });
          } else {
            rowData[col.name] = rawValue;
          }
        }
      }
      return rowData;
    });

    return {
      docId,
      databaseId: dbBlockId,
      columns: cols.map((c: any) => ({ id: c.id, name: c.name, type: c.type })),
      rows,
    };
  };
};

export const buildDatabaseAddRowHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    cells: Record<string, any>
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Database Add Row Failed',
        'Missing user or workspace context'
      );
    }
    const canUpdate = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Update');
    if (!canUpdate) {
      return toolError(
        'Database Add Row Failed',
        `No permission to update doc ${docId}`
      );
    }

    const docSnapshot = await storage.getDoc(options.workspace, docId);
    if (!docSnapshot?.bin) {
      return toolError('Database Add Row Failed', `Doc ID ${docId} not found`);
    }

    const existingBin = Buffer.isBuffer(docSnapshot.bin)
      ? docSnapshot.bin
      : Buffer.from(
          docSnapshot.bin.buffer,
          docSnapshot.bin.byteOffset,
          docSnapshot.bin.byteLength
        );

    try {
      const { update, rowId } = buildDatabaseRowUpdate(existingBin, cells);

      await storage.pushDocUpdates(
        options.workspace,
        docId,
        [update],
        options.user
      );

      return {
        success: true,
        rowId,
        message: 'Successfully added new row to database',
      };
    } catch (err: any) {
      return toolError('Database Add Row Failed', err.message);
    }
  };
};

export const buildDatabaseAddViewHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    name: string,
    mode: 'table' | 'kanban' | 'gallery' | 'calendar'
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Database Add View Failed',
        'Missing user or workspace context'
      );
    }
    const canUpdate = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Update');
    if (!canUpdate) {
      return toolError(
        'Database Add View Failed',
        `No permission to update doc ${docId}`
      );
    }

    const docSnapshot = await storage.getDoc(options.workspace, docId);
    if (!docSnapshot?.bin) {
      return toolError('Database Add View Failed', `Doc ID ${docId} not found`);
    }

    const existingBin = Buffer.isBuffer(docSnapshot.bin)
      ? docSnapshot.bin
      : Buffer.from(
          docSnapshot.bin.buffer,
          docSnapshot.bin.byteOffset,
          docSnapshot.bin.byteLength
        );

    try {
      const update = buildDatabaseViewUpdate(existingBin, name, mode);

      await storage.pushDocUpdates(
        options.workspace,
        docId,
        [update],
        options.user
      );

      return {
        success: true,
        message: `Successfully added view '${name}' (${mode}) to database`,
      };
    } catch (err: any) {
      return toolError('Database Add View Failed', err.message);
    }
  };
};

// ─── Tool Factories ───────────────────────────────────────────────────────────

export const createDatabaseCreateTool = (
  createDb: (
    title: string,
    columns: Array<{ name: string; type: string; options?: string[] }>,
    rows: Array<{ cells: Record<string, any> }>,
    viewMode: 'table' | 'kanban'
  ) => Promise<object>
) =>
  defineTool({
    description:
      'Create a new document with a database block (Grid/Table view by default). Define custom columns (title, rich-text, number, select, multi-select, date, checkbox) and initial row data.',
    inputSchema: z.object({
      title: z.string().describe('The title of the database document'),
      columns: z
        .array(
          z.object({
            name: z.string().describe('Column name'),
            type: z
              .enum([
                'title',
                'rich-text',
                'number',
                'select',
                'multi-select',
                'date',
                'checkbox',
              ])
              .describe('Column data type'),
            options: z
              .array(z.string())
              .optional()
              .describe('Predefined options (only for select/multi-select)'),
          })
        )
        .describe('The schema of the database columns'),
      rows: z
        .array(
          z.object({
            cells: z
              .record(z.any())
              .describe('Key-value pairs mapping column names to cell values'),
          })
        )
        .optional()
        .describe('Initial database rows to insert'),
      view_mode: z
        .enum(['table', 'kanban'])
        .optional()
        .describe('Initial view layout. Default: table'),
    }),
    execute: async ({ title, columns, rows, view_mode }) => {
      try {
        return await createDb(title, columns, rows || [], view_mode || 'table');
      } catch (err: any) {
        logger.error('Failed to create database', err);
        return toolError('Database Create Failed', err.message);
      }
    },
  });

export const createDatabaseQueryTool = (
  queryDb: (docId: string) => Promise<object>
) =>
  defineTool({
    description:
      'Query and list the columns and rows of a database document. Use this to read or search a database/table.',
    inputSchema: z.object({
      doc_id: z
        .string()
        .describe('The ID of the document containing the database'),
    }),
    execute: async ({ doc_id }) => {
      try {
        return await queryDb(doc_id);
      } catch (err: any) {
        logger.error(`Failed to query database ${doc_id}`, err);
        return toolError('Database Query Failed', err.message);
      }
    },
  });

export const createDatabaseAddRowTool = (
  addRow: (docId: string, cells: Record<string, any>) => Promise<object>
) =>
  defineTool({
    description: 'Add a new row of data to an existing database document.',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the database document'),
      cells: z
        .record(z.any())
        .describe(
          'Key-value pairs mapping column names to cell values to insert'
        ),
    }),
    execute: async ({ doc_id, cells }) => {
      try {
        return await addRow(doc_id, cells);
      } catch (err: any) {
        logger.error(`Failed to add row to database ${doc_id}`, err);
        return toolError('Database Add Row Failed', err.message);
      }
    },
  });

export const createDatabaseAddViewTool = (
  addView: (
    docId: string,
    name: string,
    mode: 'table' | 'kanban' | 'gallery' | 'calendar'
  ) => Promise<object>
) =>
  defineTool({
    description:
      'Add a new view (table, kanban, gallery, or calendar) to an existing database.',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the database document'),
      name: z.string().describe('The name of the new view'),
      mode: z
        .enum(['table', 'kanban', 'gallery', 'calendar'])
        .describe('Layout mode for the new view'),
    }),
    execute: async ({ doc_id, name, mode }) => {
      try {
        return await addView(doc_id, name, mode);
      } catch (err: any) {
        logger.error(`Failed to add view to database ${doc_id}`, err);
        return toolError('Database Add View Failed', err.message);
      }
    },
  });
