import test from 'ava';
import sinon from 'sinon';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerBlueprintStoreTools, resetBlueprintStore, setBlueprintStoreDir } from '../src/tools/blueprint-store.js';
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
  return { mockServer, factory };
}

function getExecutor(mockServer: McpServer, toolName: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === toolName);
  return call!.args[3];
}

test('registerBlueprintStoreTools registers save, list, and load', (t) => {
  const { mockServer, factory } = setup();
  registerBlueprintStoreTools(factory);
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  for (const name of ['blueprint-save', 'blueprint-list', 'blueprint-load']) {
    t.true(names.includes(name), `missing ${name}`);
  }
});

test('blueprint store: save, list, load, errors, and disk persistence', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-store-'));
  setBlueprintStoreDir(tmpDir);

  const { mockServer, factory } = setup();
  registerBlueprintStoreTools(factory);
  const save = getExecutor(mockServer, 'blueprint-save');
  const list = getExecutor(mockServer, 'blueprint-list');
  const load = getExecutor(mockServer, 'blueprint-load');

  const empty = await list({});
  t.false(!!empty.isError);
  t.true(empty.content[0].text.includes('No saved blueprints.'));

  const saved = await save({ name: 'house', rows: ['WW', 'W.'], palette: { W: 'oak_planks' } });
  t.false(!!saved.isError);
  t.true(saved.content[0].text.includes('Saved blueprint house (2 rows).'));

  const listed = await list({});
  t.false(!!listed.isError);
  t.true(listed.content[0].text.includes('Saved blueprints:'));
  t.true(listed.content[0].text.includes('- house'));

  const loaded = await load({ name: 'house' });
  t.false(!!loaded.isError);
  const text = loaded.content[0].text;
  t.true(text.includes('Blueprint house:'));
  t.true(text.includes('WW\nW.'));
  t.true(text.includes('Palette: W=oak_planks'));

  const unknown = await load({ name: 'nope' });
  t.true(!!unknown.isError);
  t.true(unknown.content[0].text.includes('No blueprint named nope.'));

  const bad = await save({ name: 'bad', rows: ['WW', 'W'], palette: { W: 'oak_planks' } });
  t.true(!!bad.isError);
  t.true(bad.content[0].text.includes('Blueprint rows must have equal length.'));

  await save({ name: 'tower', rows: ['SSS', 'S.S'], palette: { S: 'stone' } });
  resetBlueprintStore();

  const afterReset = await list({});
  t.true(afterReset.content[0].text.includes('- house'));
  t.true(afterReset.content[0].text.includes('- tower'));

  const fromDisk = await load({ name: 'tower' });
  t.false(!!fromDisk.isError);
  t.true(fromDisk.content[0].text.includes('Blueprint tower:'));
  t.true(fromDisk.content[0].text.includes('SSS\nS.S'));

  setBlueprintStoreDir(undefined);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});