import test from 'ava';
import sinon from 'sinon';
import { BotManager } from '../src/bot-manager.js';
import { BotConnection } from '../src/bot-connection.js';

function makeManager(): BotManager {
  return new BotManager({
    host: 'localhost',
    port: 25565,
    primaryName: 'primary',
    onLog: sinon.stub(),
    onChatMessage: sinon.stub()
  });
}

test.serial('blackboard setShared/getShared round-trips a value', (t) => {
  const manager = makeManager();
  manager.setShared('task', 'mine diamonds');
  t.is(manager.getShared('task'), 'mine diamonds');
});

test.serial('blackboard getShared returns undefined for a missing key', (t) => {
  const manager = makeManager();
  t.is(manager.getShared('nope'), undefined);
});

test.serial('blackboard getAllShared returns every shared value', (t) => {
  const manager = makeManager();
  manager.setShared('a', '1');
  manager.setShared('b', '2');
  t.deepEqual(manager.getAllShared(), { a: '1', b: '2' });
});

test.serial('blackboard deleteShared removes a value', (t) => {
  const manager = makeManager();
  manager.setShared('a', '1');
  manager.setShared('b', '2');
  manager.deleteShared('a');
  t.is(manager.getShared('a'), undefined);
  t.deepEqual(manager.getAllShared(), { b: '2' });
});

test.serial('spawnBot awaits the bot connection before returning', async (t) => {
  const manager = makeManager();
  const connectStub = sinon.stub(BotConnection.prototype, 'connect');
  const waitForSpawnStub = sinon.stub(BotConnection.prototype, 'waitForSpawn').resolves(true);
  try {
    const connection = await manager.spawnBot('helper');
    t.true(connectStub.calledOnce);
    t.true(waitForSpawnStub.calledOnce);
    t.is(connection.getConfig().username, 'helper');
    t.true(manager.getNames().includes('helper'));
  } finally {
    connectStub.restore();
    waitForSpawnStub.restore();
  }
});

test.serial('spawnBot throws when the bot fails to spawn within the timeout', async (t) => {
  const manager = makeManager();
  const connectStub = sinon.stub(BotConnection.prototype, 'connect');
  const waitForSpawnStub = sinon.stub(BotConnection.prototype, 'waitForSpawn').resolves(false);
  try {
    await t.throwsAsync(
      manager.spawnBot('helper'),
      { message: /did not finish connecting to localhost:25565 within 10000ms/ }
    );
  } finally {
    connectStub.restore();
    waitForSpawnStub.restore();
  }
});

test.serial('spawnBot rejects when a bot with the same name already exists', async (t) => {
  const manager = makeManager();
  const connectStub = sinon.stub(BotConnection.prototype, 'connect');
  const waitForSpawnStub = sinon.stub(BotConnection.prototype, 'waitForSpawn').resolves(true);
  try {
    await manager.spawnBot('helper');
    await t.throwsAsync(manager.spawnBot('helper'), { message: /already exists/ });
  } finally {
    connectStub.restore();
    waitForSpawnStub.restore();
  }
});
