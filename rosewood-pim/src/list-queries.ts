import type {Product, Inventory} from './api';
import {productQuality, localized as localize} from './domain';

const localized = (value?: Record<string, string>) => localize(value, 'zh-CN') || '—';

export type ApplicationModule = 'oms' | 'wms' | 'pim';
export const PAGE_SIZE = 20;
// One extra record determines whether the next page exists without trusting an
// eventually consistent total. Only PAGE_SIZE rows are displayed at a time.
export const QUERY_LIMIT = PAGE_SIZE + 1;
export const MAX_OFFSET = 10000;
export const MAX_PAGE = Math.floor(MAX_OFFSET / PAGE_SIZE);
export const WORK_QUEUES = {
  oms: [{value:'all',label:'全部订单'},{value:'active',label:'进行中订单'},{value:'unshipped',label:'平台未标记已发运'},{value:'cancelled',label:'已取消'}],
  pim: [{value:'all',label:'全部商品'},{value:'draft',label:'未发布商品'},{value:'changed',label:'有待发布修改'},{value:'published',label:'已发布商品'}],
  wms: [{value:'all',label:'全部库存'},{value:'low',label:'低可用库存（≤ 5）'},{value:'empty',label:'无可用库存（≤ 0）'},{value:'negative',label:'在库量为负'}],
};
export function workQueue(module:ApplicationModule,value?:string|null):string {
  return WORK_QUEUES[module].some(option=>option.value===value)?value!:'all';
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function applicationModule(entryPoint: string): ApplicationModule | null {
  return entryPoint === 'rosewood-oms' ? 'oms' : entryPoint === 'rosewood-wms' ? 'wms' : entryPoint === 'rosewood-pim' ? 'pim' : null;
}
export function isResourceId(value: string): boolean { return uuid.test(value); }

export function normalizeSearch(value: string): string {
  const search = value.trim();
  if (search.length > 256 || /[\u0000-\u001f\u007f]/.test(search)) throw new Error('搜索值须为不超过 256 字符的单行文本。');
  return search;
}
export function pageFromQuery(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= MAX_PAGE ? page : 0;
}

export type ApplicationLocationState = {hash?: string; search?: string};

// Fragment state stays in the browser. Merchant Center's document proxy receives
// only the fixed registered pathname; legacy query-string state is not read.
export function readHashState(location: ApplicationLocationState): URLSearchParams {
  const hash = location.hash || '';
  const source = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : '');
  const state = new URLSearchParams();
  for (const key of ['q', 'page', 'record', 'sku', 'filter', 'view', 'report', 'qualityFilter', 'qualityPage', 'wmsDocument', 'wmsSku', 'wmsStatus', 'wmsReference']) {
    const value = source.get(key);
    if (value !== null) state.set(key, value);
  }
  return state;
}

export function qualityViewState(location:ApplicationLocationState):{report:string;filter:string;page:number}{
  const current=readHashState(location),filter=current.get('qualityFilter')||'issues';
  return {report:current.get('report')||'',filter:['issues','errors','warnings','all'].includes(filter)?filter:'issues',page:pageFromQuery(current.get('qualityPage'))};
}

export function listHashState(location: ApplicationLocationState,module?:ApplicationModule): URLSearchParams {
  const current = readHashState(location), next = new URLSearchParams();
  if (current.get('q')) next.set('q', current.get('q')!);
  if (current.get('filter')) next.set('filter', current.get('filter')!);
  const view=current.get('view');
  if(view&&((view==='quality'&&module!=='wms'&&module!=='oms')||(['transfer','count'].includes(view)&&module!=='pim'&&module!=='oms')))next.set('view',view);
  if(module==='pim'||!module&&view==='quality'){
    const quality=qualityViewState(location);
    if(quality.report)next.set('report',quality.report);
    if(quality.filter!=='issues')next.set('qualityFilter',quality.filter);
    if(quality.page)next.set('qualityPage',String(quality.page));
  }
  if(module==='wms'||!module&&['transfer','count'].includes(view||'')){
    for(const key of ['wmsDocument','wmsSku','wmsStatus','wmsReference'])if(current.get(key))next.set(key,current.get(key)!);
  }
  const page = pageFromQuery(current.get('page'));
  if (page) next.set('page', String(page));
  return next;
}

export function wmsViewHashState(location:ApplicationLocationState,view:'inventory'|'transfer'|'count'):URLSearchParams{
  const next=listHashState(location,'wms');
  if(view==='inventory')next.delete('view');else next.set('view',view);
  // Document types and their status filters cannot carry across workflow tabs.
  next.delete('wmsDocument');next.delete('wmsStatus');
  return next;
}

export function hashLocation(pathname: string, state: URLSearchParams): {pathname: string; search: string; hash: string} {
  const fragment = state.toString();
  return {pathname, search: '', hash: fragment ? `#${fragment}` : ''};
}

function skuPredicate(sku: string): string {
  const literal = JSON.stringify(sku);
  const variant = `masterVariant(sku=${literal}) or variants(sku=${literal})`;
  return `masterData(staged(${variant})) or masterData(current(${variant}))`;
}

export function buildListQuery(module: ApplicationModule, search: string, page: number, filter?:string): string {
  if (!Number.isSafeInteger(page) || page < 0 || page > MAX_PAGE) throw new Error('页码超出支持范围，请收窄搜索后重试。');
  const term = normalizeSearch(search);
  const query = new URLSearchParams({ limit: String(QUERY_LIMIT), offset: String(page * PAGE_SIZE), withTotal: 'false' });
  query.append('sort', 'createdAt desc');
  query.append('sort', 'id desc');
  let resource: string;
  if (module === 'oms') {
    resource = 'orders';
    if (term) query.set('where', `orderNumber=${JSON.stringify(term)}${uuid.test(term) ? ` or id=${JSON.stringify(term)}` : ''}`);
  } else if (module === 'pim') {
    resource = 'products';
    if (term) query.set('where', `key=${JSON.stringify(term)}${uuid.test(term) ? ` or id=${JSON.stringify(term)}` : ''} or ${skuPredicate(term)}`);
  } else {
    resource = 'inventory';
    query.set('expand', 'supplyChannel');
    if (term) query.set('where', `sku=${JSON.stringify(term)}`);
  }
  const queues:Record<ApplicationModule,Record<string,string>>={
    oms:{active:'orderState in ("Open", "Confirmed")',unshipped:'orderState != "Cancelled" and (shipmentState is not defined or shipmentState != "Shipped")',cancelled:'orderState="Cancelled"'},
    pim:{draft:'masterData(published=false)',changed:'masterData(hasStagedChanges=true)',published:'masterData(published=true)'},
    wms:{low:'availableQuantity <= 5',empty:'availableQuantity <= 0',negative:'quantityOnStock < 0'},
  };
  const predicate=queues[module][workQueue(module,filter)];
  if(predicate)query.append('where',predicate);
  return `${resource}?${query}`;
}

export function skuProductQuery(sku: string): string {
  const term = normalizeSearch(sku);
  if (!term) throw new Error('SKU 不能为空。');
  return `products?${new URLSearchParams({ where: skuPredicate(term), limit: '2', withTotal: 'false' })}`;
}

export type OrderListRow = {
  id: string; orderNumber?: string; createdAt?: string; orderState?: string; paymentState?: string; shipmentState?: string;
  totalPrice?: { centAmount: number; currencyCode: string; fractionDigits?: number };
};
export type ProductListRow = {
  id: string; version?:number; key?: string; name: string; published: boolean; hasStagedChanges: boolean;
  variantCount: number; skus: string[]; errorCount: number; warningCount: number;
};

// REST order responses contain buyer information. Keep only the fields used by
// the list, so names, addresses and payment details never enter list state.
export function orderListRow(order: OrderListRow): OrderListRow {
  return { id: order.id, orderNumber: order.orderNumber, createdAt: order.createdAt,
    orderState: order.orderState, paymentState: order.paymentState, shipmentState: order.shipmentState,
    ...(order.totalPrice && { totalPrice: { centAmount: order.totalPrice.centAmount, currencyCode: order.totalPrice.currencyCode,
      fractionDigits: order.totalPrice.fractionDigits } }) };
}
export function productListRow(product: Product & { key?: string }): ProductListRow {
  const staged = product.masterData.staged;
  const variants = [staged.masterVariant, ...(staged.variants || [])].filter(Boolean);
  const quality = productQuality(product);
  return { id: product.id, version:product.version, key: product.key, name: localized(staged.name), published: product.masterData.published,
    hasStagedChanges: product.masterData.hasStagedChanges, variantCount: variants.length,
    skus: variants.map(variant => variant.sku).filter((sku): sku is string => Boolean(sku)),
    errorCount: quality.issues.filter(issue => issue.severity === 'error').length,
    warningCount: quality.issues.filter(issue => issue.severity === 'warning').length };
}
export function inventoryListRow(entry: Inventory): Inventory {
  return { id: entry.id, version: entry.version, sku: entry.sku, quantityOnStock: entry.quantityOnStock,
    availableQuantity: entry.availableQuantity,
    ...(entry.supplyChannel && { supplyChannel: { id: entry.supplyChannel.id,
      ...(entry.supplyChannel.obj && { obj: { key: entry.supplyChannel.obj.key, name: entry.supplyChannel.obj.name } }) } }) };
}

export function nativeEntityUrl(project: string, kind: 'orders' | 'products', id: string, origin: string, variantId?: number): string {
  if (!project || !uuid.test(id)) throw new Error('原生资源标识无效。');
  const path = `/${encodeURIComponent(project)}/${kind}/${id}`;
  if (variantId !== undefined && (!Number.isSafeInteger(variantId) || variantId < 1 || kind !== 'products')) throw new Error('原生变体标识无效。');
  return new URL(path + (variantId === undefined ? '' : `/variants/${variantId}/inventory`), origin).href;
}

export type VerifiedInventoryLink = { id: string; label: string; url: string };
export function verifiedInventoryLinks(products: Product[], sku: string, project: string, origin: string): VerifiedInventoryLink[] {
  const links = new Map<string, VerifiedInventoryLink>();
  for (const product of products) {
    for (const data of [product.masterData.staged, product.masterData.current]) {
      if (!data) continue;
      for (const variant of [data.masterVariant, ...(data.variants || [])].filter(Boolean)) {
        if (variant.sku !== sku || !Number.isSafeInteger(variant.id) || variant.id < 1 || !uuid.test(product.id)) continue;
        const id = `${product.id}/${variant.id}`;
        links.set(id, { id, label: `打开原生库存列表 · ${localized(data.name)} · Variant ${variant.id}`,
          url: nativeEntityUrl(project, 'products', product.id, origin, variant.id) });
      }
    }
  }
  return [...links.values()];
}
