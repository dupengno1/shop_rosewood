import {inventoryChange, type InventoryResource} from './domain';

// Filled only with the Custom Type registered in the current demo project.
export const INVENTORY_ADJUSTMENT_TYPE_ID = '6ae08596-ad7d-4c3f-8c5b-09d81a627abd';
export const INVENTORY_ADJUSTMENT_REASONS = [
  {value: 'count', label: '盘点修正'},
  {value: 'reconcile', label: '库存对账'},
  {value: 'damage', label: '损耗 / 报损'},
  {value: 'return', label: '退货入库'},
  {value: 'other', label: '其他'},
] as const;
export type InventoryAdjustmentReason = typeof INVENTORY_ADJUSTMENT_REASONS[number]['value'];
export type InventoryAdjustmentInput = {reason: string; note?: string; reference?: string};
export type InventoryAdjustmentEntry = InventoryResource & {
  custom?: {type?: {id?: string}; fields?: Record<string, unknown>};
};
type FieldValue = string | number;
type AdjustmentAction =
  | {action: 'changeQuantity'; quantity: number}
  | {action: 'setCustomType'; type: {typeId: 'type'; id: string}; fields: Record<string, FieldValue>}
  | {action: 'setCustomField'; name: string; value?: FieldValue};
export type InventoryAdjustmentPreview = {
  before: number; after: number; delta: number; version: number;
  reason: InventoryAdjustmentReason; note: string; reference: string;
};

export function inventoryAdjustmentBlock(entry: InventoryAdjustmentEntry): string | undefined {
  if (!INVENTORY_ADJUSTMENT_TYPE_ID) return '库存调整原因尚未配置，暂不能保存更正。';
  if (entry.custom && entry.custom.type?.id !== INVENTORY_ADJUSTMENT_TYPE_ID) {
    return '此库存记录已使用其他 Custom Type。为保留现有业务字段，本面板不允许调整；请由管理员确认兼容方案。';
  }
  return undefined;
}

function text(value: unknown, label: string, maximum: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${label}格式不正确。`);
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label}不能包含控制字符或换行。`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximum) throw new Error(`${label}最多 ${maximum} 个字符。`);
  return trimmed;
}

export function previewInventoryAdjustment(
  entry: InventoryAdjustmentEntry, quantity: string | number, input: InventoryAdjustmentInput,
): InventoryAdjustmentPreview {
  const block = inventoryAdjustmentBlock(entry);
  if (block) throw new Error(block);
  const reason = text(input.reason, '调整原因', 20);
  if (!INVENTORY_ADJUSTMENT_REASONS.some(option => option.value === reason)) throw new Error('请选择调整原因。');
  const note = text(input.note, '调整说明', 500);
  const reference = text(input.reference, '单据编号', 120);
  if (reason === 'other' && !note) throw new Error('选择“其他”原因时必须填写调整说明。');
  const change = inventoryChange(entry, quantity);
  if (change.delta === 0) throw new Error('库存数量没有变化，无需重复提交调整。');
  return {before: change.before, after: change.after, delta: change.delta, version: change.version,
    reason: reason as InventoryAdjustmentReason, note, reference};
}

export function buildInventoryAdjustment(
  entry: InventoryAdjustmentEntry, preview: InventoryAdjustmentPreview, at = new Date(),
): {version: number; actions: AdjustmentAction[]} {
  const checked = previewInventoryAdjustment(entry, preview.after, preview);
  if (checked.version !== preview.version || checked.before !== preview.before || checked.delta !== preview.delta) {
    throw new Error('库存记录已变化，请重新预览本次调整。');
  }
  if (!Number.isFinite(at.getTime())) throw new Error('调整时间无效，请重新预览。');
  const fields: Record<string, FieldValue> = {
    rwAdjustmentReason: checked.reason,
    rwAdjustmentAt: at.toISOString(),
    rwAdjustmentBefore: checked.before,
    rwAdjustmentAfter: checked.after,
  };
  if (checked.note) fields.rwAdjustmentNote = checked.note;
  if (checked.reference) fields.rwAdjustmentReference = checked.reference;
  const actions: AdjustmentAction[] = [{action: 'changeQuantity', quantity: checked.after}];
  if (!entry.custom) {
    actions.push({action: 'setCustomType', type: {typeId: 'type', id: INVENTORY_ADJUSTMENT_TYPE_ID}, fields});
  } else {
    for (const [name, value] of Object.entries(fields)) actions.push({action: 'setCustomField', name, value});
    for (const name of ['rwAdjustmentNote', 'rwAdjustmentReference']) {
      if (!(name in fields) && Object.prototype.hasOwnProperty.call(entry.custom.fields || {}, name)) {
        actions.push({action: 'setCustomField', name});
      }
    }
  }
  return {version: checked.version, actions};
}

export function inventoryAdjustmentReasonLabel(reason: string): string {
  return INVENTORY_ADJUSTMENT_REASONS.find(option => option.value === reason)?.label || reason;
}

export function latestInventoryAdjustment(entry: InventoryAdjustmentEntry): {
  reason: string; note: string; reference: string; at: string; before?: number; after?: number;
} | undefined {
  if (entry.custom?.type?.id !== INVENTORY_ADJUSTMENT_TYPE_ID) return undefined;
  const fields = entry.custom.fields || {};
  if (typeof fields.rwAdjustmentReason !== 'string' || typeof fields.rwAdjustmentAt !== 'string') return undefined;
  return {
    reason: inventoryAdjustmentReasonLabel(fields.rwAdjustmentReason),
    note: typeof fields.rwAdjustmentNote === 'string' ? fields.rwAdjustmentNote : '',
    reference: typeof fields.rwAdjustmentReference === 'string' ? fields.rwAdjustmentReference : '',
    at: fields.rwAdjustmentAt,
    before: typeof fields.rwAdjustmentBefore === 'number' ? fields.rwAdjustmentBefore : undefined,
    after: typeof fields.rwAdjustmentAfter === 'number' ? fields.rwAdjustmentAfter : undefined,
  };
}
