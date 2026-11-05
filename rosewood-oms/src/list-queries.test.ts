import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationModule, buildListQuery, skuProductQuery, normalizeSearch, pageFromQuery,
  PAGE_SIZE, QUERY_LIMIT, MAX_PAGE, orderListRow, inventoryListRow,
  nativeEntityUrl, verifiedInventoryLinks, productListRow,
  readHashState, listHashState, hashLocation,
} from './list-queries';
import type {Product} from './api';

const project = 'rosewood-shop-demorosewood-shop-demo';
const id = '12345678-1234-1234-1234-123456789abc';
const origin = 'https://mc.australia-southeast1.gcp.commercetools.com';
const query = (path: string) => new URL(`https://api.example.test/${path}`).searchParams;

test('exact order and SKU search values cannot introduce predicate clauses or URL parameters', () => {
  const term = 'A" or id is defined or key="B&limit=500\\';
  const orders = query(buildListQuery('oms', term, 0));
  assert.equal(orders.getAll('where').length, 1);
  assert.equal(JSON.parse(orders.get('where')!.slice('orderNumber='.length)), term);
  assert.equal(orders.get('limit'), String(QUERY_LIMIT));
  const inventory = query(buildListQuery('wms', term, 0));
  assert.equal(JSON.parse(inventory.get('where')!.slice('sku='.length)), term);
  assert.equal(inventory.get('expand'), 'supplyChannel');
  assert.equal(inventory.getAll('limit').length, 1);
  const productWhere = query(buildListQuery('pim', term, 0)).get('where')!;
  const literals = productWhere.match(/"(?:\\.|[^"\\])*"/g)!;
  assert.equal(literals.length, 5);
  assert.ok(literals.every(literal => JSON.parse(literal) === term));
  assert.match(productWhere, /masterData\(staged\(masterVariant/);
  assert.match(productWhere, /masterData\(current\(masterVariant/);
  assert.match(productWhere, /or variants\(sku=/);
  assert.throws(() => normalizeSearch('x\ny'), /单行/);
  assert.throws(() => normalizeSearch('a'.repeat(257)), /256/);
});

test('pagination uses fixed server limits and offset boundaries without conflating ID with arbitrary text', () => {
  const first = query(buildListQuery('oms', '', 0)), second = query(buildListQuery('oms', '', 1));
  assert.equal(first.get('limit'), String(PAGE_SIZE + 1));
  assert.equal(second.get('offset'), String(PAGE_SIZE));
  assert.deepEqual(first.getAll('sort'), ['createdAt desc', 'id desc']);
  assert.equal(first.get('withTotal'), 'false');
  assert.equal(first.has('where'), false);
  assert.match(query(buildListQuery('oms', id, 0)).get('where')!, new RegExp(` or id="${id}"$`));
  assert.match(query(buildListQuery('pim', id, 0)).get('where')!, new RegExp(` or id="${id}" or `));
  assert.equal(query(buildListQuery('pim', 'key-only', 0)).get('where')!.includes(' or id='), false);
  assert.equal(query(buildListQuery('wms', '', MAX_PAGE)).get('offset'), '10000');
  assert.throws(() => buildListQuery('wms', '', MAX_PAGE + 1), /页码/);
  assert.throws(() => buildListQuery('oms', '', -1), /页码/);
  assert.equal(pageFromQuery('-1'), 0);
  assert.equal(pageFromQuery('1.5'), 0);
  assert.equal(pageFromQuery(String(MAX_PAGE + 1)), 0);
  assert.equal(pageFromQuery('2'), 2);
});

test('list state contains no buyer or payment secrets and preserves observed negative inventory', () => {
  const rawOrder = {id, orderNumber: 'ORD-1', totalPrice: {centAmount: 1500, currencyCode: 'USD', fractionDigits: 2},
    customerEmail: 'PRIVATE EMAIL', shippingAddress: {streetName: 'PRIVATE STREET'},
    lineItems: [{custom: {fields: {giftCardCode: 'SECRET GIFT'}}}], paymentInfo: {token: 'SECRET TOKEN'}};
  const safe = orderListRow(rawOrder);
  assert.ok(!/PRIVATE|SECRET/.test(JSON.stringify(safe)));
  assert.equal(safe.totalPrice?.centAmount, 1500);
  const inventory = inventoryListRow({id, version: 1, sku: 'A', quantityOnStock: -2, availableQuantity: -3});
  assert.equal(inventory.quantityOnStock, -2);
  assert.equal(inventory.availableQuantity, -3);
});

function product(): Product {
  const data = {name: {en: 'Notebook'}, description: {en: 'Paper notebook'},
    masterVariant: {id: 1, sku: 'NOTE', images: [{url: 'https://example.test/image.jpg'}], prices: [{value: {centAmount: 1500, currencyCode: 'USD'}}]},
    variants: [{id: 2, sku: 'OTHER'}]};
  return {id, version: 3, masterData: {staged: structuredClone(data), current: structuredClone(data), published: true, hasStagedChanges: false}};
}

test('native inventory links require an exact SKU match in returned product data and never guess entity IDs', () => {
  const value = product();
  assert.deepEqual(verifiedInventoryLinks([value], 'MISSING', project, origin), []);
  const links = verifiedInventoryLinks([value], 'NOTE', project, origin);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, `${origin}/${project}/products/${id}/variants/1/inventory`);
  assert.match(links[0].label, /库存列表/);
  assert.equal(nativeEntityUrl(project, 'orders', id, origin), `${origin}/${project}/orders/${id}`);
  assert.throws(() => nativeEntityUrl(project, 'products', 'guessed-product', origin), /标识/);
  assert.throws(() => nativeEntityUrl(project, 'products', id, origin, 0), /变体/);
  const lookup = query(skuProductQuery('NOTE'));
  assert.equal(lookup.get('limit'), '2');
  assert.equal(lookup.get('where')!.startsWith('masterData(staged('), true);
  assert.throws(() => skuProductQuery('  '), /不能为空/);
  const listRow = productListRow(value);
  assert.equal(listRow.variantCount, 2);
  assert.equal(listRow.version,3);
  assert.equal(listRow.published, true);
  assert.equal(listRow.errorCount, 0);
  assert.ok(listRow.warningCount > 0);
  assert.equal(Object.hasOwn(listRow, 'masterData'), false);
});

test('only the three registered entry points select a module', () => {
  assert.equal(applicationModule('rosewood-oms'), 'oms');
  assert.equal(applicationModule('rosewood-wms'), 'wms');
  assert.equal(applicationModule('rosewood-pim'), 'pim');
  assert.equal(applicationModule('orders'), null);
});

test('fragment state encodes search and SKU safely while document URLs keep a fixed path and empty query', () => {
  const path = `/${project}/rosewood-wms`;
  const term = '香氛 / SKU A&B=2#pack';
  const state = new URLSearchParams({q: term, page: '2', sku: term});
  const location = hashLocation(path, state);
  assert.equal(location.pathname, path);
  assert.equal(location.search, '');
  assert.ok(location.hash.startsWith('#q='));
  assert.equal(readHashState(location).get('q'), term);
  assert.equal(readHashState(location).get('sku'), term);
  const documentUrl = new URL(`${origin}${location.pathname}${location.search}${location.hash}`);
  assert.equal(documentUrl.pathname, path);
  assert.equal(documentUrl.search, '');
  assert.deepEqual(hashLocation(path, new URLSearchParams()), {pathname: path, search: '', hash: ''});
});

test('fragment readers ignore old query-string state and unknown parameters', () => {
  const search = `?q=legacy-query&page=5&record=${id}&sku=legacy-sku`;
  assert.equal(readHashState({search, hash: ''}).toString(), '');
  const current = readHashState({search, hash: '#q=current&page=1&unknown=ignored'});
  assert.equal(current.get('q'), 'current');
  assert.equal(current.get('page'), '1');
  assert.equal(current.has('record'), false);
  assert.equal(current.has('sku'), false);
  assert.equal(current.has('unknown'), false);
});

test('returning from fragment details preserves only list search and page state', () => {
  const hash = new URLSearchParams({q: 'NOTE & PAPER', page: '3', record: id, sku: 'NOTE', unknown: 'ignored'});
  const list = listHashState({hash: `#${hash}`, search: '?q=do-not-read'});
  assert.deepEqual([...list], [['q', 'NOTE & PAPER'], ['page', '3']]);
  assert.equal(listHashState({hash: '#q=NOTE&page=999999&record=bad'}).toString(), 'q=NOTE');
  const target = hashLocation(`/${project}/rosewood-pim`, list);
  assert.equal(target.search, '');
  assert.equal(readHashState(target).has('record'), false);
});

test('WMS transfer and count views survive fixed-path refresh and preserve inventory list context without detail IDs',()=>{
  for(const view of ['transfer','count']){
    const list=listHashState({hash:`#view=${view}&q=SKU&page=2&filter=low&sku=OLD&record=${id}`});
    assert.equal(list.get('view'),view);assert.equal(list.get('q'),'SKU');assert.equal(list.get('page'),'2');assert.equal(list.get('filter'),'low');
    assert.equal(list.has('sku'),false);assert.equal(list.has('record'),false);
    const target=hashLocation(`/${project}/rosewood-wms`,list);
    assert.equal(target.search,'');assert.equal(readHashState(target).get('view'),view);
    list.delete('view');assert.equal(list.get('q'),'SKU');assert.equal(list.get('page'),'2');
  }
  assert.equal(listHashState({hash:'#view=quality&record=bad'}).get('view'),'quality');
  assert.equal(listHashState({hash:'#view=arbitrary&record=bad'}).has('view'),false);
});
