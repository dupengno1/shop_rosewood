import test from 'node:test';
import assert from 'node:assert/strict';
import {executeInventoryStep, resumeInventoryStep, inspectInventoryReceipt, type WorkflowInventory, type InventoryWorkflowValue} from './inventory-workflow';
import {type OperationApi, type OperationDocument} from './operation-store';
import {INVENTORY_ADJUSTMENT_TYPE_ID} from './inventory-adjustment';
const key = '11111111-1111-4111-8111-111111111111';
const inventoryId = '22222222-2222-4222-8222-222222222222';
const stepId = '33333333-3333-4333-8333-333333333333';
const secondStep = '44444444-4444-4444-8444-444444444444';
const stamp = '2026-11-05T06:00:00.000Z';
type Value = {status: string; unrelated: string};
function fixture() {
  let document: OperationDocument<InventoryWorkflowValue<Value>> = {id: key, key, container: 'rw-mc-wms-operations', version: 1, createdAt: stamp, lastModifiedAt: stamp, value: {status: 'planned', unrelated: 'keep'}};
  let inventory: WorkflowInventory = {id: inventoryId, version: 7, sku: 'QA', quantityOnStock: 10, availableQuantity: 10};
  const writes: {path: string; body: any}[] = [];
  let loseStockResponse = false, failStockBeforeWrite = false, failConfirmation = false, loseConfirmationResponse = false, conflictIntent = false;
  const api: OperationApi = async <T>(path: string, body?: unknown): Promise<T> => {
    if (!body) {
      if (path === `inventory/${inventoryId}`) return structuredClone(inventory) as T;
      if (path === `custom-objects/${document.container}/${document.key}`) return structuredClone(document) as T;
      throw Object.assign(new Error('missing'), {status: 404});
    }
    const request = body as any; writes.push({path, body: structuredClone(body)});
    if (path === 'custom-objects') {
      if (request.version !== document.version || conflictIntent) throw Object.assign(new Error('version'), {status: 409});
      const confirming = !request.value.pending;
      if (confirming && failConfirmation) throw new Error('network before commit');
      document = {...document, version: document.version + 1, value: structuredClone(request.value)};
      if (confirming && loseConfirmationResponse) throw new Error('lost confirmation response');
      return structuredClone(document) as T;
    }
    assert.equal(path, `inventory/${inventoryId}`);
    if (request.version !== inventory.version) throw Object.assign(new Error('version'), {status: 409});
    if (failStockBeforeWrite) throw new Error('network before stock write');
    for (const action of request.actions) {
      if (action.action === 'changeQuantity') inventory.quantityOnStock = action.quantity;
      else if (action.action === 'addQuantity') inventory.quantityOnStock += action.quantity;
      else if (action.action === 'removeQuantity') inventory.quantityOnStock -= action.quantity;
      else if (action.action === 'setCustomType') inventory.custom = {type: action.type, fields: structuredClone(action.fields)};
      else if (action.action === 'setCustomField') {
        if (action.value === undefined) delete inventory.custom!.fields![action.name];
        else inventory.custom!.fields![action.name] = action.value;
      }
    }
    inventory.version!++; inventory.availableQuantity = inventory.quantityOnStock;
    if (loseStockResponse) throw new Error('lost stock response');
    return structuredClone(inventory) as T;
  };
  return {api, writes, get document() {return structuredClone(document);}, get inventory() {return structuredClone(inventory);},
    set inventory(value: WorkflowInventory) {inventory = value;},
    set loseStockResponse(value: boolean) {loseStockResponse = value;},
    set failStockBeforeWrite(value: boolean) {failStockBeforeWrite = value;},
    set failConfirmation(value: boolean) {failConfirmation = value;},
    set loseConfirmationResponse(value: boolean) {loseConfirmationResponse = value;},
    set conflictIntent(value: boolean) {conflictIntent = value;},
  };
}
const input = (f: ReturnType<typeof fixture>, id = stepId) => ({stepId: id, inventory: f.inventory, action: {action: 'removeQuantity' as const, quantity: 2}, reason: 'reconcile', note: 'QA transfer', reference: 'QA-1', nextValue: {status: 'in_transit', unrelated: 'keep'}});

test('inventory step persists fixed intent before one atomic stock/receipt write then confirms business value', async () => {
  const f = fixture(); const result = await executeInventoryStep(f.api, f.document, input(f));
  assert.equal(result.state, 'complete'); assert.equal(result.document.value.pending, undefined);
  assert.equal(result.document.value.status, 'in_transit'); assert.equal(result.document.value.unrelated, 'keep');
  assert.deepEqual(f.writes.map(call => call.path), ['custom-objects', `inventory/${inventoryId}`, 'custom-objects']);
  const pending = f.writes[0].body.value.pending;
  assert.deepEqual([pending.inventoryId, pending.expectedVersion, pending.before, pending.after, pending.delta], [inventoryId, 7, 10, 8, -2]);
  const write = f.writes[1].body;
  assert.equal(write.version, 7); assert.deepEqual(write.actions[0], {action: 'removeQuantity', quantity: 2});
  assert.equal(write.actions[1].fields.rwWorkflowReceipt, stepId);
  assert.equal(write.actions[1].fields.rwWorkflowDocument, `rw-mc-wms-operations/${key}`);
  assert.equal(f.inventory.quantityOnStock, 8);
  assert.equal((await inspectInventoryReceipt(f.api, f.inventory)).blocked, false);
  const repeated = await executeInventoryStep(f.api, result.document, input(f));
  assert.equal(repeated.state, 'complete'); assert.equal(f.writes.length, 3);
});
test('lost stock response is proven by receipt and never applied twice', async () => {
  const f = fixture(); f.loseStockResponse = true;
  const result = await executeInventoryStep(f.api, f.document, input(f));
  assert.equal(result.state, 'complete'); assert.equal(f.inventory.quantityOnStock, 8);
  assert.equal(f.writes.filter(call => call.path.startsWith('inventory/')).length, 1);
});
test('unapplied ambiguous request requires explicit same-version resend, and blocks a second pending step', async () => {
  const f = fixture(); f.failStockBeforeWrite = true;
  const result = await executeInventoryStep(f.api, f.document, input(f));
  assert.equal(result.state, 'retry-allowed'); assert.ok(f.document.value.pending);
  const writeCount = f.writes.length;
  assert.equal((await resumeInventoryStep(f.api, f.document)).state, 'retry-allowed'); assert.equal(f.writes.length, writeCount);
  await assert.rejects(executeInventoryStep(f.api, f.document, input(f, secondStep)), /待确认/);
  f.failStockBeforeWrite = false;
  const recovered = await resumeInventoryStep(f.api, f.document, {retryIfUnchanged: true, expectedStepId: f.document.value.pending!.stepId, expectedDocumentVersion: f.document.version});
  assert.equal(recovered.state, 'complete');
  const attempts = f.writes.filter(call => call.path.startsWith('inventory/'));
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].body, attempts[1].body);
});
test('changed inventory without our receipt requires review and cannot retry using its new version', async () => {
  const f = fixture(); f.failStockBeforeWrite = true;
  await executeInventoryStep(f.api, f.document, input(f));
  f.inventory = {...f.inventory, version: 8, quantityOnStock: 9}; f.failStockBeforeWrite = false;
  const result = await resumeInventoryStep(f.api, f.document, {retryIfUnchanged: true, expectedStepId: f.document.value.pending!.stepId, expectedDocumentVersion: f.document.version});
  assert.equal(result.state, 'needs-review'); assert.equal(f.document.value.pending?.status, 'needs-review');
  assert.equal(f.writes.filter(call => call.path.startsWith('inventory/')).length, 1);
});
test('unconfirmed inventory receipt blocks manual updates and recovers final document without changing stock', async () => {
  const f = fixture(); f.failConfirmation = true;
  const first = await executeInventoryStep(f.api, f.document, input(f));
  assert.equal(first.state, 'needs-review'); assert.equal((await inspectInventoryReceipt(f.api, f.inventory)).blocked, true);
  const count = f.writes.filter(call => call.path.startsWith('inventory/')).length;
  f.failConfirmation = false;
  const result = await resumeInventoryStep(f.api, f.document);
  assert.equal(result.state, 'complete'); assert.equal(f.writes.filter(call => call.path.startsWith('inventory/')).length, count);
  assert.equal((await inspectInventoryReceipt(f.api, f.inventory)).blocked, false);
});
test('lost confirmation response resolves by read without another write or duplicate history', async () => {
  const f = fixture(); f.loseConfirmationResponse = true;
  const result = await executeInventoryStep(f.api, f.document, input(f));
  assert.equal(result.state, 'complete'); assert.equal(f.writes.length, 3); assert.equal(result.document.value.inventorySteps?.length, 1);
});
test('confirmed prior receipt can be superseded while preserving unrelated same-type custom fields', async () => {
  const f = fixture(); f.inventory = {...f.inventory, custom: {type: {id: INVENTORY_ADJUSTMENT_TYPE_ID}, fields: {businessTag: 'preserve'}}};
  await executeInventoryStep(f.api, f.document, input(f));
  f.failStockBeforeWrite = true;
  await executeInventoryStep(f.api, f.document, input(f, secondStep));
  assert.equal((await inspectInventoryReceipt(f.api, f.inventory)).blocked, true);
  f.failStockBeforeWrite = false;
  assert.equal((await resumeInventoryStep(f.api, f.document, {retryIfUnchanged: true, expectedStepId: f.document.value.pending!.stepId, expectedDocumentVersion: f.document.version})).state, 'complete');
  assert.equal(f.inventory.quantityOnStock, 6); assert.equal(f.inventory.custom?.fields?.businessTag, 'preserve');
  assert.equal(f.document.value.inventorySteps?.length, 2);
});
test('foreign types, malformed receipts, stale snapshots and document conflicts fail before stock writes', async () => {
  const a = fixture(); a.inventory = {...a.inventory, custom: {type: {id: key}, fields: {businessTag: 'preserve'}}};
  await assert.rejects(executeInventoryStep(a.api, a.document, input(a)), /其他 Custom Type/); assert.equal(a.writes.length, 0);
  const b = fixture(); b.inventory = {...b.inventory, custom: {type: {id: INVENTORY_ADJUSTMENT_TYPE_ID}, fields: {rwWorkflowReceipt: stepId}}};
  assert.equal((await inspectInventoryReceipt(b.api, b.inventory)).blocked, true);
  await assert.rejects(executeInventoryStep(b.api, b.document, input(b))); assert.equal(b.writes.length, 0);
  const c = fixture(); const original = input(c); c.inventory = {...c.inventory, version: 8};
  await assert.rejects(executeInventoryStep(c.api, c.document, original), /库存已变化/); assert.equal(c.writes.length, 0);
  const d = fixture(); d.conflictIntent = true;
  await assert.rejects(executeInventoryStep(d.api, d.document, input(d)));
  assert.equal(d.writes.filter(call => call.path.startsWith('inventory/')).length, 0);
});
test('source deduction rechecks authoritative availability both before intent and explicit recovery', async () => {
  for (const availableQuantity of [undefined, 1]) {
    const f = fixture(); f.inventory = {...f.inventory, availableQuantity};
    await assert.rejects(executeInventoryStep(f.api, f.document, input(f)), /可用库存不足或未知/);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture(); f.failStockBeforeWrite = true;
  await executeInventoryStep(f.api, f.document, input(f));
  f.failStockBeforeWrite = false; f.inventory = {...f.inventory, availableQuantity: 1};
  const result = await resumeInventoryStep(f.api, f.document, {retryIfUnchanged: true, expectedStepId: f.document.value.pending!.stepId, expectedDocumentVersion: f.document.version});
  assert.equal(result.state, 'needs-review');
  assert.equal(f.writes.filter(call => call.path.startsWith('inventory/')).length, 1);
});
test('an old UI confirmation cannot resend a newer pending step or changed document', async () => {
  const f = fixture(); f.failStockBeforeWrite = true;
  await executeInventoryStep(f.api, f.document, input(f));
  const shown = f.document;
  const confirmation = {retryIfUnchanged: true, expectedStepId: shown.value.pending!.stepId, expectedDocumentVersion: shown.version};
  f.failStockBeforeWrite = false;
  await resumeInventoryStep(f.api, shown, confirmation);
  f.failStockBeforeWrite = true;
  await executeInventoryStep(f.api, f.document, input(f, secondStep));
  const before = f.writes.length;
  await assert.rejects(resumeInventoryStep(f.api, shown, confirmation), /步骤已变化/);
  assert.equal(f.writes.length, before);
  assert.equal(f.document.value.pending?.stepId, secondStep);
  assert.equal(f.inventory.quantityOnStock, 8);
  const sameStepShown = f.document;
  await f.api('custom-objects', {container: sameStepShown.container, key: sameStepShown.key, version: sameStepShown.version, value: sameStepShown.value});
  const writesAfterDocumentChange = f.writes.length;
  await assert.rejects(resumeInventoryStep(f.api, sameStepShown, {retryIfUnchanged: true, expectedStepId: secondStep, expectedDocumentVersion: sameStepShown.version}), /步骤已变化/);
  assert.equal(f.writes.length, writesAfterDocumentChange);
  await assert.rejects(resumeInventoryStep(f.api, f.document, {retryIfUnchanged: true}));
});
