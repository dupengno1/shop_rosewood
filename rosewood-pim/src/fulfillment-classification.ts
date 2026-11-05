export type FulfillmentType = 'physical' | 'digital' | 'service' | 'fee' | 'unknown';
export type FulfillmentInput = {
  key?: string;
  custom?: {fields?: Record<string, unknown>};
  variant?: {attributes?: Array<{name: string; value?: unknown}>};
};
export type FulfillmentClassification = {
  type: FulfillmentType;
  label: string;
  reason: string;
  source: 'fee-key' | 'order-line-custom' | 'rw-product-info' | 'none';
};
export type FulfillmentInstruction = {label: string; value: string};

const labels: Record<FulfillmentType, string> = {
  physical: '实物', digital: '数字商品', service: '服务 / 捐款', fee: '费用', unknown: '需确认履约类型',
};
function classification(type: FulfillmentType, reason: string, source: FulfillmentClassification['source']): FulfillmentClassification {
  return {type, label: labels[type], reason, source};
}

// These keys are the fee contract written by apps/middleware/native-pricing.js.
// They identify CustomLineItems, never SKU prefixes or product names.
export function classifyFulfillment(line: FulfillmentInput, kind: 'lineItem' | 'customLineItem'): FulfillmentClassification {
  if (kind === 'customLineItem' && typeof line.key === 'string' &&
    (line.key === 'rw-tax' || line.key === 'rw-ddp' || line.key.startsWith('rw-wrap-'))) {
    return classification('fee', '税费、关税或礼品包装费用不登记实物发运。', 'fee-key');
  }

  const fields = line.custom?.fields;
  if (fields && Object.prototype.hasOwnProperty.call(fields, 'rwFulfillmentType')) {
    const value = fields.rwFulfillmentType;
    if (value === 'physical' || value === 'digital' || value === 'service') {
      return classification(value, '使用此订单行已保存的履约类型。', 'order-line-custom');
    }
    return classification('unknown', '订单行履约类型无效；请修正后刷新，不能据此登记实物发运。', 'order-line-custom');
  }

  const attributes = line.variant?.attributes?.filter(attribute => attribute.name === 'rwProductInfo') || [];
  if (attributes.length > 1) return classification('unknown', '商品快照含重复的履约资料，需要核对。', 'rw-product-info');
  if (attributes.length === 1) {
    try {
      // rwProductInfo is a text attribute containing JSON; its kind is written
      // by packages/catalog/import.js. Read the order snapshot, not live Product.
      if (typeof attributes[0].value !== 'string') throw new Error('Invalid product metadata');
      const info: unknown = JSON.parse(attributes[0].value);
      if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Invalid product metadata');
      const value = (info as Record<string, unknown>).kind;
      if (value === 'physical' || value === 'digital') {
        return classification(value, '使用下单时保存的商品类型。', 'rw-product-info');
      }
      if (value === 'donation') return classification('service', '下单时保存的商品类型为捐款，不登记实物发运。', 'rw-product-info');
      if (value !== undefined) return classification('unknown', '下单时的商品类型无法识别，需要确认。', 'rw-product-info');
    } catch {
      return classification('unknown', '下单时的商品履约资料无法读取，需要确认。', 'rw-product-info');
    }
  }
  // A shared ProductType, stock mode, SKU or shipping address alone does not
  // establish whether this Rosewood line is physical, digital or a service.
  return classification('unknown', '订单未保存明确的履约类型；请补齐订单行类型后刷新。', 'none');
}

export function fulfillmentInstructions(line: FulfillmentInput): FulfillmentInstruction[] {
  const fields = line.custom?.fields || {};
  const instructions: FulfillmentInstruction[] = [];
  for (const [key, label] of [
    ['rwFulfillmentNotes', '发运备注'], ['rwPersonalization', '定制内容'],
    ['rwPickupLocation', '领取地点'], ['rwPickupDate', '领取日期'], ['rwPickupTime', '领取时段'],
  ]) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) instructions.push({label, value: value.trim()});
  }
  if (typeof fields.rwGiftWrap === 'boolean') instructions.push({label: '礼品包装', value: fields.rwGiftWrap ? '需要' : '不需要'});
  const items = fields.rwBundleItems;
  if (Array.isArray(items) && items.length && items.every(item => typeof item === 'string' && item.trim())) {
    instructions.push({label: '礼篮组件', value: items.map(item => item.trim()).join('、')});
  }
  return instructions;
}
