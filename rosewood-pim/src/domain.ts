// Pure domain checks for the REST representations returned by the MC API Gateway.
// They supplement, but never replace, server permissions and resource versions.
import {classifyFulfillment, fulfillmentInstructions, type FulfillmentInput, type FulfillmentClassification, type FulfillmentInstruction} from './fulfillment-classification';
export type HostEntity = {
  kind: 'product' | 'order' | 'unsupported';
  id?: string;
  variantId?: number;
  inventoryId?: string;
  nativeUrl?: string;
};

export type LocalizedString = Record<string, string>;
export type ProductVariant = {
  id?: number;
  sku?: string;
  images?: Array<{ url?: string }>;
  prices?: Array<{ value?: { centAmount?: number; currencyCode?: string } }>;
  [key: string]: unknown;
};
export type ProductData = {
  name?: LocalizedString;
  description?: LocalizedString;
  masterVariant?: ProductVariant;
  variants?: ProductVariant[];
  [key: string]: unknown;
};
export type ProductResource = {
  priceMode?: string;
  masterData?: {
    staged?: ProductData;
    current?: ProductData;
    published?: boolean;
    hasStagedChanges?: boolean;
  };
  [key: string]: unknown;
};
export type QualityIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
};
export type ProductDifference = { field: string; current: string; staged: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseHostUrl(hostUrl: string, expectedProjectKey: string): HostEntity {
  try {
    const url = new URL(hostUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return { kind: 'unsupported' };
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (!expectedProjectKey || parts[0] !== expectedProjectKey || !uuid.test(parts[2] || '')) {
      return { kind: 'unsupported' };
    }
    if (parts[1] === 'orders') {
      return { kind: 'order', id: parts[2], nativeUrl: url.href };
    }
    if (parts[1] !== 'products') return { kind: 'unsupported' };
    const result: HostEntity = { kind: 'product', id: parts[2], nativeUrl: url.href };
    if (parts[3] === 'variants' && parts[4] !== undefined) {
      if (!/^\d+$/.test(parts[4])) return { kind: 'unsupported' };
      const variantId = Number(parts[4]);
      if (!Number.isSafeInteger(variantId) || variantId < 1) return { kind: 'unsupported' };
      result.variantId = variantId;
      if (parts[5] === 'inventory' && parts[6] !== undefined) {
        if (parts.length !== 7 || !uuid.test(parts[6])) return { kind: 'unsupported' };
        result.inventoryId = parts[6];
      }
    }
    return result;
  } catch {
    return { kind: 'unsupported' };
  }
}

export function localized(value?: LocalizedString, preferredLocale = 'en'): string {
  const preferred = value?.[preferredLocale];
  return preferred?.trim() ? preferred : Object.values(value || {}).find(text => text?.trim()) || '';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}
function display(value: unknown): string {
  return value === undefined ? '—' : JSON.stringify(canonical(value));
}
function variants(data?: ProductData): ProductVariant[] {
  return [...(data?.masterVariant ? [data.masterVariant] : []), ...(data?.variants || [])];
}

export function productQuality(product: ProductResource): {
  issues: QualityIssue[];
  diffs: ProductDifference[];
  readyToPublish: boolean;
} {
  const issues: QualityIssue[] = [];
  const diffs: ProductDifference[] = [];
  const staged = product.masterData?.staged;
  const current = product.masterData?.current;
  const add = (code: string, severity: QualityIssue['severity'], message: string) => issues.push({ code, severity, message });
  if (!staged) {
    add('missing-staged-data', 'error', 'Staged product data is unavailable. Reload before publishing.');
    return { issues, diffs, readyToPublish: false };
  }
  if (!localized(staged.name).trim()) add('missing-name', 'error', 'Add a product name in at least one locale.');
  if (!localized(staged.description).trim()) add('missing-description', 'warning', 'The staged product has no description.');
  const stagedVariants = variants(staged);
  if (!stagedVariants.length) add('missing-variant', 'error', 'The staged product has no variants.');
  const skuCounts = new Map<string, number>();
  for (const variant of stagedVariants) {
    const label = variant.sku?.trim() || `variant ${variant.id ?? '?'}`;
    if (!variant.sku?.trim()) add('missing-sku', 'error', `Assign a SKU to ${label} before publishing from this panel.`);
    else skuCounts.set(variant.sku, (skuCounts.get(variant.sku) || 0) + 1);
    if (!variant.images?.some(image => image.url?.trim())) add('missing-image', 'warning', `${label} has no product image.`);
    if (product.priceMode !== 'Standalone' && !variant.prices?.length) {
      add('missing-price', 'warning', `${label} has no embedded price. Confirm its selling price or gift-card denomination model.`);
    }
  }
  for (const [sku, count] of skuCounts) {
    if (count > 1) add('duplicate-sku', 'error', `SKU ${sku} occurs ${count} times in this staged product.`);
  }
  if (product.priceMode === 'Standalone') {
    add('standalone-price-review', 'warning', 'This product uses Standalone Prices. Review their active status and scope in the native price editor; embedded prices do not establish sale readiness.');
  }
  const diff = (field: string, before: unknown, after: unknown) => {
    if (display(before) !== display(after)) diffs.push({ field, current: display(before), staged: display(after) });
  };
  const fields = new Set([...Object.keys(current || {}), ...Object.keys(staged)]);
  fields.delete('masterVariant'); fields.delete('variants');
  for (const field of [...fields].sort()) diff(field, current?.[field], staged[field]);
  const currentById = new Map(variants(current).map(variant => [variant.id, variant]));
  const stagedById = new Map(stagedVariants.map(variant => [variant.id, variant]));
  const ids = new Set([...currentById.keys(), ...stagedById.keys()]);
  for (const id of ids) {
    const before = currentById.get(id), after = stagedById.get(id);
    if (!before || !after) { diff(`variant ${id ?? '?'}`, before, after); continue; }
    const variantFields = new Set([...Object.keys(before), ...Object.keys(after)]);
    variantFields.delete('id');
    for (const field of [...variantFields].sort()) diff(`variant ${id ?? '?'}.${field}`, before[field], after[field]);
  }
  if (current?.masterVariant?.id !== staged.masterVariant?.id) diff('masterVariant.id', current?.masterVariant?.id, staged.masterVariant?.id);
  return { issues, diffs, readyToPublish: !issues.some(issue => issue.severity === 'error') };
}

export type DeliveryItem = { id: string; quantity: number };
export type Delivery = {
  id?: string;
  key?: string;
  items?: DeliveryItem[];
  parcels?: Array<{ items?: DeliveryItem[]; [key: string]: unknown }>;
  [key: string]: unknown;
};
export type OrderLine = FulfillmentInput & {
  id: string;
  name?: LocalizedString;
  quantity: number;
  variant?: { sku?: string; attributes?: Array<{name: string; value?: unknown}> };
  [key: string]: unknown;
};
export type OrderResource = {
  version?: number;
  orderState?: string;
  shippingMode?: string;
  shippingInfo?: { deliveries?: Delivery[]; [key: string]: unknown };
  shipping?: Array<{ shippingInfo?: { deliveries?: Delivery[]; [key: string]: unknown }; [key: string]: unknown }>;
  lineItems?: OrderLine[];
  customLineItems?: OrderLine[];
  [key: string]: unknown;
};
export type FulfillmentLine = {
  id: string;
  name: string;
  sku?: string;
  kind: 'lineItem' | 'customLineItem';
  classification: FulfillmentClassification;
  instructions: FulfillmentInstruction[];
  quantity: number;
  deliveredQuantity: number;
  remainingQuantity: number;
  overDelivered: boolean;
};

export function orderDeliveries(order: OrderResource): Delivery[] {
  const deliveries = [...(order.shippingInfo?.deliveries || []), ...(order.shipping || []).flatMap(shipping => shipping.shippingInfo?.deliveries || [])];
  const seen = new Set<string>();
  return deliveries.filter(delivery => {
    if (!delivery.id) return true;
    if (seen.has(delivery.id)) return false;
    seen.add(delivery.id); return true;
  });
}

export function fulfillmentLines(order: OrderResource): FulfillmentLine[] {
  const totals = new Map<string, number>();
  for (const delivery of orderDeliveries(order)) {
    // The same units may be represented at both levels. Parcels may describe only
    // part of a delivery, but cannot safely be allowed to exceed its line totals.
    const parcelItems = (delivery.parcels || []).flatMap(parcel => parcel.items || []);
    if (delivery.items?.length && parcelItems.length) {
      const deliveryTotals = new Map<string,number>(), parcelTotals = new Map<string,number>();
      for (const item of delivery.items) deliveryTotals.set(item.id,(deliveryTotals.get(item.id)||0)+item.quantity);
      for (const item of parcelItems) {
        if (!Number.isSafeInteger(item.quantity) || item.quantity<0) throw new Error('Existing parcel quantities are invalid. Review the order in Merchant Center.');
        parcelTotals.set(item.id,(parcelTotals.get(item.id)||0)+item.quantity);
      }
      for (const [id,quantity] of parcelTotals) if (!Number.isSafeInteger(quantity) || quantity>(deliveryTotals.get(id)||0)) {
        throw new Error('Existing parcel quantities exceed their delivery quantities. Reconcile the native order before adding a delivery.');
      }
    }
    const items = delivery.items?.length ? delivery.items : parcelItems;
    for (const item of items) {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 0) throw new Error('Existing delivery quantities are invalid. Review the order in Merchant Center.');
      const total = (totals.get(item.id) || 0) + item.quantity;
      if (!Number.isSafeInteger(total)) throw new Error('Existing delivery quantities exceed the supported integer range.');
      totals.set(item.id, total);
    }
  }
  const lines: Array<{ line: OrderLine; kind: FulfillmentLine['kind'] }> = [
    ...(order.lineItems || []).map(line => ({ line, kind: 'lineItem' as const })),
    ...(order.customLineItems || []).map(line => ({ line, kind: 'customLineItem' as const })),
  ];
  return lines.map(({ line, kind }) => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 0) throw new Error('Ordered quantities are invalid. Reload the order.');
    const deliveredQuantity = totals.get(line.id) || 0;
    return { id: line.id, name: localized(line.name) || line.variant?.sku || line.id, sku: line.variant?.sku,
      classification: classifyFulfillment(line, kind), instructions: fulfillmentInstructions(line),
      kind, quantity: line.quantity, deliveredQuantity, remainingQuantity: Math.max(0, line.quantity - deliveredQuantity),
      overDelivered: deliveredQuantity > line.quantity };
  });
}

function nonNegativeInteger(value: number | string, label: string): number {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) throw new Error(`${label} must be a non-negative whole number.`);
  const number = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative whole number within the safe integer range.`);
  return number;
}
function validVersion(version: unknown): asserts version is number {
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new Error('The resource version is missing. Reload before saving.');
}
function trackingText(value: string, label: string): string {
  const text = value.trim();
  if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must contain 1–256 printable characters.`);
  return text;
}

export function buildDeliveryAction(
  order: OrderResource,
  quantities: Record<string, number | string>,
  trackingId: string,
  carrier: string,
  deliveryKey: string,
): {
  action: 'addDelivery'; deliveryKey: string; items: DeliveryItem[];
  parcels: Array<{ trackingData: { trackingId: string; carrier: string }; items: DeliveryItem[] }>;
} {
  validVersion(order.version);
  if (order.orderState === 'Cancelled') throw new Error('Cancelled orders cannot receive a new delivery.');
  if (order.shippingMode === 'Multiple') throw new Error('This panel currently supports Single shipping mode only. Use the native shipping editor for Multiple shipping mode.');
  if (!order.shippingInfo) throw new Error('Set shipping information in the native order editor before adding a delivery.');
  if (!/^[A-Za-z0-9_-]{2,256}$/.test(deliveryKey)) throw new Error('Delivery key must contain 2–256 letters, numbers, underscores, or hyphens.');
  if (orderDeliveries(order).some(delivery => delivery.key === deliveryKey)) throw new Error('This delivery key already exists. Reload the order before retrying to avoid a duplicate delivery.');
  const lines = fulfillmentLines(order);
  if (lines.some(line => line.overDelivered)) throw new Error('Existing deliveries exceed an ordered quantity. Reconcile them in the native editor before adding more.');
  const byId = new Map(lines.map(line => [line.id, line]));
  const items: DeliveryItem[] = [];
  for (const [id, value] of Object.entries(quantities)) {
    const line = byId.get(id);
    if (!line) throw new Error('A selected line no longer exists in this order. Reload before saving.');
    const quantity = value === '' ? 0 : nonNegativeInteger(value, 'Delivery quantity');
    if (quantity > 0 && line.classification.type !== 'physical') {
      throw new Error(`${line.name}: ${line.classification.label}. Physical dispatch is not allowed. Verify the order item fulfilment type first.`);
    }
    if (quantity > line.remainingQuantity) throw new Error(`Delivery quantity for ${line.name} exceeds the remaining ${line.remainingQuantity}.`);
    if (quantity > 0) items.push({ id, quantity });
  }
  if (!items.length) throw new Error('Enter a positive delivery quantity for at least one line.');
  const trackingData = { trackingId: trackingText(trackingId, 'Tracking ID'), carrier: trackingText(carrier, 'Carrier') };
  return { action: 'addDelivery', deliveryKey, items, parcels: [{ trackingData, items: items.map(item => ({ ...item })) }] };
}

export type InventoryResource = { version?: number; quantityOnStock: number; [key: string]: unknown };
export function inventoryChange(entry: InventoryResource, newQuantity: number | string): {
  before: number; after: number; delta: number; version: number;
  actions: Array<{ action: 'changeQuantity'; quantity: number }>;
} {
  validVersion(entry.version);
  if (!Number.isSafeInteger(entry.quantityOnStock)) throw new Error('Current stock is outside the supported integer range. Reload the inventory entry.');
  const after = nonNegativeInteger(newQuantity, 'New stock quantity');
  const delta = after - entry.quantityOnStock;
  if (!Number.isSafeInteger(delta)) throw new Error('The stock difference is outside the supported integer range.');
  return { before: entry.quantityOnStock, after, delta, version: entry.version, actions: [{ action: 'changeQuantity', quantity: after }] };
}

export function errorMessage(error: unknown): string {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const body = record.body && typeof record.body === 'object' ? record.body as Record<string, unknown> : {};
  const errors = [...(Array.isArray(record.errors) ? record.errors : []), ...(Array.isArray(body.errors) ? body.errors : []), ...(Array.isArray(record.graphQLErrors) ? record.graphQLErrors : [])];
  const conflict = [record.statusCode, record.status, body.statusCode, body.status].some(status => Number(status) === 409) ||
    errors.some(item => item?.code === 'ConcurrentModification' || item?.extensions?.code === 'ConcurrentModification');
  if (conflict) return 'This resource changed after you loaded it. Reload the latest version, review the changes, and try again. Your update was not applied.';
  const message = typeof record.message === 'string' ? record.message : typeof body.message === 'string' ? body.message : undefined;
  return message || (typeof error === 'string' ? error : 'The request failed. Reload the resource before retrying.');
}
