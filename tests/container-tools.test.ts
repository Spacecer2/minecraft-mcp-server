import test from 'ava';
import sinon from 'sinon';
import { registerContainerTools } from '../src/tools/container-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

function makeFactory() {
  const mockServer = { tool: sinon.stub() };
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer as unknown as McpServer, mockManager);
  return { factory, mockServer };
}

function executorFor(mockServer: { tool: sinon.SinonStub }, name: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find((c) => c.args[0] === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return call.args[3];
}

interface FakeContainerWindow {
  items?: sinon.SinonStub;
  containerItems?: sinon.SinonStub;
  deposit: sinon.SinonStub;
  withdraw: sinon.SinonStub;
  close: sinon.SinonStub;
}

function makeFakeContainer(overrides: Partial<FakeContainerWindow> = {}): FakeContainerWindow {
  return {
    items: sinon.stub().returns([]),
    deposit: sinon.stub().resolves(),
    withdraw: sinon.stub().resolves(),
    close: sinon.stub(),
    ...overrides
  };
}

test('registerContainerTools registers all seven tools', (t) => {
  const { factory, mockServer } = makeFactory();
  const getBot = () => ({} as mineflayer.Bot);
  registerContainerTools(factory, getBot);

  const names = (mockServer.tool as sinon.SinonStub).getCalls().map((c) => c.args[0]);
  for (const expected of [
    'find-container',
    'deposit-item',
    'withdraw-item',
    'open-container',
    'organize-inventory',
    'activate-block',
    'use-item-on'
  ]) {
    t.true(names.includes(expected), `expected ${expected} to be registered`);
  }
});

test('find-container returns found position', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBlock = { name: 'chest', type: 177, position: new Vec3(10, 64, 20) };
  const findBlockStub = sinon.stub().returns(mockBlock);
  const mockBot = { version: '1.21', findBlock: findBlockStub } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'find-container')({ type: 'chest', maxDistance: 16 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Found chest at (10, 64, 20)'));
  t.is(findBlockStub.firstCall.args[0].matching, 177);
});

test('find-container returns not found message', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = { version: '1.21', findBlock: sinon.stub().returns(null) } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'find-container')({ type: 'chest', maxDistance: 16 });

  t.true(result.content[0].text.includes('No chest within 16 blocks'));
});

test('find-container falls back to chest for unknown types', async (t) => {
  const { factory, mockServer } = makeFactory();
  const findBlockStub = sinon.stub().returns(null);
  const mockBot = { version: '1.21', findBlock: findBlockStub } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'find-container')({ type: 'vault', maxDistance: 8 });

  t.true(result.content[0].text.includes('No vault within 8 blocks'));
  t.is(findBlockStub.firstCall.args[0].matching, 177);
});

test('deposit-item deposits into a container', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBlock = { name: 'chest', type: 177, position: new Vec3(5, 64, 5) };
  const fakeWindow = makeFakeContainer();
  const openContainerStub = sinon.stub().resolves(fakeWindow);
  const mockBot = {
    version: '1.21',
    findBlock: sinon.stub().returns(mockBlock),
    openContainer: openContainerStub,
    inventory: {
      items: () => [{ name: 'oak_planks', count: 32, slot: 1, type: 5, metadata: 0 }]
    }
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'deposit-item')({ itemName: 'oak_planks', count: 10 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Deposited 10 oak_planks into chest at (5, 64, 5)'));
  t.true(fakeWindow.deposit.calledOnce);
  t.is(fakeWindow.deposit.firstCall.args[0], 5);
  t.is(fakeWindow.deposit.firstCall.args[1], 0);
  t.is(fakeWindow.deposit.firstCall.args[2], 10);
  t.true(fakeWindow.close.calledOnce);
});

test('deposit-item caps deposit at available inventory count', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBlock = { name: 'chest', type: 177, position: new Vec3(5, 64, 5) };
  const fakeWindow = makeFakeContainer();
  const mockBot = {
    version: '1.21',
    findBlock: sinon.stub().returns(mockBlock),
    openContainer: sinon.stub().resolves(fakeWindow),
    inventory: {
      items: () => [{ name: 'oak_planks', count: 3, slot: 1, type: 5, metadata: 0 }]
    }
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'deposit-item')({ itemName: 'oak_planks', count: 10 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Deposited 3 oak_planks'));
  t.is(fakeWindow.deposit.firstCall.args[2], 3);
});

test('deposit-item errors when item is not in inventory', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    version: '1.21',
    findBlock: sinon.stub(),
    openContainer: sinon.stub(),
    inventory: { items: () => [] }
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'deposit-item')({ itemName: 'diamond' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes("is not in the bot's inventory"));
  t.false((mockBot.openContainer as sinon.SinonStub).called);
});

test('deposit-item errors when no container is found', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    version: '1.21',
    findBlock: sinon.stub().returns(null),
    openContainer: sinon.stub(),
    inventory: {
      items: () => [{ name: 'oak_planks', count: 32, slot: 1, type: 5, metadata: 0 }]
    }
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'deposit-item')({ itemName: 'oak_planks' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No chest container found nearby'));
  t.false((mockBot.openContainer as sinon.SinonStub).called);
});

test('withdraw-item withdraws from a container', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBlock = { name: 'chest', type: 177, position: new Vec3(8, 64, 9) };
  const fakeWindow = makeFakeContainer({
    containerItems: sinon.stub().returns([{ name: 'cobblestone', count: 64, slot: 0, type: 4, metadata: 0 }])
  });
  const mockBot = {
    version: '1.21',
    findBlock: sinon.stub().returns(mockBlock),
    openContainer: sinon.stub().resolves(fakeWindow),
    inventory: { items: () => [] }
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'withdraw-item')({ itemName: 'cobblestone', count: 5 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Withdrew 5 cobblestone from chest at (8, 64, 9)'));
  t.true(fakeWindow.withdraw.calledOnce);
  t.is(fakeWindow.withdraw.firstCall.args[2], 5);
  t.true(fakeWindow.close.calledOnce);
});

test('withdraw-item errors when the item is not in the container', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBlock = { name: 'chest', type: 177, position: new Vec3(8, 64, 9) };
  const fakeWindow = makeFakeContainer({
    containerItems: sinon.stub().returns([{ name: 'cobblestone', count: 64, slot: 0, type: 4, metadata: 0 }])
  });
  const mockBot = {
    version: '1.21',
    findBlock: sinon.stub().returns(mockBlock),
    openContainer: sinon.stub().resolves(fakeWindow),
    inventory: { items: () => [] }
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'withdraw-item')({ itemName: 'diamond' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes("not found in chest container"));
  t.false(fakeWindow.withdraw.called);
});

test('open-container lists contents at explicit coordinates', async (t) => {
  const { factory, mockServer } = makeFactory();
  const fakeWindow = makeFakeContainer({
    containerItems: sinon.stub().returns([
      { name: 'oak_planks', count: 32, slot: 0, type: 5, metadata: 0 },
      { name: 'cobblestone', count: 64, slot: 1, type: 4, metadata: 0 }
    ])
  });
  const mockBot = {
    version: '1.21',
    blockAt: sinon.stub().returns({ name: 'chest', type: 177, position: new Vec3(3, 64, 7) }),
    openContainer: sinon.stub().resolves(fakeWindow),
    findBlock: sinon.stub()
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'open-container')({ x: 3, y: 64, z: 7 });

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Container chest at (3, 64, 7):'));
  t.true(text.includes('- oak_planks x32'));
  t.true(text.includes('- cobblestone x64'));
  t.true(fakeWindow.close.calledOnce);
});

test('open-container reports an empty container', async (t) => {
  const { factory, mockServer } = makeFactory();
  const fakeWindow = makeFakeContainer({ containerItems: sinon.stub().returns([]) });
  const mockBot = {
    version: '1.21',
    blockAt: sinon.stub().returns({ name: 'chest', type: 177, position: new Vec3(3, 64, 7) }),
    openContainer: sinon.stub().resolves(fakeWindow),
    findBlock: sinon.stub()
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'open-container')({ x: 3, y: 64, z: 7 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Container chest at (3, 64, 7) is empty'));
});

test('open-container falls back to nearest container when no coordinates given', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBlock = { name: 'barrel', type: 774, position: new Vec3(2, 64, 2) };
  const fakeWindow = makeFakeContainer({ containerItems: sinon.stub().returns([]) });
  const findBlockStub = sinon.stub().returns(mockBlock);
  const mockBot = {
    version: '1.21',
    blockAt: sinon.stub().returns({ name: 'air' }),
    findBlock: findBlockStub,
    openContainer: sinon.stub().resolves(fakeWindow)
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'open-container')({ containerType: 'barrel' });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Container barrel at (2, 64, 2) is empty'));
  t.is(findBlockStub.firstCall.args[0].matching, 774);
});

test('organize-inventory consolidates duplicate stacks', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    inventory: {
      items: () => [
        { name: 'oak_planks', count: 32, slot: 0, type: 5, metadata: 0 },
        { name: 'oak_planks', count: 16, slot: 1, type: 5, metadata: 0 },
        { name: 'cobblestone', count: 64, slot: 2, type: 4, metadata: 0 }
      ]
    }
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'organize-inventory')({});

  t.false(!!result.isError);
  const text = result.content[0].text;
  t.true(text.includes('Inventory (3 stacks, 2 distinct):'));
  t.true(text.includes('- cobblestone: 64'));
  t.true(text.includes('- oak_planks: 48'));
});

test('organize-inventory reports empty inventory', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = { inventory: { items: () => [] } } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'organize-inventory')({});

  t.true(result.content[0].text.includes('Inventory is empty'));
});

test('activate-block activates a button', async (t) => {
  const { factory, mockServer } = makeFactory();
  const activateBlockStub = sinon.stub().resolves();
  const mockBot = {
    blockAt: sinon.stub().returns({ name: 'stone_button', type: 246, position: new Vec3(1, 64, 1) }),
    activateBlock: activateBlockStub
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'activate-block')({ x: 1, y: 64, z: 1 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Activated stone_button at (1, 64, 1)'));
  t.true(activateBlockStub.calledOnce);
});

test('activate-block errors for a missing block', async (t) => {
  const { factory, mockServer } = makeFactory();
  const activateBlockStub = sinon.stub();
  const mockBot = {
    blockAt: sinon.stub().returns(null),
    activateBlock: activateBlockStub
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'activate-block')({ x: 1, y: 64, z: 1 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No block found at (1, 64, 1)'));
  t.false(activateBlockStub.called);
});

test('activate-block errors for a non-activatable block', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    blockAt: sinon.stub().returns({ name: 'bedrock', type: 7, position: new Vec3(1, 64, 1) }),
    activateBlock: sinon.stub().rejects(new Error('cannot activate'))
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'activate-block')({ x: 1, y: 64, z: 1 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('not activatable'));
  t.true(result.content[0].text.includes('cannot activate'));
});

test('use-item-on reports the held item when no target is given', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    heldItem: { name: 'diamond_pickaxe' },
    inventory: { items: () => [] },
    equip: sinon.stub(),
    activateBlock: sinon.stub(),
    nearestEntity: sinon.stub(),
    useOn: sinon.stub()
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'use-item-on')({});

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Held item: diamond_pickaxe'));
  t.false((mockBot.activateBlock as sinon.SinonStub).called);
  t.false((mockBot.useOn as sinon.SinonStub).called);
});

test('use-item-on uses the item on a block at coordinates', async (t) => {
  const { factory, mockServer } = makeFactory();
  const activateBlockStub = sinon.stub().resolves();
  const mockBot = {
    heldItem: { name: 'bone_meal' },
    inventory: { items: () => [] },
    equip: sinon.stub(),
    blockAt: sinon.stub().returns({ name: 'wheat', type: 59, position: new Vec3(2, 63, 2) }),
    activateBlock: activateBlockStub,
    nearestEntity: sinon.stub(),
    useOn: sinon.stub()
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'use-item-on')({ itemName: 'bone_meal', x: 2, y: 63, z: 2 });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Used bone_meal on wheat at (2, 63, 2)'));
  t.true(activateBlockStub.calledOnce);
});

test('use-item-on uses the item on an entity', async (t) => {
  const { factory, mockServer } = makeFactory();
  const useOnStub = sinon.stub();
  const mockEntity = { name: 'cow', type: 'mob', mobType: 'Cow', position: new Vec3(3, 64, 3) };
  const mockBot = {
    heldItem: { name: 'wheat' },
    inventory: { items: () => [] },
    equip: sinon.stub(),
    nearestEntity: sinon.stub().returns(mockEntity),
    useOn: useOnStub,
    activateBlock: sinon.stub()
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'use-item-on')({ itemName: 'wheat', entityType: 'cow' });

  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Used wheat on cow'));
  t.true(useOnStub.calledOnce);
  t.is(useOnStub.firstCall.args[0], mockEntity);
});

test('use-item-on errors when no matching entity is found', async (t) => {
  const { factory, mockServer } = makeFactory();
  const mockBot = {
    heldItem: { name: 'wheat' },
    inventory: { items: () => [] },
    equip: sinon.stub(),
    nearestEntity: sinon.stub().returns(null),
    useOn: sinon.stub(),
    activateBlock: sinon.stub()
  } as unknown as mineflayer.Bot;
  registerContainerTools(factory, () => mockBot);

  const result = await executorFor(mockServer, 'use-item-on')({ entityType: 'cow' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No cow entity found nearby'));
  t.false((mockBot.useOn as sinon.SinonStub).called);
});
