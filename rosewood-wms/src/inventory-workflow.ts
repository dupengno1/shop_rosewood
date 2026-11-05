import {buildInventoryAdjustment, previewInventoryAdjustment, INVENTORY_ADJUSTMENT_TYPE_ID, type InventoryAdjustmentEntry} from './inventory-adjustment';
import {readOperation, updateOperation, validateOperationKey, operationStatus, type OperationApi, type OperationDocument} from './operation-store';

export type WorkflowInventory = InventoryAdjustmentEntry & {id: string; sku?: string; availableQuantity?: number};
export type InventoryQuantityAction = {action: 'changeQuantity' | 'addQuantity' | 'removeQuantity'; quantity: number};
export type ConfirmedInventoryStep = {
  stepId: string; inventoryId: string; expectedVersion: number; before: number; after: number; delta: number;
  action: InventoryQuantityAction; status: 'confirmed'; resultVersion: number; observedQuantity: number; confirmedAt: string;
};
export type PendingInventoryStep<T extends object> = {
  stepId: string; inventoryId: string; expectedVersion: number; before: number; after: number; delta: number;
  action: InventoryQuantityAction; reason: string; note: string; reference: string; preparedAt: string;
  nextValue: T; status: 'pending' | 'needs-review'; message?: string;
};
export type InventoryWorkflowValue<T extends object = Record<string, unknown>> = T & {
  pending?: PendingInventoryStep<T>; inventorySteps?: ConfirmedInventoryStep[];
};
export type InventoryStepInput<T extends object> = {
  stepId: string; inventory: WorkflowInventory; action: InventoryQuantityAction;
  reason: string; note?: string; reference?: string; nextValue: T;
};
export type InventoryWorkflowResult<T extends object> = {
  document: OperationDocument<InventoryWorkflowValue<T>>;
  state: 'complete' | 'retry-allowed' | 'needs-review'; message?: string;
};
const docReference = (document: Pick<OperationDocument, 'container' | 'key'>) => `${document.container}/${document.key}`;
function asWorkflow<T extends object>(document: OperationDocument<T>): OperationDocument<InventoryWorkflowValue<T>> {
  return document as OperationDocument<InventoryWorkflowValue<T>>;
}
function businessValue<T extends object>(value: T): T {
  const result = JSON.parse(JSON.stringify(value));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('库存业务单据内容无效。');
  delete result.pending; delete result.inventorySteps; return result;
}
function checkDocument(document: Pick<OperationDocument, 'container' | 'key'>): void {
  if (!['rw-mc-wms-operations', 'rw-mc-oms-operations'].includes(document.container)) throw new Error('此单据不能执行库存步骤。');
  validateOperationKey(document.key);
}
type Receipt = {stepId: string; document: string};
function receipt(entry: WorkflowInventory): Receipt | undefined {
  const fields = entry.custom?.fields || {};
  if (fields.rwWorkflowReceipt === undefined && fields.rwWorkflowDocument === undefined) return undefined;
  if (entry.custom?.type?.id !== INVENTORY_ADJUSTMENT_TYPE_ID || typeof fields.rwWorkflowReceipt !== 'string' || typeof fields.rwWorkflowDocument !== 'string') throw new Error('库存工作流回执格式不明，需人工核对。');
  validateOperationKey(fields.rwWorkflowReceipt);
  return {stepId: fields.rwWorkflowReceipt, document: fields.rwWorkflowDocument};
}
function receiptReference(value: string): {container: string; key: string} {
  const parts = value.split('/');
  if (parts.length !== 2 || !['rw-mc-wms-operations', 'rw-mc-oms-operations'].includes(parts[0])) throw new Error('库存工作流回执引用无效。');
  validateOperationKey(parts[1]); return {container: parts[0], key: parts[1]};
}
function confirmedSteps<T extends object>(document: OperationDocument<InventoryWorkflowValue<T>>): ConfirmedInventoryStep[] {
  const rows = document.value.inventorySteps;
  if (rows !== undefined && !Array.isArray(rows)) throw new Error('库存步骤历史格式无效。');
  return rows || [];
}
function hasConfirmedReceipt<T extends object>(document: OperationDocument<InventoryWorkflowValue<T>>, entry: WorkflowInventory, previous: Receipt): boolean {
  if (previous.document !== docReference(document)) return false;
  const proof = confirmedSteps(document).find(step => step.stepId === previous.stepId && step.inventoryId === entry.id && step.status === 'confirmed');
  return Boolean(proof && Number.isSafeInteger(proof.resultVersion) && proof.resultVersion > proof.expectedVersion && entry.version! >= proof.resultVersion);
}
export async function inspectInventoryReceipt(api: OperationApi, entry: WorkflowInventory): Promise<{blocked: boolean; message?: string}> {
  try {
    const previous = receipt(entry);
    if (!previous) return {blocked: false};
    const ref = receiptReference(previous.document);
    const document = await readOperation<InventoryWorkflowValue>(api, ref.container, ref.key);
    if (!document) return {blocked: true, message: '库存回执的业务单据不存在，请人工核对。'};
    if (document.value.pending?.inventoryId === entry.id) return {blocked: true, message: '此库存的业务步骤尚未确认，请先恢复原单据。'};
    if (!hasConfirmedReceipt(document, entry, previous)) return {blocked: true, message: '原单据没有可核实的库存确认记录，禁止覆盖回执。'};
    return {blocked: false};
  } catch { return {blocked: true, message: '无法核实库存回执，请重新读取原业务单据，暂不能更正库存。'}; }
}
function checkInventory(entry: WorkflowInventory, id: string): void {
  validateOperationKey(id);
  if (!entry || entry.id !== id || !Number.isSafeInteger(entry.version) || entry.version! < 1 || !Number.isSafeInteger(entry.quantityOnStock)) throw new Error('库存响应与目标记录不符或没有有效版本。');
}
function calculate(entry: WorkflowInventory, action: InventoryQuantityAction): number {
  if (!['changeQuantity', 'addQuantity', 'removeQuantity'].includes(action.action) || !Number.isSafeInteger(action.quantity) || action.quantity < 0 || (action.action !== 'changeQuantity' && action.quantity === 0)) throw new Error('库存步骤数量无效。');
  const after = action.action === 'changeQuantity' ? action.quantity : entry.quantityOnStock + (action.action === 'addQuantity' ? action.quantity : -action.quantity);
  if (!Number.isSafeInteger(after) || after < 0 || after === entry.quantityOnStock) throw new Error('库存步骤必须有有效的非零变化，且结果不能小于零。');
  return after;
}
function availableForRemoval(entry: WorkflowInventory, action: InventoryQuantityAction): boolean {
  return action.action !== 'removeQuantity' || (Number.isSafeInteger(entry.availableQuantity) && entry.availableQuantity! >= action.quantity && entry.quantityOnStock >= action.quantity);
}
function checkPending<T extends object>(pending: PendingInventoryStep<T>): void {
  validateOperationKey(pending.stepId); validateOperationKey(pending.inventoryId);
  if (!Number.isSafeInteger(pending.expectedVersion) || pending.expectedVersion < 1 || !Number.isSafeInteger(pending.before) ||
    !Number.isSafeInteger(pending.after) || pending.after < 0 || pending.delta !== pending.after - pending.before || !Number.isSafeInteger(pending.delta) || !Number.isFinite(Date.parse(pending.preparedAt))) throw new Error('库存步骤意图无效，需人工核对。');
  if (calculate({id: pending.inventoryId, version: pending.expectedVersion, quantityOnStock: pending.before}, pending.action) !== pending.after) throw new Error('库存步骤与原先意图不符。');
}
function inventoryPayload<T extends object>(document: OperationDocument<InventoryWorkflowValue<T>>, inventory: WorkflowInventory) {
  const pending = document.value.pending!; checkPending(pending);
  const preview = previewInventoryAdjustment(inventory, pending.after, pending);
  const update = buildInventoryAdjustment(inventory, preview, new Date(pending.preparedAt));
  // Explicit recovery reuses the persisted timestamp, quantity action and receipt.
  const actions: unknown[] = [{...pending.action}];
  for (const action of update.actions.slice(1)) actions.push(action.action === 'setCustomType' ? {...action, fields: {...action.fields,
    rwWorkflowReceipt: pending.stepId, rwWorkflowDocument: docReference(document)}} : action);
  if (inventory.custom) actions.push(
    {action: 'setCustomField', name: 'rwWorkflowReceipt', value: pending.stepId},
    {action: 'setCustomField', name: 'rwWorkflowDocument', value: docReference(document)},
  );
  return {version: pending.expectedVersion, actions};
}
async function finish<T extends object>(api: OperationApi, document: OperationDocument<InventoryWorkflowValue<T>>, inventory: WorkflowInventory): Promise<InventoryWorkflowResult<T>> {
  const pending = document.value.pending!;
  const proof = receipt(inventory);
  if (proof?.stepId !== pending.stepId || proof.document !== docReference(document) || inventory.version! <= pending.expectedVersion) throw new Error('缺少本步骤的原子库存回执，不能确认。');
  const result: ConfirmedInventoryStep = {stepId: pending.stepId, inventoryId: pending.inventoryId, expectedVersion: pending.expectedVersion,
    before: pending.before, after: pending.after, delta: pending.delta, action: pending.action, status: 'confirmed',
    resultVersion: inventory.version!, observedQuantity: inventory.quantityOnStock, confirmedAt: new Date().toISOString()};
  const value: InventoryWorkflowValue<T> = {...businessValue(pending.nextValue), inventorySteps: [...confirmedSteps(document), result]};
  try { return {document: await updateOperation(api, document, value), state: 'complete'}; }
  catch {
    // Resolve a lost CustomObject response by reading, never by replaying the write.
    try {
      const fresh = await readOperation<InventoryWorkflowValue<T>>(api, document.container, document.key);
      if (fresh && !fresh.value.pending && confirmedSteps(fresh).some(step => step.stepId === pending.stepId && step.inventoryId === pending.inventoryId && step.status === 'confirmed')) return {document: fresh, state: 'complete'};
    } catch { /* retain the durable pending intent */ }
    return {document, state: 'needs-review', message: '库存回执已确认，但单据结果尚未确认。请重新打开并核对；不要再写库存。'};
  }
}
async function reviewRequired<T extends object>(api: OperationApi, document: OperationDocument<InventoryWorkflowValue<T>>, message: string): Promise<InventoryWorkflowResult<T>> {
  const pending = document.value.pending!;
  if (pending.status === 'needs-review' && pending.message === message) return {document, state: 'needs-review', message};
  try { document = await updateOperation(api, document, {...document.value, pending: {...pending, status: 'needs-review', message}}); }
  catch { /* competing changes must be reloaded, never overwritten */ }
  return {document, state: 'needs-review', message};
}
async function reconcile<T extends object>(api: OperationApi, document: OperationDocument<InventoryWorkflowValue<T>>, inventory?: WorkflowInventory): Promise<InventoryWorkflowResult<T>> {
  const pending = document.value.pending;
  if (!pending) return {document, state: 'complete'};
  checkPending(pending);
  try {
    inventory ??= await api<WorkflowInventory>(`inventory/${pending.inventoryId}`); checkInventory(inventory, pending.inventoryId);
    const proof = receipt(inventory);
    if (proof?.stepId === pending.stepId && proof.document === docReference(document)) return await finish(api, document, inventory);
    if (inventory.version === pending.expectedVersion && inventory.quantityOnStock === pending.before) {
      const previous = await inspectInventoryReceipt(api, inventory);
      // A previous confirmed receipt on this document is allowed while its next intent is pending.
      if (previous.blocked && (!proof || !hasConfirmedReceipt(document, inventory, proof))) return reviewRequired(api, document, previous.message!);
      if (pending.status === 'needs-review') return {document, state: 'needs-review', message: pending.message || '本步骤需要人工核对，不能直接重送。'};
      return {document, state: 'retry-allowed', message: '未发现本步骤回执且库存版本、数量仍与原意图一致；可由操作员显式重送原步骤。'};
    }
    return reviewRequired(api, document, '库存版本或数量已变化，但没有本步骤回执。禁止使用新版本重试，请人工核对。');
  } catch { return {document, state: 'needs-review', message: '暂时无法读取并核实库存结果。原步骤仍保留；重新读取后再决定，不会自动重试。'}; }
}
async function applyPending<T extends object>(api: OperationApi, document: OperationDocument<InventoryWorkflowValue<T>>, inventory: WorkflowInventory): Promise<InventoryWorkflowResult<T>> {
  const pending = document.value.pending!;
  if (inventory.version !== pending.expectedVersion || inventory.quantityOnStock !== pending.before) return reconcile(api, document, inventory);
  if (!availableForRemoval(inventory, pending.action)) return reviewRequired(api, document, '当前可用库存不足或未知，不能执行源仓扣减。原步骤已保留，请人工核对。');
  try {
    const updated = await api<WorkflowInventory>(`inventory/${pending.inventoryId}`, inventoryPayload(document, inventory));
    checkInventory(updated, pending.inventoryId); return await reconcile(api, document, updated);
  } catch (error) {
    const status = operationStatus(error);
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) return reviewRequired(api, document, '库存写入被拒绝。原意图已保留，请核对权限、字段和业务条件后处理。');
    return reconcile(api, document);
  }
}
export async function executeInventoryStep<T extends object>(api: OperationApi, original: OperationDocument<T>, input: InventoryStepInput<T>): Promise<InventoryWorkflowResult<T>> {
  checkDocument(original); validateOperationKey(input.stepId); checkInventory(input.inventory, input.inventory.id);
  let document = asWorkflow(original);
  const previous = confirmedSteps(document).find(step => step.stepId === input.stepId);
  if (previous) {
    if (previous.inventoryId !== input.inventory.id || previous.action.action !== input.action.action || previous.action.quantity !== input.action.quantity) throw new Error('步骤 ID 已被其他库存动作使用。');
    return {document, state: 'complete'};
  }
  if (document.value.pending) {
    if (document.value.pending.stepId !== input.stepId) throw new Error('此单据仍有待确认库存步骤，请先恢复原步骤。');
    return resumeInventoryStep(api, document);
  }
  const inventory = await api<WorkflowInventory>(`inventory/${input.inventory.id}`); checkInventory(inventory, input.inventory.id);
  if (inventory.version !== input.inventory.version || inventory.quantityOnStock !== input.inventory.quantityOnStock) throw new Error('库存已变化，请重新读取并预览；不会改用新版本自动执行。');
  const guard = await inspectInventoryReceipt(api, inventory); if (guard.blocked) throw new Error(guard.message);
  const after = calculate(inventory, input.action);
  if (!availableForRemoval(inventory, input.action)) throw new Error('当前可用库存不足或未知，请重新核对源仓库存。');
  const preview = previewInventoryAdjustment(inventory, after, input);
  const pending: PendingInventoryStep<T> = {stepId: input.stepId, inventoryId: inventory.id, expectedVersion: preview.version,
    before: preview.before, after, delta: preview.delta, action: {...input.action}, reason: preview.reason, note: preview.note,
    reference: preview.reference, nextValue: businessValue(input.nextValue), preparedAt: new Date().toISOString(), status: 'pending'};
  document = await updateOperation(api, document, {...document.value, pending});
  return applyPending(api, document, inventory);
}
export async function resumeInventoryStep<T extends object>(api: OperationApi, original: OperationDocument<T>, options: {retryIfUnchanged?: boolean; expectedStepId?: string; expectedDocumentVersion?: number} = {}): Promise<InventoryWorkflowResult<T>> {
  checkDocument(original);
  if (options.retryIfUnchanged) {
    validateOperationKey(options.expectedStepId!);
    if (!Number.isSafeInteger(options.expectedDocumentVersion) || options.expectedDocumentVersion! < 1) throw new Error('重送必须绑定已经展示并确认的单据版本，请重新预览。');
  }
  const document = await readOperation<InventoryWorkflowValue<T>>(api, original.container, original.key);
  if (!document) throw new Error('原业务单据不存在，不能恢复库存步骤。');
  if (options.retryIfUnchanged && (document.version !== options.expectedDocumentVersion || document.value.pending?.stepId !== options.expectedStepId)) {
    throw new Error('业务单据或待执行步骤已变化，请重新读取并预览；不会重送未确认的新步骤。');
  }
  const result = await reconcile(api, document);
  if (result.state !== 'retry-allowed' || !options.retryIfUnchanged) return result;
  const pending = result.document.value.pending!;
  const inventory = await api<WorkflowInventory>(`inventory/${pending.inventoryId}`); checkInventory(inventory, pending.inventoryId);
  return applyPending(api, result.document, inventory);
}
