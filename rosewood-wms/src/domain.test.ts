import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHostUrl, productQuality, fulfillmentLines, buildDeliveryAction,
  inventoryChange, errorMessage, type ProductResource, type OrderResource,
} from './domain';

const project = 'rosewood-shop-demorosewood-shop-demo';
const id = '12345678-1234-1234-1234-123456789abc';
const origin = 'https://mc.australia-southeast1.gcp.commercetools.com';

test('host context supports product root, variant inventory and order pages and rejects a different project', () => {
  assert.deepEqual(parseHostUrl(`${origin}/${project}/products/${id}`, project), {
    kind: 'product', id, nativeUrl: `${origin}/${project}/products/${id}`,
  });
  assert.equal(parseHostUrl(`${origin}/${project}/products/${id}/variants/2/inventory`, project).variantId, 2);
  assert.equal(parseHostUrl(`${origin}/${project}/products/${id}/variants/3/inventory/${id}`, project).variantId, 3);
  assert.equal(parseHostUrl(`${origin}/${project}/orders/${id}/shipping-and-delivery`, project).kind, 'order');
  assert.equal(parseHostUrl(`${origin}/another-project/products/${id}`, project).kind, 'unsupported');
  assert.equal(parseHostUrl(`${origin}/${project}/products/${id}/variants/not-a-number`, project).kind, 'unsupported');
  assert.equal(parseHostUrl(`${origin}/${project}/products/not-an-id`, project).kind, 'unsupported');
  assert.equal(parseHostUrl('not a URL', project).kind, 'unsupported');
  assert.equal(parseHostUrl(`http://localhost:3001/${project}/products/${id}`, project).kind, 'product');
});

test('inventory detail host context binds the exact inventory entry ID independently of product or SKU', () => {
  const inventoryId = '87654321-4321-4321-4321-cba987654321';
  const nativeUrl = `${origin}/${project}/products/${id}/variants/3/inventory/${inventoryId}?opsDebug=1`;
  assert.deepEqual(parseHostUrl(nativeUrl, project), {
    kind: 'product', id, variantId: 3, inventoryId, nativeUrl,
  });
  assert.equal(parseHostUrl(`${origin}/${project}/products/${id}/variants/3/inventory`, project).inventoryId, undefined);
  assert.equal(parseHostUrl(`${origin}/${project}/products/${id}/variants/3/inventory/${inventoryId}/`, project).inventoryId, inventoryId);
});

test('inventory detail host context rejects invalid entry IDs, additional detail paths and other projects', () => {
  const inventoryId = '87654321-4321-4321-4321-cba987654321';
  const base = `${origin}/${project}/products/${id}/variants/3/inventory`;
  for (const suffix of ['not-an-id', 'new', `${inventoryId}/edit`, `${inventoryId}/another-entry`, `${inventoryId}%2Fedit`]) {
    assert.deepEqual(parseHostUrl(`${base}/${suffix}`, project), { kind: 'unsupported' });
  }
  assert.deepEqual(parseHostUrl(`${origin}/another-project/products/${id}/variants/3/inventory/${inventoryId}`, project), { kind: 'unsupported' });
});

function product(): ProductResource {
  const data = { name: { en: 'Notebook' }, description: { en: 'A linen notebook' },
    masterVariant: { id: 1, sku: 'NOTE-1', images: [{ url: 'https://example.test/image.png' }],
      prices: [{ value: { centAmount: 1200, currencyCode: 'USD' } }] }, variants: [] };
  return { priceMode: 'Embedded', masterData: { staged: structuredClone(data), current: structuredClone(data), published: true } };
}

test('product readiness checks staged data and compares actual changes without locale key-order noise', () => {
  const value = product();
  assert.deepEqual(productQuality(value), { issues: [], diffs: [], readyToPublish: true });
  value.masterData!.current!.name = { en: 'Notebook', de: 'Buch' };
  value.masterData!.staged!.name = { de: 'Buch', en: 'Notebook' };
  assert.equal(productQuality(value).diffs.length, 0);
  value.masterData!.staged!.description = { en: 'New description' };
  value.masterData!.staged!.masterVariant!.sku = '';
  const report = productQuality(value);
  assert.equal(report.readyToPublish, false);
  assert.ok(report.issues.some(issue => issue.code === 'missing-sku' && issue.severity === 'error'));
  assert.deepEqual(report.diffs.map(diff => diff.field), ['description', 'variant 1.sku']);
  assert.equal(report.diffs[0].current, '{"en":"A linen notebook"}');
});

test('product checks distinguish missing price warnings from duplicate SKU errors and standalone price review', () => {
  const value = product();
  value.masterData!.staged!.masterVariant!.prices = [];
  value.masterData!.staged!.variants = [{ id: 2, sku: 'NOTE-1', images: [] }];
  const report = productQuality(value);
  assert.ok(report.issues.some(issue => issue.code === 'missing-price' && issue.severity === 'warning'));
  assert.ok(report.issues.some(issue => issue.code === 'duplicate-sku' && issue.severity === 'error'));
  assert.ok(report.issues.some(issue => issue.code === 'missing-image'));
  value.priceMode = 'Standalone';
  const standalone = productQuality(value);
  assert.ok(!standalone.issues.some(issue => issue.code === 'missing-price'));
  assert.ok(standalone.issues.some(issue => issue.code === 'standalone-price-review'));
  assert.equal(productQuality({}).readyToPublish, false);
  const freeProduct = product();
  freeProduct.masterData!.staged!.masterVariant!.prices![0].value!.centAmount = 0;
  assert.ok(!productQuality(freeProduct).issues.some(issue => issue.code === 'missing-price'));
});

function order(): OrderResource {
  return { version: 4, orderState: 'Confirmed', shippingMode: 'Single',
    lineItems: [{ id: 'line-1', name: { en: 'Notebook' }, variant: { sku: 'NOTE-1' }, quantity: 5,
      custom: {fields: {rwFulfillmentType: 'physical'}} }],
    customLineItems: [{ id: 'custom-1', name: { en: 'Physical gift box' }, quantity: 2,
      custom: {fields: {rwFulfillmentType: 'physical'}} }],
    shippingInfo: { deliveries: [{ id: 'delivery-1', key: 'previous-delivery',
      items: [{ id: 'line-1', quantity: 2 }], parcels: [{ items: [{ id: 'line-1', quantity: 2 }] }] }] },
  };
}

test('fulfillment quantities count deliveries once, include custom lines and aggregate across shipping records', () => {
  const value = order();
  value.shipping = [{ shippingInfo: { deliveries: [
    { id: 'delivery-2', items: [{ id: 'line-1', quantity: 1 }, { id: 'custom-1', quantity: 1 }] },
  ] } }];
  const lines = fulfillmentLines(value);
  assert.deepEqual(lines.map(line => [line.quantity, line.deliveredQuantity, line.remainingQuantity]), [[5, 3, 2], [2, 1, 1]]);
  assert.equal(lines[1].kind, 'customLineItem');
  value.shippingInfo!.deliveries![0].items = undefined;
  assert.equal(fulfillmentLines(value)[0].deliveredQuantity, 3);
});

test('delivery action includes a parcel, rejects cumulative overshipment and does not mutate the order', () => {
  const value = order();
  const before = JSON.stringify(value);
  const action = buildDeliveryAction(value, { 'line-1': '3', 'custom-1': 1 }, 'TRACK-123', 'DHL', 'new-delivery');
  assert.equal(action.action, 'addDelivery');
  assert.equal(action.deliveryKey, 'new-delivery');
  assert.deepEqual(action.items, [{ id: 'line-1', quantity: 3 }, { id: 'custom-1', quantity: 1 }]);
  assert.deepEqual(action.parcels[0].items, action.items);
  assert.deepEqual(action.parcels[0].trackingData, { trackingId: 'TRACK-123', carrier: 'DHL' });
  assert.equal(JSON.stringify(value), before);
  assert.throws(() => buildDeliveryAction(value, { 'line-1': 4 }, 'T', 'DHL', 'new-delivery'), /remaining 3/);
  assert.throws(() => buildDeliveryAction(value, { 'unknown-line': 1 }, 'T', 'DHL', 'new-delivery'), /no longer exists/);
  assert.throws(() => buildDeliveryAction(value, { 'line-1': 1.5 }, 'T', 'DHL', 'new-delivery'), /whole number/);
  assert.throws(() => buildDeliveryAction(value, { 'line-1': '-1' }, 'T', 'DHL', 'new-delivery'), /whole number/);
  assert.throws(() => buildDeliveryAction(value, { 'line-1': '' }, 'T', 'DHL', 'new-delivery'), /positive delivery/);
  assert.throws(() => buildDeliveryAction(value, { 'line-1': 1 }, '', 'DHL', 'new-delivery'), /Tracking ID/);
  assert.throws(() => buildDeliveryAction(value, { 'line-1': 1 }, 'T', 'DHL', 'previous-delivery'), /already exists/);
});

test('parcel details can be partial but cannot exceed the enclosing delivery quantities',()=>{
  const value=order();
  value.shippingInfo!.deliveries![0].parcels![0].items![0].quantity=1;
  assert.equal(fulfillmentLines(value)[0].deliveredQuantity,2);
  value.shippingInfo!.deliveries![0].parcels![0].items![0].quantity=3;
  assert.throws(()=>fulfillmentLines(value),/parcel quantities exceed/);
});

test('delivery creation fails closed for cancelled orders, multiple shipping, missing shipping and existing excess quantities', () => {
  const value = order();
  const add = () => buildDeliveryAction(value, { 'line-1': 1 }, 'T', 'DHL', 'new-delivery');
  value.orderState = 'Cancelled'; assert.throws(add, /Cancelled/);
  value.orderState = 'Confirmed'; value.shippingMode = 'Multiple'; assert.throws(add, /Single shipping mode/);
  value.shippingMode = 'Single'; const shipping = value.shippingInfo; delete value.shippingInfo; assert.throws(add, /shipping information/);
  value.shippingInfo = shipping; value.shippingInfo!.deliveries![0].items![0].quantity = 6;
  assert.equal(fulfillmentLines(value)[0].overDelivered, true);
  assert.equal(fulfillmentLines(value)[0].remainingQuantity, 0);
  assert.throws(add, /exceed an ordered quantity/);
});

test('inventory preview retains negative observed stock and carries its original version', () => {
  assert.deepEqual(inventoryChange({ quantityOnStock: -2, version: 8 }, '4'), {
    before: -2, after: 4, delta: 6, version: 8, actions: [{ action: 'changeQuantity', quantity: 4 }],
  });
  assert.throws(() => inventoryChange({ quantityOnStock: 2, version: 8 }, '-1'), /non-negative/);
  assert.throws(() => inventoryChange({ quantityOnStock: 2, version: 8 }, '1.5'), /whole number/);
  assert.throws(() => inventoryChange({ quantityOnStock: 2, version: 8 }, ''), /whole number/);
  assert.throws(() => inventoryChange({ quantityOnStock: 2, version: 8 }, Number.MAX_SAFE_INTEGER + 1), /safe integer/);
  assert.throws(() => inventoryChange({ quantityOnStock: 2 }, 4), /version/);
});

test('conflict messages require a reload and keep the update unapplied', () => {
  assert.match(errorMessage({ statusCode: 409 }), /Reload the latest version/);
  assert.match(errorMessage({ body: { errors: [{ code: 'ConcurrentModification' }] } }), /not applied/);
  assert.equal(errorMessage(new Error('Network unavailable')), 'Network unavailable');
});
