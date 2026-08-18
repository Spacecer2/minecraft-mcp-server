import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'events';
import { registerFarmingTools } from '../src/tools/farming-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';

interface Setup {
  factory: ToolFactory;
  mockServer: McpServer;
  getBot: () => mineflayer.Bot;
}

const createMockItem = (fields: {
  name: string;
  count: number;
  type: number;
  metadata: number;
  slot?: number;
}): Item => fields as unknown as Item;

function setupFactory(mockBot: object): Setup {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const mockManager = {
    getPrimaryName: sinon.stub().returns('primary'),
    getConnection: sinon.stub().returns(mockConnection)
  };
  const factory = new ToolFactory(mockServer, mockManager);
  const getBot = () => mockBot as mineflayer.Bot;
  registerFarmingTools(factory, getBot);
  return { factory, mockServer, getBot };
}

function executorFor(mockServer: McpServer, toolName: string) {
  const stub = (mockServer as unknown as { tool: sinon.SinonStub }).tool;
  const call = stub.getCalls().find((c) => c.args[0] === toolName);
  return call!.args[3];
}

test('registerFarmingTools registers all five farming tools', (t) => {
  const { mockServer } = setupFactory({});
  const stub = (mockServer as unknown as { tool: sinon.SinonStub }).tool;
  const names = stub.getCalls().map((c) => c.args[0]);
  for (const expected of ['plant-crop', 'harvest-crop', 'feed-animal', 'cook-food', 'sleep']) {
    t.true(names.includes(expected), `${expected} should be registered`);
  }
});

test('plant-crop plants a crop and verifies the block is present', async (t) => {
  const target = new Vec3(5, 64, 5);
  const reference = new Vec3(5, 63, 5);
  let placed = false;
  const blockAtStub = sinon.stub().callsFake((pos: Vec3) => {
    if (pos.equals(target)) {
      return placed ? { name: 'wheat', position: target } : { name: 'air', position: target };
    }
    if (pos.equals(reference)) return { name: 'farmland', position: reference };
    return { name: 'air', position: pos };
  });
  const placeBlockStub = sinon.stub().callsFake(async () => { placed = true; });

  const { mockServer } = setupFactory({
    blockAt: blockAtStub,
    placeBlock: placeBlockStub
  });

  const executor = executorFor(mockServer, 'plant-crop');
  const result = await executor({ crop: 'wheat', x: 5, y: 64, z: 5 });

  t.true(placeBlockStub.calledOnce);
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Planted 1 wheat at (5, 64, 5).'));
});

test('plant-crop plants a row when count > 1', async (t) => {
  const target = new Vec3(5, 64, 5);
  const reference = new Vec3(5, 63, 5);
  const placedCells = new Set<string>();
  const blockAtStub = sinon.stub().callsFake((pos: Vec3) => {
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (pos.equals(reference)) return { name: 'farmland', position: reference };
    if (placedCells.has(key)) return { name: 'carrots', position: pos };
    return { name: 'air', position: pos };
  });
  const placeBlockStub = sinon.stub().callsFake(async (_ref: unknown, _vec: Vec3) => {
    placedCells.add(`${target.x + placedCells.size},${target.y},${target.z}`);
  });

  const { mockServer } = setupFactory({
    blockAt: blockAtStub,
    placeBlock: placeBlockStub
  });

  const executor = executorFor(mockServer, 'plant-crop');
  const result = await executor({ crop: 'carrots', x: 5, y: 64, z: 5, count: 3 });

  t.is(placeBlockStub.callCount, 3);
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Planted 3 carrots at (5, 64, 5).'));
});

test('plant-crop errors on unknown crop', async (t) => {
  const { mockServer } = setupFactory({});
  const executor = executorFor(mockServer, 'plant-crop');
  const result = await executor({ crop: 'diamond', x: 5, y: 64, z: 5 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Unknown crop: diamond.'));
});

test('plant-crop errors when the block is not present after placing', async (t) => {
  const target = new Vec3(5, 64, 5);
  const reference = new Vec3(5, 63, 5);
  const blockAtStub = sinon.stub().callsFake((pos: Vec3) => {
    if (pos.equals(target)) return { name: 'air', position: target };
    if (pos.equals(reference)) return { name: 'farmland', position: reference };
    return { name: 'air', position: pos };
  });

  const { mockServer } = setupFactory({
    blockAt: blockAtStub,
    placeBlock: sinon.stub().resolves()
  });

  const executor = executorFor(mockServer, 'plant-crop');
  const result = await executor({ crop: 'wheat', x: 5, y: 64, z: 5 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Placement failed — block not present'));
});

test('harvest-crop digs mature crops and reports the tally', async (t) => {
  const mature = { name: 'wheat', metadata: 7, position: new Vec3(5, 64, 5) };
  const blockAtStub = sinon.stub().callsFake((pos: Vec3) => {
    if (pos.equals(new Vec3(5, 64, 5))) return mature;
    return { name: 'air', position: pos };
  });
  const digStub = sinon.stub().resolves();

  const { mockServer } = setupFactory({
    blockAt: blockAtStub,
    dig: digStub
  });

  const executor = executorFor(mockServer, 'harvest-crop');
  const result = await executor({ x1: 5, y1: 64, z1: 5, x2: 5, y2: 64, z2: 5 });

  t.true(digStub.calledOnce);
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Harvested 1 wheat(s).'));
});

test('harvest-crop skips immature crops', async (t) => {
  const immature = { name: 'wheat', metadata: 2, position: new Vec3(5, 64, 5) };
  const blockAtStub = sinon.stub().callsFake((pos: Vec3) => {
    if (pos.equals(new Vec3(5, 64, 5))) return immature;
    return { name: 'air', position: pos };
  });
  const digStub = sinon.stub().resolves();

  const { mockServer } = setupFactory({
    blockAt: blockAtStub,
    dig: digStub
  });

  const executor = executorFor(mockServer, 'harvest-crop');
  const result = await executor({ x1: 5, y1: 64, z1: 5, x2: 5, y2: 64, z2: 5 });

  t.false(digStub.called);
  t.true(result.content[0].text.includes('No mature crops in the area.'));
});

test('harvest-crop reports no mature crops', async (t) => {
  const blockAtStub = sinon.stub().returns({ name: 'air', metadata: 0 });

  const { mockServer } = setupFactory({
    blockAt: blockAtStub,
    dig: sinon.stub().resolves()
  });

  const executor = executorFor(mockServer, 'harvest-crop');
  const result = await executor({ x1: 5, y1: 64, z1: 5, x2: 5, y2: 64, z2: 5 });

  t.true(result.content[0].text.includes('No mature crops in the area.'));
});

test('harvest-crop errors when the volume is too large', async (t) => {
  const { mockServer } = setupFactory({});
  const executor = executorFor(mockServer, 'harvest-crop');
  const result = await executor({ x1: 0, y1: 64, z1: 0, x2: 14, y2: 64, z2: 14 });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Scan area too large'));
});

test('feed-animal feeds the nearest animal with the equipped food', async (t) => {
  const mockEntity = {
    name: 'cow',
    position: new Vec3(10.4, 64, 20.7)
  };
  const nearestEntityStub = sinon.stub().returns(mockEntity);
  const equipStub = sinon.stub().resolves();
  const useOnStub = sinon.stub();

  const { mockServer } = setupFactory({
    nearestEntity: nearestEntityStub,
    equip: equipStub,
    useOn: useOnStub,
    inventory: {
      items: () => [createMockItem({ name: 'wheat', count: 3, type: 296, metadata: 0 })]
    }
  });

  const executor = executorFor(mockServer, 'feed-animal');
  const result = await executor({ entityType: 'cow', foodItem: 'wheat' });

  t.true(equipStub.calledOnce);
  t.true(useOnStub.calledOnce);
  t.is(useOnStub.firstCall.args[0], mockEntity);
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Fed cow with wheat at (10, 64, 20).'));
});

test('feed-animal errors when no animal is found', async (t) => {
  const { mockServer } = setupFactory({
    nearestEntity: sinon.stub().returns(null)
  });

  const executor = executorFor(mockServer, 'feed-animal');
  const result = await executor({ entityType: 'cow', foodItem: 'wheat' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No cow found nearby.'));
});

test('feed-animal errors when the food is not in inventory', async (t) => {
  const mockEntity = { name: 'cow', position: new Vec3(10, 64, 20) };
  const { mockServer } = setupFactory({
    nearestEntity: sinon.stub().returns(mockEntity),
    inventory: {
      items: () => []
    }
  });

  const executor = executorFor(mockServer, 'feed-animal');
  const result = await executor({ entityType: 'cow', foodItem: 'golden_carrot' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes("Couldn't find golden_carrot in inventory."));
});

test('cook-food cooks a raw food item in a found furnace', async (t) => {
  const furnace = new EventEmitter() as mineflayer.Furnace & EventEmitter;
  const outputItem = createMockItem({
    name: 'cooked_beef',
    count: 1,
    type: 364,
    metadata: 0,
    slot: 0
  });

  furnace.putInput = sinon.stub().resolves();
  furnace.putFuel = sinon.stub().resolves();
  furnace.takeOutput = sinon.stub().resolves(outputItem);
  furnace.inputItem = sinon.stub().returns(null);
  furnace.fuelItem = sinon.stub().returns(null);
  furnace.outputItem = sinon.stub().returns(outputItem);
  furnace.close = sinon.stub();

  const findBlockStub = sinon.stub().returns({ name: 'furnace', position: new Vec3(1, 2, 3) });
  const openFurnaceStub = sinon.stub().resolves(furnace);

  const { mockServer } = setupFactory({
    version: '1.21',
    findBlock: findBlockStub,
    openFurnace: openFurnaceStub,
    inventory: {
      items: () => [
        createMockItem({ name: 'raw_beef', count: 2, type: 363, metadata: 0 }),
        createMockItem({ name: 'coal', count: 5, type: 263, metadata: 0 })
      ]
    }
  });

  const executor = executorFor(mockServer, 'cook-food');
  const result = await executor({ itemName: 'raw_beef' });

  t.true(findBlockStub.calledOnce);
  t.true(openFurnaceStub.calledOnce);
  t.true((furnace.putInput as sinon.SinonStub).calledOnce);
  t.true((furnace.putFuel as sinon.SinonStub).calledOnce);
  t.true((furnace.takeOutput as sinon.SinonStub).calledOnce);
  t.true((furnace.close as sinon.SinonStub).calledOnce);
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Cooked 1 raw_beef -> cooked_beef.'));
});

test('cook-food uses a furnace at explicit coordinates', async (t) => {
  const furnace = new EventEmitter() as mineflayer.Furnace & EventEmitter;
  const outputItem = createMockItem({
    name: 'baked_potato',
    count: 1,
    type: 393,
    metadata: 0,
    slot: 0
  });

  furnace.putInput = sinon.stub().resolves();
  furnace.putFuel = sinon.stub().resolves();
  furnace.takeOutput = sinon.stub().resolves(outputItem);
  furnace.inputItem = sinon.stub().returns(null);
  furnace.fuelItem = sinon.stub().returns(null);
  furnace.outputItem = sinon.stub().returns(outputItem);
  furnace.close = sinon.stub();

  const blockAtStub = sinon.stub().callsFake((pos: Vec3) => {
    if (pos.equals(new Vec3(1, 2, 3))) return { name: 'furnace', position: new Vec3(1, 2, 3) };
    return { name: 'air', position: pos };
  });
  const openFurnaceStub = sinon.stub().resolves(furnace);

  const { mockServer } = setupFactory({
    version: '1.21',
    blockAt: blockAtStub,
    openFurnace: openFurnaceStub,
    inventory: {
      items: () => [
        createMockItem({ name: 'potato', count: 2, type: 392, metadata: 0 }),
        createMockItem({ name: 'coal', count: 5, type: 263, metadata: 0 })
      ]
    }
  });

  const executor = executorFor(mockServer, 'cook-food');
  const result = await executor({ itemName: 'potato', x: 1, y: 2, z: 3 });

  t.true((openFurnaceStub as sinon.SinonStub).calledOnce);
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Cooked 1 potato -> baked_potato.'));
});

test('cook-food errors on non-cookable items', async (t) => {
  const { mockServer } = setupFactory({});
  const executor = executorFor(mockServer, 'cook-food');
  const result = await executor({ itemName: 'dirt' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('Cannot cook dirt.'));
});

test('cook-food errors when the raw item is not in inventory', async (t) => {
  const { mockServer } = setupFactory({
    inventory: {
      items: () => [createMockItem({ name: 'coal', count: 5, type: 263, metadata: 0 })]
    }
  });

  const executor = executorFor(mockServer, 'cook-food');
  const result = await executor({ itemName: 'raw_beef' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes("Couldn't find any item matching 'raw_beef' in inventory"));
});

test('cook-food errors when no furnace is found', async (t) => {
  const { mockServer } = setupFactory({
    version: '1.21',
    findBlock: sinon.stub().returns(null),
    inventory: {
      items: () => [
        createMockItem({ name: 'raw_beef', count: 1, type: 363, metadata: 0 }),
        createMockItem({ name: 'coal', count: 5, type: 263, metadata: 0 })
      ]
    }
  });

  const executor = executorFor(mockServer, 'cook-food');
  const result = await executor({ itemName: 'raw_beef' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No furnace found within 16 blocks.'));
});

test('cook-food errors when no fuel is in inventory', async (t) => {
  const { mockServer } = setupFactory({
    version: '1.21',
    findBlock: sinon.stub().returns({ name: 'furnace', position: new Vec3(1, 2, 3) }),
    inventory: {
      items: () => [createMockItem({ name: 'raw_beef', count: 1, type: 363, metadata: 0 })]
    }
  });

  const executor = executorFor(mockServer, 'cook-food');
  const result = await executor({ itemName: 'raw_beef' });

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No fuel found in inventory.'));
});

test('sleep sleeps in a found bed', async (t) => {
  const bed = { name: 'white_bed', position: new Vec3(10, 64, 20) };
  const sleepStub = sinon.stub().resolves();
  const findBlockStub = sinon.stub().returns(bed);

  const { mockServer } = setupFactory({
    isSleeping: false,
    isABed: () => true,
    findBlock: findBlockStub,
    sleep: sleepStub
  });

  const executor = executorFor(mockServer, 'sleep');
  const result = await executor({});

  t.true(findBlockStub.calledOnce);
  t.true(sleepStub.calledOnce);
  t.is(sleepStub.firstCall.args[0], bed);
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Sleeping in bed at (10, 64, 20)'));
});

test('sleep wakes up when forceWake is set', async (t) => {
  const wakeStub = sinon.stub().resolves();
  const { mockServer } = setupFactory({
    isSleeping: true,
    wake: wakeStub
  });

  const executor = executorFor(mockServer, 'sleep');
  const result = await executor({ forceWake: true });

  t.true(wakeStub.calledOnce);
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Slept and woke.'));
});

test('sleep errors when no bed is found', async (t) => {
  const { mockServer } = setupFactory({
    isSleeping: false,
    isABed: () => true,
    findBlock: sinon.stub().returns(null)
  });

  const executor = executorFor(mockServer, 'sleep');
  const result = await executor({});

  t.true(!!result.isError);
  t.true(result.content[0].text.includes('No bed found nearby.'));
});
