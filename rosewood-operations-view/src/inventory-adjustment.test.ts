import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INVENTORY_ADJUSTMENT_TYPE_ID, buildInventoryAdjustment, inventoryAdjustmentBlock,
  latestInventoryAdjustment, previewInventoryAdjustment, type InventoryAdjustmentEntry,
} from './inventory-adjustment';

const at = new Date('2026-11-05T05:00:00.000Z');
const otherType = 'aaaa1111-bbbb-cccc-dddd-eeee22223333';
const entry = (custom?: InventoryAdjustmentEntry['custom']): InventoryAdjustmentEntry => ({
  version: 7, quantityOnStock: 10, ...(custom ? {custom} : {}),
});

test('inventory adjustment requires a supported reason and a note for other', () => {
  const row = entry();
  for (const reason of ['', ' ', 'unknown']) {
    assert.throws(() => previewInventoryAdjustment(row, '11', {reason}), /请选择调整原因/);
  }
  assert.throws(() => previewInventoryAdjustment(row, '11', {reason: 'other', note: ' '}), /必须填写调整说明/);
  const preview = previewInventoryAdjustment(row, '11', {reason: ' count ', note: ' 实盘核对 ', reference: ' COUNT-001 '});
  assert.equal(preview.reason, 'count');
  assert.equal(preview.note, '实盘核对');
  assert.equal(preview.reference, 'COUNT-001');
  assert.equal(preview.before, 10);
  assert.equal(preview.after, 11);
  assert.equal(preview.delta, 1);
  assert.equal(preview.version, 7);
});

test('inventory adjustment rejects excessive lengths and control characters without silently trimming them away', () => {
  const row = entry();
  assert.throws(() => previewInventoryAdjustment(row, 11, {reason: 'count', note: 'x'.repeat(501)}), /500/);
  assert.throws(() => previewInventoryAdjustment(row, 11, {reason: 'count', reference: 'x'.repeat(121)}), /120/);
  for (const control of ['\n', '\t', '\u0000', '\u007f', '\u0085', '\u202e', '\u2066']) {
    assert.throws(() => previewInventoryAdjustment(row, 11, {reason: 'count', note: `${control}text`}), /控制字符/);
    assert.throws(() => previewInventoryAdjustment(row, 11, {reason: 'count', reference: `REF${control}`}), /控制字符/);
  }
  assert.doesNotThrow(() => previewInventoryAdjustment(row, 11, {reason: 'other', note: '中'.repeat(500), reference: 'R'.repeat(120)}));
});

test('a first adjustment writes quantity and its registered Custom Type in one versioned request', () => {
  assert.match(INVENTORY_ADJUSTMENT_TYPE_ID, /^[0-9a-f-]{36}$/i);
  const row = entry();
  const original = structuredClone(row);
  const preview = previewInventoryAdjustment(row, 11, {reason: 'count', note: 'Count verified', reference: 'COUNT-001'});
  assert.deepEqual(buildInventoryAdjustment(row, preview, at), {
    version: 7,
    actions: [
      {action: 'changeQuantity', quantity: 11},
      {action: 'setCustomType', type: {typeId: 'type', id: INVENTORY_ADJUSTMENT_TYPE_ID}, fields: {
        rwAdjustmentReason: 'count', rwAdjustmentAt: at.toISOString(), rwAdjustmentBefore: 10, rwAdjustmentAfter: 11,
        rwAdjustmentNote: 'Count verified', rwAdjustmentReference: 'COUNT-001',
      }},
    ],
  });
  assert.deepEqual(row, original);
});

test('same-type adjustments update only owned fields and clear omitted prior note/reference without replacing other data', () => {
  const row = entry({type: {id: INVENTORY_ADJUSTMENT_TYPE_ID}, fields: {
    businessTag: 'keep-me', rwAdjustmentReason: 'count', rwAdjustmentNote: 'Previous count', rwAdjustmentReference: 'OLD-001',
  }});
  const original = structuredClone(row);
  const preview = previewInventoryAdjustment(row, 9, {reason: 'damage'});
  const update = buildInventoryAdjustment(row, preview, at);
  assert.equal(update.version, 7);
  assert.deepEqual(update.actions[0], {action: 'changeQuantity', quantity: 9});
  assert.ok(update.actions.slice(1).every(action => action.action === 'setCustomField'));
  const customActions = update.actions.filter(action => action.action === 'setCustomField');
  assert.ok(!customActions.some(action => action.name === 'businessTag'));
  assert.deepEqual(customActions.filter(action => action.name === 'rwAdjustmentNote' || action.name === 'rwAdjustmentReference'), [
    {action: 'setCustomField', name: 'rwAdjustmentNote'},
    {action: 'setCustomField', name: 'rwAdjustmentReference'},
  ]);
  assert.deepEqual(row, original);
  const emptyFields = entry({type: {id: INVENTORY_ADJUSTMENT_TYPE_ID}, fields: {businessTag: 'keep-me'}});
  const updateWithoutRemovals = buildInventoryAdjustment(emptyFields, previewInventoryAdjustment(emptyFields, 9, {reason: 'damage'}), at);
  assert.ok(!updateWithoutRemovals.actions.some(action => action.action === 'setCustomField' && action.value === undefined));
});

test('another Custom Type is blocked both at preview and at confirmation and is never replaced', () => {
  const row = entry({type: {id: otherType}, fields: {businessTag: 'preserve'}});
  const original = structuredClone(row);
  assert.match(inventoryAdjustmentBlock(row)!, /其他 Custom Type/);
  assert.throws(() => previewInventoryAdjustment(row, 11, {reason: 'count'}), /其他 Custom Type/);
  const validPreview = previewInventoryAdjustment(entry(), 11, {reason: 'count'});
  assert.throws(() => buildInventoryAdjustment(row, validPreview, at), /其他 Custom Type/);
  assert.throws(() => previewInventoryAdjustment(entry({type: {}, fields: {}}), 11, {reason: 'count'}), /其他 Custom Type/);
  assert.deepEqual(row, original);
});

test('unchanged quantities, stale previews and invalid timestamps cannot create adjustment records', () => {
  const row = entry();
  assert.throws(() => previewInventoryAdjustment(row, '10', {reason: 'count'}), /没有变化/);
  const preview = previewInventoryAdjustment(row, 11, {reason: 'reconcile'});
  assert.throws(() => buildInventoryAdjustment({...row, version: 8}, preview, at), /重新预览/);
  assert.throws(() => buildInventoryAdjustment({...row, quantityOnStock: 9}, preview, at), /重新预览/);
  // After an uncertain request has already applied, re-reading 11 cannot repeat the same adjustment.
  assert.throws(() => previewInventoryAdjustment({...row, version: 8, quantityOnStock: 11}, 11, {reason: 'reconcile'}), /没有变化/);
  assert.throws(() => buildInventoryAdjustment(row, preview, new Date('invalid')), /时间无效/);
});

test('latest adjustment reads only this Custom Type and does not fabricate a ledger from unrelated fields', () => {
  const row = entry({type: {id: INVENTORY_ADJUSTMENT_TYPE_ID}, fields: {
    rwAdjustmentReason: 'return', rwAdjustmentAt: at.toISOString(), rwAdjustmentBefore: 9, rwAdjustmentAfter: 10,
    rwAdjustmentReference: 'RMA-1', unrelated: {private: 'not-displayed'},
  }});
  assert.deepEqual(latestInventoryAdjustment(row), {reason: '退货入库', at: at.toISOString(), before: 9, after: 10, note: '', reference: 'RMA-1'});
  assert.equal(latestInventoryAdjustment(entry({type: {id: otherType}, fields: row.custom!.fields})), undefined);
  assert.equal(latestInventoryAdjustment(entry()), undefined);
});
