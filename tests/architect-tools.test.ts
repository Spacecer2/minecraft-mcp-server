import test from 'ava';
import sinon from 'sinon';
import { registerArchitectTools, buildScaffold, checkSelfTrap, morphTemplate, buildCircuit, runPostBuildQa } from '../src/tools/architect-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';

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

test('registerArchitectTools registers all five tools', (t) => {
  const { mockServer, factory } = setup();
  registerArchitectTools(factory, () => ({} as mineflayer.Bot));
  const names = (mockServer.tool as sinon.SinonStub).getCalls().map(c => c.args[0]);
  for (const name of ['scaffold-plan', 'check-self-trap', 'morph-template', 'build-circuit', 'post-build-qa']) {
    t.true(names.includes(name), `missing ${name}`);
  }
});

test('scaffold-plan produces a column up to working height', (t) => {
  const plan = buildScaffold(10, 64, 20, 68);
  t.is(plan.place.length, 3);
  t.deepEqual(plan.place, [
    { x: 10, y: 65, z: 20 },
    { x: 10, y: 66, z: 20 },
    { x: 10, y: 67, z: 20 }
  ]);
});

test('scaffold-plan teardown order is top-down and never includes the standing block', (t) => {
  const plan = buildScaffold(10, 64, 20, 68);
  t.deepEqual(plan.teardown, [
    { x: 10, y: 67, z: 20 },
    { x: 10, y: 66, z: 20 },
    { x: 10, y: 65, z: 20 }
  ]);
  const base = 64;
  t.false(plan.teardown.some(p => p.y === base), 'teardown must never remove the block the bot stands on');
});

test('scaffold-plan uses a 2-wide tower for tall builds', (t) => {
  const plan = buildScaffold(10, 64, 20, 80);
  t.true(plan.place.some(p => p.x === 11), 'tall build should add a second column');
  t.true(plan.note.includes('2-wide tower'));
});

test('scaffold-plan leaves headroom', (t) => {
  const plan = buildScaffold(10, 64, 20, 70);
  t.is(Math.max(...plan.place.map(p => p.y)), 69, 'top block should stop one below target');
  t.true(plan.note.includes('headroom'));
});

test('check-self-trap flags a trapped layout', (t) => {
  const result = checkSelfTrap(5, 64, 5, { w: 3, d: 3 }, undefined);
  t.true(result.trapped);
  t.false(result.exitClear);
  t.true(result.leaveDoorOpen);
  t.true(result.blockedStandingBlock);
});

test('check-self-trap passes a clear layout with an opening', (t) => {
  const result = checkSelfTrap(5, 64, 5, { w: 3, d: 3 }, { x: 5, z: 5 });
  t.false(result.trapped);
  t.true(result.leaveDoorOpen === false, 'opening provided so no need to leave door open');
});

test('check-self-trap treats auto opening as safe', (t) => {
  const result = checkSelfTrap(5, 64, 5, { w: 3, d: 3 }, 'auto');
  t.false(result.trapped);
});

test('check-self-trap returns clear when no footprint given', (t) => {
  const result = checkSelfTrap(5, 64, 5, undefined, undefined);
  t.false(result.trapped);
  t.true(result.exitClear);
});

test('morph-template scales w/d and caps palette at 4', (t) => {
  const result = morphTemplate('house', 8, 6, ['oak_log', 'oak_planks', 'stone_bricks', 'spruce_planks', 'cobblestone']);
  t.deepEqual(result.footprint, { w: 8, d: 6 });
  t.is(result.palette.length, 4);
  t.true(result.proportions.some(p => p.includes('door 1x2')));
});

test('morph-template uses default palette when none supplied', (t) => {
  const result = morphTemplate('house', 6, 5, []);
  t.is(result.palette.length, 4);
  t.true(result.palette.length <= 4);
});

test('morph-template validates room depth ~= width', (t) => {
  const result = morphTemplate('house', 10, 2, ['oak_log']);
  t.true(result.proportions.some(p => p.includes('ratio')));
});

test('morph-template adds feature notes for extras', (t) => {
  const result = morphTemplate('cottage', 8, 7, ['spruce_log'], 'porch');
  t.true(result.notes.some(n => n.includes('porch')));
});

test('build-circuit returns a sensible layout per type', (t) => {
  const expectations: Record<string, (l: ReturnType<typeof buildCircuit>) => boolean> = {
    NOT: (l) => l.components.torch === 1 && l.blocks.length >= 1,
    AND: (l) => l.components.dust >= 1,
    OR: (l) => l.components.dust >= 1,
    'RS-latch': (l) => l.components.torch === 2,
    pulse: (l) => l.components.comparator === 1,
    door: (l) => l.components.sticky_piston === 4,
    lamp: (l) => l.components.lamp === 1,
    'auto-farm': (l) => l.components.observer === 1 && l.components.sticky_piston === 1,
    trap: (l) => l.components.tripwire_hook === 2
  };
  for (const [type, check] of Object.entries(expectations)) {
    const layout = buildCircuit(type as Parameters<typeof buildCircuit>[0], { x: 0, y: 64, z: 0 });
    t.true(check(layout), `${type} should produce a sensible layout`);
    t.true(layout.notes.length > 0, `${type} should include wiring notes`);
  }
});

test('post-build-qa flags floating blocks and a blocked exit', (t) => {
  const origin = { x: 0, y: 64, z: 0 };
  const footprint = { w: 3, d: 3 };
  const ground = 65;
  const groundRing = [
    { x: 0, y: ground, z: 0 },
    { x: 1, y: ground, z: 0 },
    { x: 2, y: ground, z: 0 },
    { x: 0, y: ground, z: 1 },
    { x: 2, y: ground, z: 1 },
    { x: 0, y: ground, z: 2 },
    { x: 1, y: ground, z: 2 },
    { x: 2, y: ground, z: 2 }
  ];
  const blocks = [...groundRing, { x: 1, y: ground + 1, z: 1 }];
  const result = runPostBuildQa(origin, footprint, blocks);
  t.false(result.passed);
  t.true(result.issues.some(i => i.includes('floating block')), 'should flag a floating block');
  t.true(result.issues.some(i => i.includes('exit/path blocked')), 'should flag a closed ring with no opening');
});

test('post-build-qa passes a clean foundation with a door opening', (t) => {
  const origin = { x: 0, y: 64, z: 0 };
  const footprint = { w: 3, d: 3 };
  const ground = 65;
  const blocks = [
    { x: 0, y: ground, z: 0 },
    { x: 1, y: ground, z: 0 },
    { x: 2, y: ground, z: 0 },
    { x: 0, y: ground, z: 1 },
    { x: 0, y: ground, z: 2 },
    { x: 1, y: ground, z: 2 },
    { x: 2, y: ground, z: 2 },
    { x: 0, y: ground + 1, z: 0 },
    { x: 1, y: ground + 1, z: 0 },
    { x: 2, y: ground + 1, z: 0 }
  ];
  const result = runPostBuildQa(origin, footprint, blocks);
  t.true(result.passed);
  t.is(result.issues.length, 0);
});

test('scaffold-plan tool returns a structured response', async (t) => {
  const { mockServer, factory } = setup();
  registerArchitectTools(factory, () => ({} as mineflayer.Bot));
  const executor = getExecutor(mockServer, 'scaffold-plan');
  const result = await executor({ x: 10, y: 64, z: 20, targetY: 68 });
  t.false(!!result.isError);
  t.true(result.content[0].text.includes('Scaffold plan'));
  t.true(result.content[0].text.includes('Teardown (top-down)'));
});
