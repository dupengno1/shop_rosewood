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
  physical: 'Physical', digital: 'Digital Items', service: 'Services / Donations', fee: 'Fees', unknown: 'Fulfilment Type Required',
};
function classification(type: FulfillmentType, reason: string, source: FulfillmentClassification['source']): FulfillmentClassification {
  return {type, label: labels[type], reason, source};
}

// These keys are the fee contract written by apps/middleware/native-pricing.js.
// They identify CustomLineItems, never SKU prefixes or product names.
export function classifyFulfillment(line: FulfillmentInput, kind: 'lineItem' | 'customLineItem'): FulfillmentClassification {
  if (kind === 'customLineItem' && typeof line.key === 'string' &&
    (line.key === 'rw-tax' || line.key === 'rw-ddp' || line.key.startsWith('rw-wrap-'))) {
    return classification('fee', 'Tax, duties and gift-wrap fees are excluded from physical shipping.', 'fee-key');
  }

  const fields = line.custom?.fields;
  if (fields && Object.prototype.hasOwnProperty.call(fields, 'rwFulfillmentType')) {
    const value = fields.rwFulfillmentType;
    if (value === 'physical' || value === 'digital' || value === 'service') {
      return classification(value, 'Uses the fulfilment type stored on this order item.', 'order-line-custom');
    }
    return classification('unknown', 'The item fulfilment type is invalid. Correct it and refresh before physical shipping.', 'order-line-custom');
  }

  const attributes = line.variant?.attributes?.filter(attribute => attribute.name === 'rwProductInfo') || [];
  if (attributes.length > 1) return classification('unknown', 'The product snapshot has duplicate fulfilment metadata. Review it.', 'rw-product-info');
  if (attributes.length === 1) {
    try {
      // rwProductInfo is a text attribute containing JSON; its kind is written
      // by packages/catalog/import.js. Read the order snapshot, not live Product.
      if (typeof attributes[0].value !== 'string') throw new Error('Invalid product metadata');
      const info: unknown = JSON.parse(attributes[0].value);
      if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Invalid product metadata');
      const value = (info as Record<string, unknown>).kind;
      if (value === 'physical' || value === 'digital') {
        return classification(value, 'Uses the product type saved at checkout.', 'rw-product-info');
      }
      if (value === 'donation') return classification('service', 'The item was saved as a donation and is excluded from physical shipping.', 'rw-product-info');
      if (value !== undefined) return classification('unknown', 'The product type saved at checkout is not recognized. Confirm it before fulfilment.', 'rw-product-info');
    } catch {
      return classification('unknown', 'The fulfilment metadata saved at checkout cannot be read. Confirm it before fulfilment.', 'rw-product-info');
    }
  }
  // A shared ProductType, stock mode, SKU or shipping address alone does not
  // establish whether this Rosewood line is physical, digital or a service.
  return classification('unknown', 'No explicit fulfilment type was saved. Update the native order item type and refresh.', 'none');
}

export function fulfillmentInstructions(line: FulfillmentInput): FulfillmentInstruction[] {
  const fields = line.custom?.fields || {};
  const instructions: FulfillmentInstruction[] = [];
  for (const [key, label] of [
    ['rwFulfillmentNotes', 'Fulfilment Notes'], ['rwPersonalization', 'Personalization'],
    ['rwPickupLocation', 'Collection Location'], ['rwPickupDate', 'Collection Date'], ['rwPickupTime', 'Collection Time'],
  ]) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) instructions.push({label, value: value.trim()});
  }
  if (typeof fields.rwGiftWrap === 'boolean') instructions.push({label: 'Gift Wrapping', value: fields.rwGiftWrap ? 'Yes' : 'No'});
  const items = fields.rwBundleItems;
  if (Array.isArray(items) && items.length && items.every(item => typeof item === 'string' && item.trim())) {
    instructions.push({label: 'Bundle Items', value: items.map(item => item.trim()).join('、')});
  }
  return instructions;
}
