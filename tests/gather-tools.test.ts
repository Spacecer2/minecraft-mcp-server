import test from 'ava';
import sinon from 'sinon';
import minecraftData from 'minecraft-data';
import { registerGatherTools } from '../src/tools/gather-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

type Executor = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function setup(bot: Partial<mineflayer.Bot>) {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  registerGatherTools(factory, () => bot as mineflayer.Bot);
  const getExecutor = (name: string): Executor => {
    const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
    const call = toolCalls.find((c) => c.args[0] === name);
    return call!.args[3] as Executor;
  };
  const getDescription = (name: string): string => {
    const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
    const call = toolCalls.find((c) => c.args[0] === name);
    return call!.args[1] as string;
  };
  return { factory, getExecutor, getDescription };
}

function baseBot(overrides: Record<string, unknown> = {}): Partial<mineflayer.Bot> {
  return {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlock: sinon.stub().returns(null),
    inventory: { items: sinon.stub().returns([]) },
    dig: sinon.stub().resolves(),
    pathfinder: { goto: sinon.stub().resolves() },
    ...overrides
  } as unknown as Partial<mineflayer.Bot>;
}

test.serial('registerGatherTools registers collect-item tool', (t) => {
  const { getDescription } = setup(baseBot({}));
  t.is(getDescription('collect-item'), 'Gather a raw material from the world by finding and digging its source blocks');
});

test.serial('registerGatherTools registers gather-loop tool', (t) => {
  const { getDescription } = setup(baseBot({}));
  t.is(getDescription('gather-loop'), 'Gather a raw material from the world until the target count is reached or attempts run out');
});

test.serial('registerGatherTools registers resource-ledger tool', (t) => {
  const { getDescription } = setup(baseBot({}));
  t.is(getDescription('resource-ledger'), 'Track raw materials collected this session to know your material supply before building');
});

test.serial('collect-item digs a source block and reports target count', async (t) => {
  let dug = false;
  const mockBlock = { name: 'stone', position: new Vec3(10, 64, 20) };
  const findBlockStub = sinon.stub().returns(mockBlock);
  const digStub = sinon.stub().callsFake(async () => { dug = true; });
  const inventoryStub = sinon.stub().callsFake(() =>
    dug ? [{ name: 'cobblestone', count: 3, slot: 1 }] : []
  );
  const gotoStub = sinon.stub().resolves();

  const { getExecutor } = setup(baseBot({
    findBlock: findBlockStub,
    inventory: { items: inventoryStub },
    dig: digStub,
    pathfinder: { goto: gotoStub }
  }));

  const result = await getExecutor('collect-item')({ itemName: 'cobblestone', count: 3, maxAttempts: 5 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Collected 3/3 cobblestone after 1 digs'));
  t.true(findBlockStub.calledOnce);
  t.is(findBlockStub.firstCall.args[0].matching, minecraftData('1.21').blocksByName.stone.id);
  t.is(findBlockStub.firstCall.args[0].maxDistance, 24);
  t.true(gotoStub.calledOnce);
  t.true(digStub.calledOnce);
});

test.serial('collect-item errors for an item with no known source block', async (t) => {
  const { getExecutor } = setup(baseBot({}));
  const result = await getExecutor('collect-item')({ itemName: 'netherite_ingot', count: 1 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No known source block for netherite_ingot.'));
});

test.serial('collect-item stops when no source block is found nearby', async (t) => {
  const findBlockStub = sinon.stub().returns(null);
  const digStub = sinon.stub().resolves();
  const gotoStub = sinon.stub().resolves();

  const { getExecutor } = setup(baseBot({
    findBlock: findBlockStub,
    dig: digStub,
    pathfinder: { goto: gotoStub }
  }));

  const result = await getExecutor('collect-item')({ itemName: 'cobblestone', count: 3, maxAttempts: 5 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Stopped: reached 0/3 after 5 attempts (no more cobblestone nearby).'));
  t.false(digStub.called);
});

test.serial('resource-ledger records collected items', async (t) => {
  const { getExecutor } = setup(baseBot({}));

  await getExecutor('resource-ledger')({ reset: true });

  let dug = false;
  const findBlockStub = sinon.stub().returns({ name: 'stone', position: new Vec3(10, 64, 20) });
  const digStub = sinon.stub().callsFake(async () => { dug = true; });
  const inventoryStub = sinon.stub().callsFake(() =>
    dug ? [{ name: 'cobblestone', count: 2, slot: 1 }] : []
  );

  const bot = baseBot({
    findBlock: findBlockStub,
    inventory: { items: inventoryStub },
    dig: digStub
  });
  const { getExecutor: getExecutor2 } = setup(bot);
  await getExecutor2('collect-item')({ itemName: 'cobblestone', count: 2, maxAttempts: 5 });

  const ledgerResult = await getExecutor2('resource-ledger')({ itemName: 'cobblestone' });
  t.true(ledgerResult.content[0].text.includes('Ledger cobblestone: 2'));
});

test.serial('resource-ledger returns zero for an item never collected', async (t) => {
  const { getExecutor } = setup(baseBot({}));
  await getExecutor('resource-ledger')({ reset: true });

  const result = await getExecutor('resource-ledger')({ itemName: 'wood' });
  t.true(result.content[0].text.includes('Ledger wood: 0'));
});

test.serial('resource-ledger lists all entries', async (t) => {
  let digs = 0;
  const inventoryStub = sinon.stub().callsFake(() => {
    if (digs === 0) return [];
    if (digs === 1) return [{ name: 'cobblestone', count: 2, slot: 1 }];
    return [
      { name: 'cobblestone', count: 2, slot: 1 },
      { name: 'oak_log', count: 1, slot: 2 }
    ];
  });
  const digStub = sinon.stub().callsFake(async () => { digs += 1; });

  const { getExecutor } = setup(baseBot({
    findBlock: sinon.stub().returns({ name: 'stone', position: new Vec3(10, 64, 20) }),
    inventory: { items: inventoryStub },
    dig: digStub
  }));

  await getExecutor('resource-ledger')({ reset: true });
  await getExecutor('collect-item')({ itemName: 'cobblestone', count: 2, maxAttempts: 5 });
  await getExecutor('collect-item')({ itemName: 'wood', count: 1, maxAttempts: 5 });

  const result = await getExecutor('resource-ledger')({});
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('cobblestone: 2'));
  t.true(result.content[0].text.includes('wood: 1'));
});

test.serial('resource-ledger reset clears all entries', async (t) => {
  let dug = false;
  const inventoryStub = sinon.stub().callsFake(() =>
    dug ? [{ name: 'cobblestone', count: 2, slot: 1 }] : []
  );
  const digStub = sinon.stub().callsFake(async () => { dug = true; });

  const { getExecutor } = setup(baseBot({
    findBlock: sinon.stub().returns({ name: 'stone', position: new Vec3(10, 64, 20) }),
    inventory: { items: inventoryStub },
    dig: digStub
  }));

  await getExecutor('resource-ledger')({ reset: true });
  await getExecutor('collect-item')({ itemName: 'cobblestone', count: 2, maxAttempts: 5 });

  const cleared = await getExecutor('resource-ledger')({ reset: true });
  t.true(cleared.content[0].text.includes('Ledger cleared.'));

  const after = await getExecutor('resource-ledger')({ itemName: 'cobblestone' });
  t.true(after.content[0].text.includes('Ledger cobblestone: 0'));
});

test.serial('resource-ledger reports empty when nothing collected', async (t) => {
  const { getExecutor } = setup(baseBot({}));
  await getExecutor('resource-ledger')({ reset: true });

  const result = await getExecutor('resource-ledger')({});
  t.true(result.content[0].text.includes('Ledger empty'));
});

test.serial('gather-loop gathers logs until target count', async (t) => {
  let dug = false;
  const findBlockStub = sinon.stub().returns({ name: 'oak_log', position: new Vec3(5, 64, 8) });
  const digStub = sinon.stub().callsFake(async () => { dug = true; });
  const inventoryStub = sinon.stub().callsFake(() =>
    dug ? [{ name: 'oak_log', count: 2, slot: 1 }] : []
  );

  const { getExecutor } = setup(baseBot({
    findBlock: findBlockStub,
    inventory: { items: inventoryStub },
    dig: digStub
  }));

  const result = await getExecutor('gather-loop')({ itemName: 'wood', count: 2, maxAttempts: 5 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Gathered 2/2 wood.'));
  t.true(findBlockStub.calledOnce);
  t.true(digStub.calledOnce);
});

test.serial('gather-loop errors for an item with no known source block', async (t) => {
  const { getExecutor } = setup(baseBot({}));
  const result = await getExecutor('gather-loop')({ itemName: 'bedrock', count: 1 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No known source block for bedrock.'));
});
