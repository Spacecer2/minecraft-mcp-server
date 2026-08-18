import test from 'ava';
import sinon from 'sinon';
import { registerCombatTools } from '../src/tools/combat-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

function setupWithBot(mockBot: unknown) {
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
  registerCombatTools(factory, getBot);
  return mockServer;
}

function getToolExecutor(mockServer: McpServer, toolName: string) {
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const call = toolCalls.find(c => c.args[0] === toolName);
  return call!.args[3];
}

test('registerCombatTools registers all combat tools', (t) => {
  const mockServer = setupWithBot({});
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  for (const expected of ['attack-entity', 'flee', 'equip-best-weapon', 'get-health']) {
    t.true(names.includes(expected), `${expected} should be registered`);
  }
});

test('equip-best-weapon equips the highest-tier sword', async (t) => {
  const equipStub = sinon.stub().resolves();
  const mockBot = {
    inventory: {
      items: () => [
        { name: 'wooden_sword', count: 1, slot: 0 },
        { name: 'iron_sword', count: 1, slot: 1 }
      ]
    },
    equip: equipStub
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'equip-best-weapon');

  const result = await executor({});

  t.true(equipStub.calledOnce);
  t.is(equipStub.firstCall.args[0].name, 'iron_sword');
  t.is(equipStub.firstCall.args[1], 'hand');
  t.true(result.content[0].text.includes('Equipped iron_sword'));
});

test('equip-best-weapon prefers swords over axes of the same tier', async (t) => {
  const equipStub = sinon.stub().resolves();
  const mockBot = {
    inventory: {
      items: () => [
        { name: 'iron_axe', count: 1, slot: 0 },
        { name: 'diamond_axe', count: 1, slot: 1 },
        { name: 'diamond_sword', count: 1, slot: 2 }
      ]
    },
    equip: equipStub
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'equip-best-weapon');

  const result = await executor({});

  t.true(equipStub.calledOnce);
  t.is(equipStub.firstCall.args[0].name, 'diamond_sword');
  t.true(result.content[0].text.includes('Equipped diamond_sword'));
});

test('equip-best-weapon returns message when no weapon in inventory', async (t) => {
  const equipStub = sinon.stub().resolves();
  const mockBot = {
    inventory: {
      items: () => [
        { name: 'dirt', count: 1, slot: 0 },
        { name: 'cobblestone', count: 64, slot: 1 }
      ]
    },
    equip: equipStub
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'equip-best-weapon');

  const result = await executor({});

  t.true(equipStub.notCalled);
  t.true(result.content[0].text.includes('No weapon in inventory'));
});

test('attack-entity attacks a nearby hostile', async (t) => {
  const mockEntity = {
    id: 10,
    name: 'zombie',
    type: 'mob',
    health: 20,
    position: new Vec3(3, 64, 0)
  };
  const attackStub = sinon.stub().resolves(true);
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(mockEntity),
    attack: attackStub,
    equip: sinon.stub().resolves(),
    inventory: {
      items: () => [{ name: 'iron_sword', count: 1, slot: 0 }]
    }
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'attack-entity');

  const result = await executor({});

  t.true(attackStub.callCount === 3);
  t.true(result.content[0].text.includes('zombie'));
  t.true(result.content[0].text.includes('3 hit(s)'));
  t.true(result.content[0].text.includes('Health: 20'));
});

test('attack-entity honors explicit entityType and hits count', async (t) => {
  const mockEntity = {
    id: 10,
    name: 'creeper',
    type: 'mob',
    position: new Vec3(2, 64, 0)
  };
  const attackStub = sinon.stub().resolves();
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(mockEntity),
    attack: attackStub,
    equip: sinon.stub().resolves(),
    inventory: { items: () => [] }
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'attack-entity');

  const result = await executor({ entityType: 'creeper', hits: 2 });

  t.true(attackStub.callCount === 2);
  t.true(result.content[0].text.includes('creeper'));
  t.true(result.content[0].text.includes('2 hit(s)'));
});

test('attack-entity returns no-target message when nothing hostile is nearby', async (t) => {
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(null),
    attack: sinon.stub().resolves(),
    equip: sinon.stub().resolves(),
    inventory: { items: () => [] }
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'attack-entity');

  const result = await executor({});

  t.true(result.content[0].text.includes('No hostile within 6 blocks'));
  t.true((mockBot.attack as sinon.SinonStub).notCalled);
});

test('attack-entity returns no-target message when target is out of range', async (t) => {
  const mockEntity = {
    id: 10,
    name: 'zombie',
    type: 'mob',
    position: new Vec3(30, 64, 0)
  };
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(mockEntity),
    attack: sinon.stub().resolves(),
    equip: sinon.stub().resolves(),
    inventory: { items: () => [] }
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'attack-entity');

  const result = await executor({ entityType: 'zombie', maxDistance: 6 });

  t.true(result.content[0].text.includes('No zombie within 6 blocks'));
  t.true((mockBot.attack as sinon.SinonStub).notCalled);
});

test('flee moves away from a hostile', async (t) => {
  const mockEntity = {
    id: 10,
    name: 'zombie',
    type: 'mob',
    position: new Vec3(10, 64, 0)
  };
  const gotoStub = sinon.stub().resolves();
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(mockEntity),
    pathfinder: { goto: gotoStub }
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'flee');

  const result = await executor({ distance: 16 });

  t.true(gotoStub.calledOnce);
  t.truthy(gotoStub.firstCall.args[0]);
  t.true(result.content[0].text.includes('Fled 16 blocks from zombie'));
  t.true(result.content[0].text.includes('now at'));
});

test('flee honors a specific entityType', async (t) => {
  const mockEntity = {
    id: 20,
    name: 'ender_dragon',
    type: 'mob',
    position: new Vec3(5, 64, 5)
  };
  const gotoStub = sinon.stub().resolves();
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(mockEntity),
    pathfinder: { goto: gotoStub }
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'flee');

  const result = await executor({ entityType: 'ender_dragon', distance: 8 });

  t.true(gotoStub.calledOnce);
  t.true(result.content[0].text.includes('Fled 8 blocks from ender_dragon'));
});

test('flee returns no-threat message when nothing hostile is present', async (t) => {
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    nearestEntity: sinon.stub().returns(null),
    pathfinder: { goto: sinon.stub().resolves() }
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'flee');

  const result = await executor({});

  t.true(result.content[0].text.includes('No threat to flee from'));
  t.true((mockBot.pathfinder.goto as sinon.SinonStub).notCalled);
});

test('get-health reports health, food, and saturation', async (t) => {
  const mockBot = {
    health: 12,
    food: 8,
    saturation: 5
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'get-health');

  const result = await executor({});

  t.true(result.content[0].text.includes('Health: 12/20'));
  t.true(result.content[0].text.includes('Food: 8/20'));
  t.true(result.content[0].text.includes('Saturation: 5'));
});

test('get-health shows n/a when saturation is missing', async (t) => {
  const mockBot = {
    health: 20,
    food: 20
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'get-health');

  const result = await executor({});

  t.true(result.content[0].text.includes('Saturation: n/a'));
});

test('get-health warns when health is low', async (t) => {
  const mockBot = {
    health: 4,
    food: 10,
    saturation: 5
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'get-health');

  const result = await executor({});

  t.true(result.content[0].text.includes('Low health'));
});
