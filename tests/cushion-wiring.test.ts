import test from 'ava';
import sinon from 'sinon';
import { resourceCushionOK, twoStrikeShouldSwitch } from '../src/fallback.js';
import {
  canRunOperation,
  cushionState,
  registerCombatTools
} from '../src/tools/combat-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

function fakeBot(vitals: { health?: number; food?: number }): mineflayer.Bot {
  return {
    health: vitals.health,
    food: vitals.food
  } as unknown as mineflayer.Bot;
}

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
  const call = toolCalls.find((c) => c.args[0] === toolName);
  return call!.args[3];
}

test('canRunOperation(combat) is false for a low-HP bot', (t) => {
  const bot = fakeBot({ health: 4, food: 10 });
  const result = canRunOperation(bot, 'combat');
  t.false(result.ok);
  t.truthy(result.reason);
  t.true(result.reason!.includes('combat'));
});

test('canRunOperation(combat) is true for a healthy bot', (t) => {
  const bot = fakeBot({ health: 20, food: 20 });
  const result = canRunOperation(bot, 'combat');
  t.true(result.ok);
  t.is(result.reason, undefined);
});

test('canRunOperation is defensive: unknown state is allowed', (t) => {
  const bot = {} as unknown as mineflayer.Bot;
  const result = canRunOperation(bot, 'combat');
  t.true(result.ok);
});

test('resourceCushionOK: caving blocked when HP < 10', (t) => {
  t.false(resourceCushionOK({ health: 9, food: 20, toolDurabilityPercent: 100 }, 'cave'));
});

test('resourceCushionOK: caving blocked when food < 12', (t) => {
  t.false(resourceCushionOK({ health: 20, food: 11, toolDurabilityPercent: 100 }, 'cave'));
});

test('resourceCushionOK: caving allowed when healthy', (t) => {
  t.true(resourceCushionOK({ health: 20, food: 20, toolDurabilityPercent: 100 }, 'cave'));
});

test('twoStrikeShouldSwitch: true after 2 distinct mitigations', (t) => {
  t.false(twoStrikeShouldSwitch(1, ['dig faster']));
  t.false(twoStrikeShouldSwitch(2, ['dig faster', 'dig faster']));
  t.true(twoStrikeShouldSwitch(2, ['dig faster', 'use a pickaxe']));
});

test('cushionState surfaces health and food defensively', (t) => {
  const state = cushionState(fakeBot({ health: 7, food: 9 }));
  t.is(state.health, 7);
  t.is(state.food, 9);
});

test('combat gate refuses to engage when the cushion is not met', async (t) => {
  const mockEntity = {
    id: 10,
    name: 'zombie',
    type: 'mob',
    position: new Vec3(3, 64, 0)
  };
  const attackStub = sinon.stub().resolves(true);
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    health: 4,
    food: 10,
    nearestEntity: sinon.stub().returns(mockEntity),
    attack: attackStub,
    equip: sinon.stub().resolves(),
    inventory: { items: () => [{ name: 'iron_sword', count: 1, slot: 0 }] }
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'attack-entity');

  const result = await executor({});

  t.true(result.isError);
  t.true(result.content[0].text.includes('Refusing to engage'));
  t.true(result.content[0].text.includes('resource cushion not met'));
  t.true((mockBot.attack as sinon.SinonStub).notCalled);
});

test('combat gate allows attack when the cushion is met', async (t) => {
  const mockEntity = {
    id: 10,
    name: 'zombie',
    type: 'mob',
    position: new Vec3(3, 64, 0)
  };
  const attackStub = sinon.stub().resolves(true);
  const mockBot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    health: 20,
    food: 20,
    nearestEntity: sinon.stub().returns(mockEntity),
    attack: attackStub,
    equip: sinon.stub().resolves(),
    inventory: { items: () => [{ name: 'iron_sword', count: 1, slot: 0 }] }
  };
  const mockServer = setupWithBot(mockBot);
  const executor = getToolExecutor(mockServer, 'attack-entity');

  const result = await executor({});

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('3 hit(s)'));
});
