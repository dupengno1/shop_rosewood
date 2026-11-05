import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFulfillment, fulfillmentInstructions, type FulfillmentInput} from './fulfillment-classification';
import {buildDeliveryAction, fulfillmentLines, type OrderResource} from './domain';

const metadata = (kind: unknown): FulfillmentInput => ({variant: {attributes: [{name: 'rwProductInfo', value: JSON.stringify({fixture: true, kind})}]}});
const explicit = (value: unknown): FulfillmentInput => ({custom: {fields: {rwFulfillmentType: value}}});

test('known Rosewood custom fee keys always stay non-shippable even if marked physical', () => {
  for (const key of ['rw-tax', 'rw-ddp', 'rw-wrap-order-line']) {
    const result = classifyFulfillment({key, ...metadata('physical'), ...explicit('physical')}, 'customLineItem');
    assert.equal(result.type, 'fee');
    assert.equal(result.source, 'fee-key');
  }
  assert.equal(classifyFulfillment({key: 'rw-tax', ...explicit('physical')}, 'lineItem').type, 'physical');
  assert.equal(classifyFulfillment({key: 'physical-gift-box', ...explicit('physical')}, 'customLineItem').type, 'physical');
});

test('saved order-line fulfillment type takes priority and invalid explicit values never fall back', () => {
  for (const type of ['physical', 'digital', 'service'] as const) {
    const result = classifyFulfillment({...metadata('physical'), ...explicit(type)}, 'lineItem');
    assert.equal(result.type, type);
    assert.equal(result.source, 'order-line-custom');
  }
  for (const value of ['', undefined, null, 'Physical', 'unknown', {key: 'physical'}, ['physical']]) {
    const result = classifyFulfillment({...metadata('physical'), ...explicit(value)}, 'lineItem');
    assert.equal(result.type, 'unknown');
    assert.equal(result.label, '需确认履约类型');
    assert.equal(result.source, 'order-line-custom');
  }
});

test('classification reads the real rwProductInfo text attribute from the order snapshot', () => {
  assert.equal(classifyFulfillment(metadata('physical'), 'lineItem').type, 'physical');
  assert.equal(classifyFulfillment(metadata('digital'), 'lineItem').type, 'digital');
  assert.equal(classifyFulfillment(metadata('donation'), 'lineItem').type, 'service');
  for (const value of ['{broken', 'null', '[]', JSON.stringify({kind: 'unrecognized'}), {kind: 'physical'}]) {
    assert.equal(classifyFulfillment({variant: {attributes: [{name: 'rwProductInfo', value}]}}, 'lineItem').type, 'unknown');
  }
  assert.equal(classifyFulfillment({variant: {attributes: [
    {name: 'rwProductInfo', value: JSON.stringify({kind: 'physical'})},
    {name: 'rwProductInfo', value: JSON.stringify({kind: 'digital'})},
  ]}}, 'lineItem').type, 'unknown');
});

test('names, SKU prefixes, shared product types and inventory fields do not invent a fulfillment type', () => {
  const incomplete = {
    key: 'rw-demo-physical', name: {en: 'Physical product'}, variant: {sku: 'rw-demo-notebook', attributes: [{name: 'kind', value: 'physical'}]},
    productType: {typeId: 'product-type', id: 'shared-rw-shop-type'}, inventoryMode: 'ReserveOnOrder',
    supplyChannel: {typeId: 'channel', id: 'warehouse'}, shippingDetails: {targets: [{addressKey: 'address', quantity: 1}]},
  };
  assert.equal(classifyFulfillment(incomplete, 'lineItem').type, 'unknown');
  assert.equal(classifyFulfillment({variant: {attributes: [{name: 'rwProductInfo', value: JSON.stringify({officialCategoryKeys: ['gifts']})}]}}, 'lineItem').type, 'unknown');
});

function mixedOrder(): OrderResource {
  return {version: 6, orderState: 'Open', shippingMode: 'Single',
    lineItems: [
      {id: 'physical', quantity: 3, name: {en: 'Notebook'}, variant: {sku: 'NOTE', ...metadata('physical').variant}},
      {id: 'digital', quantity: 1, name: {en: 'Electronic card'}, ...metadata('digital')},
      {id: 'service', quantity: 1, name: {en: 'Donation'}, ...metadata('donation')},
      {id: 'unknown', quantity: 1, name: {en: 'Needs classification'}},
    ],
    customLineItems: [
      {id: 'tax', key: 'rw-tax', quantity: 1, ...explicit('physical')},
      {id: 'duty', key: 'rw-ddp', quantity: 1},
      {id: 'wrap', key: 'rw-wrap-physical', quantity: 3},
    ],
    shippingInfo: {deliveries: [{id: 'previous', key: 'previous-delivery', items: [{id: 'physical', quantity: 1}]}]},
  };
}

test('mixed orders only allow positive quantities for confirmed physical lines and retain cumulative checks', () => {
  const order = mixedOrder();
  const before = structuredClone(order);
  const lines = fulfillmentLines(order);
  assert.deepEqual(lines.map(line => line.classification.type), ['physical', 'digital', 'service', 'unknown', 'fee', 'fee', 'fee']);
  assert.equal(lines[0].deliveredQuantity, 1);
  assert.equal(lines[0].remainingQuantity, 2);
  const action = buildDeliveryAction(order, {physical: '2', digital: '0', tax: ''}, 'TRACK-123', 'DHL', 'new-delivery');
  assert.deepEqual(action.items, [{id: 'physical', quantity: 2}]);
  assert.deepEqual(action.parcels[0].items, action.items);
  for (const id of ['digital', 'service', 'unknown', 'tax', 'duty', 'wrap']) {
    assert.throws(() => buildDeliveryAction(order, {physical: 1, [id]: 1}, 'TRACK-123', 'DHL', 'new-delivery'), /不能登记实物发运/);
  }
  assert.throws(() => buildDeliveryAction(order, {physical: 3}, 'TRACK-123', 'DHL', 'new-delivery'), /remaining 2/);
  assert.deepEqual(order, before);
});

test('rebuilding a reviewed action rejects a line whose saved classification changed', () => {
  const order = mixedOrder();
  assert.equal(buildDeliveryAction(order, {physical: 1}, 'TRACK', 'DHL', 'new-delivery').items.length, 1);
  order.lineItems![0].custom = {fields: {rwFulfillmentType: 'digital'}};
  assert.throws(() => buildDeliveryAction(order, {physical: 1}, 'TRACK', 'DHL', 'new-delivery'), /不能登记实物发运/);
});

test('fulfillment instructions display only saved allowlisted values without inventing customization', () => {
  assert.deepEqual(fulfillmentInstructions(metadata('physical')), []);
  const fields = {rwFulfillmentNotes: ' Handle carefully ', rwPersonalization: ' K.D. ', rwPickupLocation: ' Hong Kong ',
    rwPickupDate: '2026-11-07', rwPickupTime: '14:00–15:00', rwGiftWrap: false, rwBundleItems: [' CANDLE ', 'NOTE'],
    recipientEmail: 'not-for-display@example.test', giftCode: 'DO-NOT-DISPLAY'};
  const instructions = fulfillmentInstructions({custom: {fields}});
  assert.deepEqual(instructions, [
    {label: '发运备注', value: 'Handle carefully'}, {label: '定制内容', value: 'K.D.'},
    {label: '领取地点', value: 'Hong Kong'}, {label: '领取日期', value: '2026-11-07'}, {label: '领取时段', value: '14:00–15:00'},
    {label: '礼品包装', value: '不需要'}, {label: '礼篮组件', value: 'CANDLE、NOTE'},
  ]);
  assert.ok(!JSON.stringify(instructions).includes('DO-NOT-DISPLAY'));
  assert.ok(!JSON.stringify(instructions).includes('@'));
  assert.deepEqual(fulfillmentInstructions({custom: {fields: {rwPersonalization: {}, rwGiftWrap: 'yes', rwBundleItems: [1]}}}), []);
});
