import test from 'ava';
import sinon from 'sinon';
import {
  registerTemplateTools,
  generateTemplate,
  getTemplateNames,
  TEMPLATE_DEFAULTS,
  countNonAir,
  resolvePalette
} from '../src/tools/template-registry.js';
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
  registerTemplateTools(factory);
  return { mockServer, factory };
}

function getExecutor(mockServer: McpServer, toolName: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === toolName);
  return call!.args[3];
}

test('registerTemplateTools registers load-template and list-templates', (t) => {
  const { mockServer } = setup();
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  for (const name of ['load-template', 'list-templates']) {
    t.true(names.includes(name), `missing ${name}`);
  }
});

test('generated layouts have the correct footprint dimensions', (t) => {
  for (const name of getTemplateNames()) {
    const def = TEMPLATE_DEFAULTS[name];
    const layout = generateTemplate(name, {});
    t.is(layout.footprint.w, def.w, `${name} width`);
    t.is(layout.footprint.d, def.d, `${name} depth`);
    for (const layer of layout.layers) {
      t.is(layer.length, def.d, `${name} layer row count`);
      for (const row of layer) {
        t.is(row.length, def.w, `${name} row width`);
      }
    }
  }
});

test('every template has a positive block count', (t) => {
  for (const name of getTemplateNames()) {
    const layout = generateTemplate(name, {});
    const count = countNonAir(layout, resolvePalette());
    t.true(count > 0, `${name} should have blocks`);
  }
});

for (const name of getTemplateNames()) {
  test.serial(`load-template returns a blueprint for ${name}`, async (t) => {
    const { mockServer } = setup();
    const load = getExecutor(mockServer, 'load-template');

    const result = await load({ name });
    t.false(!!result.isError, `load-template failed for ${name}`);

    const text = result.content[0].text;
    const def = TEMPLATE_DEFAULTS[name];
    const layout = generateTemplate(name, {});
    t.true(text.includes(`footprint ${def.w}x${layout.layers.length}x${def.d}`), `${name} footprint line`);

    const match = text.match(/Block count: (\d+)/);
    t.truthy(match, `${name} block count present`);
    t.true(parseInt(match![1], 10) > 0, `${name} positive block count`);
  });
}

test.serial('load-template reports an unknown template', async (t) => {
  const { mockServer } = setup();
  const load = getExecutor(mockServer, 'load-template');

  const result = await load({ name: 'castle' });
  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Unknown template castle. Use list-templates.'));
});

test.serial('load-template honours a custom palette', async (t) => {
  const { mockServer } = setup();
  const load = getExecutor(mockServer, 'load-template');

  const result = await load({ name: 'shed', palette: { wall: 'stone', roof: 'cobblestone' } });
  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('stone'));
  t.true(text.includes('cobblestone'));
});

test.serial('load-template honours custom dimensions', async (t) => {
  const { mockServer } = setup();
  const load = getExecutor(mockServer, 'load-template');

  const result = await load({ name: 'bridge', w: 3, d: 12 });
  t.false(!!result.isError);
  const text = result.content[0].text;
  const match = text.match(/footprint 3x\d+x12/);
  t.truthy(match, `bridge depth should be 12`);
});

test.serial('list-templates returns the template names', async (t) => {
  const { mockServer } = setup();
  const list = getExecutor(mockServer, 'list-templates');

  const result = await list({});
  t.false(!!result.isError);
  const text = result.content[0].text;
  for (const name of getTemplateNames()) {
    const def = TEMPLATE_DEFAULTS[name];
    t.true(text.includes(`${name} (${def.w}x${def.d})`), `missing ${name}`);
  }
});
