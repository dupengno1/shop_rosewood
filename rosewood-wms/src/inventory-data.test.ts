import test from 'node:test';
import assert from 'node:assert/strict';
import type {Inventory} from './api';
import {parseHostUrl} from './domain';
import {readInventoryRows, type InventoryReader} from './inventory-data';

const project = 'rosewood-shop-demorosewood-shop-demo';
const productId = '12345678-1234-1234-1234-123456789abc';
const entryId = '87654321-4321-4321-4321-cba987654321';
const otherEntryId = '87654321-4321-4321-4321-cba987654322';
const entryPath = `inventory/${entryId}?expand=supplyChannel`;

function inventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    id: entryId, version: 7, sku: 'LIVE-SKU', quantityOnStock: 12, availableQuantity: 9,
    supplyChannel: {id: 'channel-a', obj: {key: 'Warehouse A'}},
    ...overrides,
  };
}

test('native inventory detail reads its exact entry and live SKU without querying changed or missing product variants', async () => {
  const host = parseHostUrl(`https://mc.australia-southeast1.gcp.commercetools.com/${project}/products/${productId}/variants/3/inventory/${entryId}`, project);
  assert.equal(host.inventoryId, entryId);
  const products = [
    {masterData: {current: {variants: [{id: 3, sku: 'OLD-SKU'}]}, staged: {variants: [{id: 3, sku: 'STAGED-SKU'}]}}},
    {masterData: {current: {variants: [{id: 3, sku: 'OLD-SKU'}]}, staged: {masterVariant: {id: 1, sku: 'UNRELATED-MASTER'}, variants: []}}},
  ];
  for (const product of products) {
    const calls: string[] = [];
    const expected = inventory();
    const sibling = inventory({id: otherEntryId, supplyChannel: {id: 'channel-b', obj: {key: 'Warehouse B'}}});
    const read: InventoryReader = async <T>(path: string): Promise<T> => {
      calls.push(path);
      if (path === entryPath) return expected as T;
      if (path.startsWith('products/')) return product as T;
      if (path.startsWith('inventory?')) return {results: [expected, sibling]} as T;
      throw new Error(`Unexpected request: ${path}`);
    };
    const rows = await readInventoryRows(read, {kind: 'entry', id: host.inventoryId!});
    assert.deepEqual(calls, [entryPath]);
    assert.deepEqual(rows, [expected]);
    assert.equal(rows[0].sku, 'LIVE-SKU');
    assert.equal(rows[0].supplyChannel?.id, 'channel-a');
    assert.ok(!rows.some(row => row.id === sibling.id));
  }
});

test('entry reads reject a mismatched response ID or missing live SKU', async () => {
  for (const response of [inventory({id: otherEntryId}), inventory({sku: ''}), inventory({sku: '   '})]) {
    const calls: string[] = [];
    const read: InventoryReader = async <T>(path: string): Promise<T> => {
      calls.push(path);
      return response as T;
    };
    await assert.rejects(readInventoryRows(read, {kind: 'entry', id: entryId}), /does not match this detail page/);
    assert.deepEqual(calls, [entryPath]);
  }
});

test('invalid or injected inventory entry IDs fail before any API request', async () => {
  const calls: string[] = [];
  const read: InventoryReader = async <T>(path: string): Promise<T> => {
    calls.push(path);
    throw new Error('Invalid entry targets must not reach the API.');
  };
  for (const id of ['', ' ', 'not-a-uuid', `${entryId}/edit`, '../products', `${entryId}?where=sku`, `${entryId}%2Fedit`]) {
    await assert.rejects(readInventoryRows(read, {kind: 'entry', id}), /entry ID is invalid/);
  }
  assert.deepEqual(calls, []);
});

test('an entry 404 stays an error without falling back to a SKU or another channel', async () => {
  const calls: string[] = [];
  const missing = Object.assign(new Error('Inventory entry not found'), {statusCode: 404});
  const read: InventoryReader = async <T>(path: string): Promise<T> => {
    calls.push(path);
    if (path === entryPath) throw missing;
    return {results: [inventory({id: otherEntryId})]} as T;
  };
  await assert.rejects(readInventoryRows(read, {kind: 'entry', id: entryId}), error => error === missing);
  assert.deepEqual(calls, [entryPath]);
});

test('SKU mode retains escaped exact matching and cursor pagination across supply channels', async () => {
  const sku = 'SKU "quoted" \\ warehouse';
  const firstPage = Array.from({length: 100}, (_, index) => inventory({
    id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    sku, supplyChannel: {id: `channel-${index + 1}`},
  }));
  const finalEntry = inventory({id: otherEntryId, sku, supplyChannel: {id: 'channel-101'}});
  const calls: string[] = [];
  const read: InventoryReader = async <T>(path: string): Promise<T> => {
    calls.push(path);
    assert.equal(path.split('?')[0], 'inventory');
    const query = new URLSearchParams(path.split('?')[1]);
    assert.equal(query.get('limit'), '100');
    assert.equal(query.get('sort'), 'id asc');
    assert.equal(query.get('expand'), 'supplyChannel');
    assert.equal(query.get('withTotal'), 'false');
    if (calls.length === 1) {
      assert.equal(query.get('where'), `sku=${JSON.stringify(sku)}`);
      return {results: firstPage} as T;
    }
    assert.equal(calls.length, 2);
    assert.equal(query.get('where'), `sku=${JSON.stringify(sku)} and id > ${JSON.stringify(firstPage.at(-1)!.id)}`);
    return {results: [finalEntry]} as T;
  };
  assert.deepEqual(await readInventoryRows(read, {kind: 'sku', sku}), [...firstPage, finalEntry]);
  assert.equal(calls.length, 2);
});
