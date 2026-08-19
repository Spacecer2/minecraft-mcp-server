import test from 'ava';
import { setupStdioFiltering } from '../src/stdio-filter.js';

test('does not interfere with stdout writes', (t) => {
  const originalWrite = process.stdout.write;
  let capturedOutput = '';

  process.stdout.write = ((chunk: string | Uint8Array) => {
    capturedOutput += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  setupStdioFiltering();

  process.stdout.write('{"jsonrpc":"2.0","id":1,"method":"test"}');
  process.stdout.write('Random debug message');
  process.stdout.write('\n');

  t.is(capturedOutput, '{"jsonrpc":"2.0","id":1,"method":"test"}Random debug message\n');

  process.stdout.write = originalWrite;
});

test('does not replace process.stdout.write', (t) => {
  const originalWrite = process.stdout.write;

  setupStdioFiltering();

  t.is(process.stdout.write, originalWrite);
});

test('does not suppress console.error', (t) => {
  const originalError = console.error;
  let capturedError = '';

  console.error = ((chunk: string | Uint8Array) => {
    capturedError += chunk.toString();
    return true;
  }) as typeof console.error;

  setupStdioFiltering();

  console.error('some error occurred');

  t.true(capturedError.includes('some error occurred'));

  console.error = originalError;
});

test('does not replace console.error', (t) => {
  const originalError = console.error;

  setupStdioFiltering();

  t.is(console.error, originalError);
});

test('setupStdioFiltering is idempotent (second call does not double-wrap)', (t) => {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  t.notThrows(() => setupStdioFiltering());
  const wrappedLog = console.log;
  const wrappedInfo = console.info;
  const wrappedDebug = console.debug;

  // Calling again must not throw and must leave the installed functions in
  // place — never re-wrapping what is already installed.
  t.notThrows(() => setupStdioFiltering());
  t.is(console.log, wrappedLog);
  t.is(console.info, wrappedInfo);
  t.is(console.debug, wrappedDebug);

  console.log = originalLog;
  console.info = originalInfo;
  console.debug = originalDebug;
});

test('setupStdioFiltering returns without throwing in a benign environment', (t) => {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  const originalStdoutWrite = process.stdout.write;
  const originalError = console.error;

  t.notThrows(() => setupStdioFiltering());

  // The transport-facing stream and error channel are never touched.
  t.is(process.stdout.write, originalStdoutWrite);
  t.is(console.error, originalError);

  console.log = originalLog;
  console.info = originalInfo;
  console.debug = originalDebug;
});
