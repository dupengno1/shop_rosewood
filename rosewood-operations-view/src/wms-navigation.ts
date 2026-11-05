import {WMS_MODE_STATUSES,wmsText,type WmsMode} from './wms-domain';

export type WmsFilters={type:WmsMode;sku?:string;status?:string;reference?:string};
export type WmsNavigation={document:string;filters:WmsFilters};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function wmsFilters(mode:WmsMode,sku='',status='',reference=''):WmsFilters{
  const cleanSku=wmsText(sku,'筛选 SKU',256),cleanReference=wmsText(reference,'筛选关联单号',120);
  if(status&&!WMS_MODE_STATUSES[mode].includes(status))throw new Error('此类单据不支持当前状态筛选，请清空筛选后重试。');
  return {type:mode,...(cleanSku?{sku:cleanSku}:{}),...(status?{status}:{}),...(cleanReference?{reference:cleanReference}:{})};
}
export function wmsDocumentKey(value:string):string{
  const key=value.trim();
  if(key&&!UUID.test(key))throw new Error('单据编号必须为有效 UUID。');
  return key;
}
export function readWmsNavigation(hash:string,mode:WmsMode):WmsNavigation{
  const query=new URLSearchParams(hash.startsWith('#')?hash.slice(1):'');
  return {document:wmsDocumentKey(query.get('wmsDocument')||''),filters:wmsFilters(mode,query.get('wmsSku')||'',query.get('wmsStatus')||'',query.get('wmsReference')||'')};
}
export function writeWmsNavigation(hash:string,mode:WmsMode,filters:WmsFilters,document=''):string{
  const clean=wmsFilters(mode,filters.sku,filters.status,filters.reference),key=wmsDocumentKey(document);
  const query=new URLSearchParams(hash.startsWith('#')?hash.slice(1):'');
  // Only this component's namespace is updated; PIM/parent routing is not rewritten.
  for(const name of ['wmsDocument','wmsSku','wmsStatus','wmsReference'])query.delete(name);
  query.set('view',mode);
  if(key)query.set('wmsDocument',key);
  if(clean.sku)query.set('wmsSku',clean.sku);
  if(clean.status)query.set('wmsStatus',clean.status);
  if(clean.reference)query.set('wmsReference',clean.reference);
  return `#${query.toString()}`;
}
