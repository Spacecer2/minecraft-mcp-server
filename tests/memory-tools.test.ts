import test from 'ava';
import sinon from 'sinon';
import { registerMemoryTools, resetMemoryStore } from '../src/tools/memory-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

function setup() {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  registerMemoryTools(factory);
  resetMemoryStore();
  return { mockServer, factory };
}

function getExecutor(mockServer: McpServer, toolName: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === toolName);
  return call!.args[3];
}

test.serial('registerMemoryTools registers all six memory tools', (t) => {
  const { mockServer } = setup();
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  for (const name of ['remember', 'recall', 'forget', 'add-task', 'list-tasks', 'update-task']) {
    t.true(names.includes(name), `missing ${name}`);
  }
});

test.serial('remember stores a value and recall returns it', async (t) => {
  const { mockServer } = setup();
  const remember = getExecutor(mockServer, 'remember');
  const recall = getExecutor(mockServer, 'recall');

  const stored = await remember({ key: 'stage', value: 'foundation' });
  t.false(!!stored.isError);
  t.true(stored.content[0].text.includes('Remembered stage = foundation'));

  const result = await recall({ key: 'stage' });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'Value: foundation');
});

test.serial('recall reports a missing key', async (t) => {
  const { mockServer } = setup();
  const recall = getExecutor(mockServer, 'recall');
  const result = await recall({ key: 'nope' });
  t.false(!!result.isError);
  t.is(result.content[0].text, 'No value stored for nope');
});

test.serial('recall with no key lists all remembered entries', async (t) => {
  const { mockServer } = setup();
  const remember = getExecutor(mockServer, 'remember');
  const recall = getExecutor(mockServer, 'recall');

  await remember({ key: 'spawn', value: '0 64 0' });
  await remember({ key: 'plan', value: 'walls then roof' });

  const result = await recall({});
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('spawn = 0 64 0'));
  t.true(result.content[0].text.includes('plan = walls then roof'));
});

test.serial('recall with no key reports nothing remembered when empty', async (t) => {
  const { mockServer } = setup();
  const recall = getExecutor(mockServer, 'recall');
  const result = await recall({});
  t.false(!!result.isError);
  t.is(result.content[0].text, 'Nothing remembered');
});

test.serial('remember overwrites an existing key', async (t) => {
  const { mockServer } = setup();
  const remember = getExecutor(mockServer, 'remember');
  const recall = getExecutor(mockServer, 'recall');

  await remember({ key: 'k', value: 'first' });
  await remember({ key: 'k', value: 'second' });

  const result = await recall({ key: 'k' });
  t.is(result.content[0].text, 'Value: second');
});

test.serial('forget removes a single key', async (t) => {
  const { mockServer } = setup();
  const remember = getExecutor(mockServer, 'remember');
  const recall = getExecutor(mockServer, 'recall');
  const forget = getExecutor(mockServer, 'forget');

  await remember({ key: 'k', value: 'v' });
  const forgot = await forget({ key: 'k' });
  t.false(!!forgot.isError);
  t.true(forgot.content[0].text.includes('Forgot k'));

  const result = await recall({ key: 'k' });
  t.is(result.content[0].text, 'No value stored for k');
});

test.serial('forget with no key clears everything', async (t) => {
  const { mockServer } = setup();
  const remember = getExecutor(mockServer, 'remember');
  const recall = getExecutor(mockServer, 'recall');
  const forget = getExecutor(mockServer, 'forget');

  await remember({ key: 'k', value: 'v' });
  const cleared = await forget({});
  t.false(!!cleared.isError);
  t.true(cleared.content[0].text.includes('Cleared all remembered values'));

  const result = await recall({});
  t.is(result.content[0].text, 'Nothing remembered');
});

test.serial('add-task appends a task and returns its id', async (t) => {
  const { mockServer } = setup();
  const addTask = getExecutor(mockServer, 'add-task');

  const result = await addTask({ description: 'Build walls' });
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Added task 0: Build walls [pending]'));
});

test.serial('add-task accepts a custom status', async (t) => {
  const { mockServer } = setup();
  const addTask = getExecutor(mockServer, 'add-task');

  const result = await addTask({ description: 'Collect stone', status: 'in-progress' });
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('[in-progress]'));
});

test.serial('list-tasks returns a numbered task list with status', async (t) => {
  const { mockServer } = setup();
  const addTask = getExecutor(mockServer, 'add-task');
  const listTasks = getExecutor(mockServer, 'list-tasks');

  await addTask({ description: 'Lay foundation' });
  await addTask({ description: 'Frame walls' });

  const result = await listTasks({});
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('1. [pending] Lay foundation'));
  t.true(result.content[0].text.includes('2. [pending] Frame walls'));
});

test.serial('list-tasks filters by status', async (t) => {
  const { mockServer } = setup();
  const addTask = getExecutor(mockServer, 'add-task');
  const updateTask = getExecutor(mockServer, 'update-task');
  const listTasks = getExecutor(mockServer, 'list-tasks');

  await addTask({ description: 'A' });
  await addTask({ description: 'B' });
  await updateTask({ id: 1, status: 'done' });

  const result = await listTasks({ status: 'done' });
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('2. [done] B'));
  t.false(result.content[0].text.includes('1. [pending] A'));
});

test.serial('list-tasks reports no tasks when empty', async (t) => {
  const { mockServer } = setup();
  const listTasks = getExecutor(mockServer, 'list-tasks');
  const result = await listTasks({});
  t.false(!!result.isError);
  t.is(result.content[0].text, 'No tasks');
});

test.serial('update-task changes status and appends a note', async (t) => {
  const { mockServer } = setup();
  const addTask = getExecutor(mockServer, 'add-task');
  const updateTask = getExecutor(mockServer, 'update-task');
  const listTasks = getExecutor(mockServer, 'list-tasks');

  await addTask({ description: 'Build roof' });
  const updated = await updateTask({ id: 0, status: 'done', note: 'finished at dusk' });
  t.false(!!updated.isError);
  t.true(updated.content[0].text.includes('Updated task 0 status to done'));

  const result = await listTasks({});
  t.true(result.content[0].text.includes('1. [done] Build roof'));
  t.true(result.content[0].text.includes('(note: finished at dusk)'));
});

test.serial('update-task reports an unknown task id', async (t) => {
  const { mockServer } = setup();
  const updateTask = getExecutor(mockServer, 'update-task');

  const result = await updateTask({ id: 42, status: 'done' });
  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Task 42 not found'));
});
