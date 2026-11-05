import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperation, readOperation, updateOperation, listOperations, OperationWriteError, type OperationApi, type OperationDocument} from './operation-store';
const key = '11111111-1111-4111-8111-111111111111';
const container = 'rw-mc-wms-operations';
const stamp = '2026-11-05T06:00:00.000Z';
const doc = (index = 1): OperationDocument<{status: string}> => ({id: key, key: index === 1 ? key : `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, container, version: 1, createdAt: stamp, lastModifiedAt: stamp, value: {status: 'draft'}});
const api = (fn: (path: string, body?: unknown) => unknown): OperationApi => async <T>(path: string, body?: unknown) => fn(path, body) as T;

test('CustomObject create uses version zero and update uses exact observed version, once each', async () => {
  const calls: unknown[] = [];
  const client = api((path, body) => { calls.push({path, body}); return {...doc(), version: calls.length}; });
  const created = await createOperation(client, container, key, {status: 'draft'});
  await updateOperation(client, created, {status: 'approved'});
  assert.deepEqual(calls, [{path: 'custom-objects', body: {container, key, version: 0, value: {status: 'draft'}}}, {path: 'custom-objects', body: {container, key, version: 1, value: {status: 'approved'}}}]);
});
test('CustomObject conflicts and unknown outcomes never retry or replace existing data', async () => {
  for (const [status, outcome] of [[409, 'conflict'], [503, 'unknown'], [undefined, 'unknown'], [403, 'rejected']] as const) {
    let writes = 0;
    const client = api(() => { writes++; throw Object.assign(new Error('upstream'), {status}); });
    await assert.rejects(createOperation(client, container, key, {}), error => error instanceof OperationWriteError && error.outcome === outcome);
    assert.equal(writes, 1);
  }
});
test('CustomObject path/key validation occurs before requests, and missing read is explicit', async () => {
  let calls = 0;
  const client = api(() => {calls++; throw Object.assign(new Error(), {status: 404});});
  await assert.rejects(readOperation(client, 'foreign', key));
  await assert.rejects(readOperation(client, container, '../other'));
  assert.equal(calls, 0);
  assert.equal(await readOperation(client, container, key), undefined);
  assert.equal(calls, 1);
  await assert.rejects(readOperation(api(() => ({...doc(), key: doc(2).key})), container, key), /不符/);
});
test('CustomObject list uses stable server time/key cursor, twenty rows, and no local UUID sorting', async () => {
  const documents = Array.from({length: 20}, (_, index) => doc(index + 1)).reverse();
  const paths: string[] = [];
  const client = api(path => {paths.push(path); return {results: documents};});
  const result = await listOperations(client, container);
  assert.deepEqual(result.results, documents);
  assert.deepEqual(result.nextCursor, {createdAt: stamp, key: documents.at(-1)!.key});
  const url = new URL(paths[0], 'https://example.invalid/');
  assert.equal(url.pathname, `/custom-objects/${container}`);
  assert.equal(url.searchParams.get('limit'), '20');
  assert.deepEqual(url.searchParams.getAll('sort'), ['createdAt desc', 'key asc']);
  await listOperations(api(path => {paths.push(path); return {results: []};}), container, result.nextCursor);
  const where = new URL(paths[1], 'https://example.invalid/').searchParams.get('where')!;
  assert.ok(where.includes(`createdAt < "${stamp}"`)); assert.ok(where.includes(`key > "${documents.at(-1)!.key}"`));
  await assert.rejects(listOperations(api(() => ({results: [doc(), doc()]})), container), /重复/);
});
