import test from 'ava';
import * as Y from 'yjs';
import { WorkspaceMcpProvider } from './provider';

// Helper to construct a test doc binary with a Kanban board
function createTestKanbanBin(): Uint8Array {
  const doc = new Y.Doc();
  const blocks = doc.getMap('blocks');

  // Create the database block
  const dbBlock = new Y.Map();
  dbBlock.set('sys:flavour', 'affine:database');

  // Columns: Status column with options
  const columnsArr = new Y.Array();
  const statusCol = new Y.Map();
  statusCol.set('id', 'col-status');
  statusCol.set('name', 'Status');
  const statusData = new Y.Map();
  const statusOpts = new Y.Array();

  const optTodo = new Y.Map();
  optTodo.set('id', 'opt-todo');
  optTodo.set('value', 'Todo');
  statusOpts.push([optTodo]);

  const optDoing = new Y.Map();
  optDoing.set('id', 'opt-doing');
  optDoing.set('value', 'Doing');
  statusOpts.push([optDoing]);

  statusData.set('options', statusOpts);
  statusCol.set('data', statusData);
  columnsArr.push([statusCol]);
  dbBlock.set('prop:columns', columnsArr);

  // Children: one task row
  const childrenArr = new Y.Array();
  childrenArr.push(['task-1']);
  dbBlock.set('sys:children', childrenArr);

  // Cells
  const cellsMap = new Y.Map();
  const rowCells = new Y.Map();
  rowCells.set('col-status', { value: [{ value: 'Todo' }] });
  cellsMap.set('task-1', rowCells);
  dbBlock.set('prop:cells', cellsMap);

  // Add row block
  const rowBlock = new Y.Map();
  const textObj = new Y.Text('Implement feature X');
  rowBlock.set('prop:text', textObj);

  blocks.set('db-1', dbBlock);
  blocks.set('task-1', rowBlock);

  return Y.encodeStateAsUpdate(doc);
}

test('WorkspaceMcpProvider - list_kanban_tasks should list tasks with their status', async t => {
  const bin = createTestKanbanBin();

  const mockAc = {
    user: () => ({
      workspace: () => ({
        assert: async () => {},
        doc: () => ({
          can: async () => true,
        }),
      }),
    }),
  } as any;

  const mockReader = {
    getDoc: async () => {
      return { bin };
    },
  } as any;

  const provider = new WorkspaceMcpProvider(
    mockAc,
    mockReader,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );

  const server = await provider.for('user-1', 'ws-1');
  const tool = server.tools.find(t => t.name === 'list_kanban_tasks');
  t.truthy(tool);

  const result = await tool!.execute(
    { docId: 'doc-1' },
    { signal: new AbortController().signal }
  );
  t.falsy(result.isError);

  const tasks = JSON.parse(result.content[0].text);
  t.deepEqual(tasks, [
    {
      id: 'task-1',
      title: 'Implement feature X',
      status: 'Todo',
    },
  ]);
});

test('WorkspaceMcpProvider - update_kanban_task_status should update status of a task', async t => {
  const bin = createTestKanbanBin();
  let pushedUpdates: Uint8Array[] = [];

  const mockAc = {
    user: () => ({
      workspace: () => ({
        assert: async () => {},
        doc: () => ({
          can: async () => true,
        }),
      }),
    }),
  } as any;

  const mockReader = {
    getDoc: async () => {
      return { bin };
    },
  } as any;

  const mockWorkspaceStorage = {
    pushDocUpdates: async (
      wsId: string,
      docId: string,
      updates: Uint8Array[]
    ) => {
      pushedUpdates = updates;
      return new Date();
    },
  } as any;

  const mockWriter = {
    emitDocUpdatesPushed: () => {},
  } as any;

  const provider = new WorkspaceMcpProvider(
    mockAc,
    mockReader,
    mockWriter,
    {} as any,
    {} as any,
    {} as any,
    mockWorkspaceStorage
  );

  const server = await provider.for('user-1', 'ws-1');
  const tool = server.tools.find(t => t.name === 'update_kanban_task_status');
  t.truthy(tool);

  const result = await tool!.execute(
    { docId: 'doc-1', taskId: 'task-1', status: 'Doing' },
    { signal: new AbortController().signal }
  );
  t.falsy(result.isError);

  const response = JSON.parse(result.content[0].text);
  t.is(response.success, true);
  t.is(response.taskId, 'task-1');
  t.is(response.status, 'Doing');

  // Verify that the pushed update actually has the status changed
  t.is(pushedUpdates.length, 1);
  const updatedDoc = new Y.Doc();
  Y.applyUpdate(updatedDoc, pushedUpdates[0]);

  const blocks = updatedDoc.getMap('blocks');
  const dbBlock = blocks.get('db-1') as Y.Map<any>;
  t.truthy(dbBlock);

  const cellsMap = dbBlock.get('prop:cells') as Y.Map<any>;
  const rowCells = cellsMap.get('task-1') as Y.Map<any>;
  t.truthy(rowCells);

  const statusCell = rowCells.get('col-status');
  t.is(statusCell.value[0].value, 'Doing');
});
