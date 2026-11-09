import type {Inventory,Order,Product,Variant} from './api';
import {classifyFulfillment} from './fulfillment-classification';
import {localized} from './domain';

export const warehouseNames:Record<string,string>={
  'rw-warehouse-asia':'Asia Warehouse','warehouse-asia':'Asia Warehouse',
  'rw-warehouse-eu':'EMEA Warehouse','warehouse-eu':'EMEA Warehouse',
  'rw-warehouse-us':'Americas Warehouse','warehouse-us':'Americas Warehouse',
  'rw-warehouse-hk':'Hong Kong Warehouse','warehouse-hk':'Hong Kong Warehouse',
};
export const warehouseName=(channel?:{id?:string;key?:string;obj?:{key?:string;name?:Record<string,string>}}):string=>{
  if(!channel)return 'Unassigned warehouse';
  const key=channel.obj?.key||channel.key;
  return (key&&warehouseNames[key])||localized(channel.obj?.name)||key||channel.id||'Unassigned warehouse';
};
export function productInfo(variant?:Variant):Record<string,unknown>{
  const value=variant?.attributes?.find(attribute=>attribute.name==='rwProductInfo')?.value;
  if(typeof value!=='string')return {};
  try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}
}
export type InventorySummary={available:number|null;reserved:number|null;onStock:number|null;status:'In Stock'|'Low Stock'|'Out of Stock'|'Unknown'};
export function inventorySummary(rows:Inventory[],complete=true):InventorySummary{
  if(!complete||!rows.length||rows.some(row=>!Number.isSafeInteger(row.quantityOnStock)||!Number.isSafeInteger(row.availableQuantity)))return {available:null,reserved:null,onStock:null,status:'Unknown'};
  const available=rows.reduce((sum,row)=>sum+row.availableQuantity,0),onStock=rows.reduce((sum,row)=>sum+row.quantityOnStock,0);
  if(!Number.isSafeInteger(available)||!Number.isSafeInteger(onStock))return {available:null,reserved:null,onStock:null,status:'Unknown'};
  // CT exposes on-stock and available; show only their observed non-negative
  // difference. This is not an order-specific reservation ledger.
  const reserved=rows.some(row=>row.availableQuantity>row.quantityOnStock)?null:onStock-available;
  return {available,onStock,reserved,status:available<=0?'Out of Stock':available<=5?'Low Stock':'In Stock'};
}
export function productOperationalData(product:Product,inventory:Inventory[],complete=true){
  const staged=product.masterData.staged,variants=[staged.masterVariant,...staged.variants],info=productInfo(staged.masterVariant);
  const fulfillment=info.fulfillment&&typeof info.fulfillment==='object'?info.fulfillment as Record<string,unknown>:{};
  const digital=info.kind==='digital';
  const observedSkus=new Set(inventory.map(row=>row.sku));
  const allVariantsObserved=variants.every(variant=>Boolean(variant.sku)&&observedSkus.has(variant.sku!));
  const name=localized(staged.name)||localized(product.masterData.current?.name)||product.key||product.id;
  return {id:product.id,key:product.key||product.id,name,image:staged.masterVariant.images?.[0]?.url,
    digital,primaryWarehouse:digital?'Digital Delivery':typeof fulfillment.primaryWarehouse==='string'?(warehouseNames[fulfillment.primaryWarehouse]||fulfillment.primaryWarehouse):'Not configured',
    fallbackWarehouse:typeof fulfillment.fallbackWarehouse==='string'?(warehouseNames[fulfillment.fallbackWarehouse]||fulfillment.fallbackWarehouse):'Not configured',
    strategy:typeof fulfillment.strategy==='string'?fulfillment.strategy:'Not configured',
    published:product.masterData.published,variants,summary:inventorySummary(inventory,complete&&allVariantsObserved)};
}
export function sourceStore(order:Pick<Order,'store'|'custom'>):string{
  const key=order.store?.key||order.store?.obj?.key;
  if(key==='rosewood-us')return 'Global Store';if(key==='rosewood-hk')return 'HK Store';
  return key||order.store?.id||'Not assigned';
}
export const deliveryMethod=(value?:string):string=>({standard:'Standard Shipping',express:'Express Shipping',collection:'Hotel Collection',local:'Local Delivery',email:'Digital Delivery',digital:'Digital Delivery'}[value||'']||value||'Not recorded');
export const paymentMethod=(value?:string):string=>({card:'Credit Card',credit_card:'Credit Card',wechat:'WeChat Pay',wechat_pay:'WeChat Pay',alipay:'Alipay',payme:'PayMe',unionpay:'UnionPay'}[value||'']||value||'Not recorded');
export function orderPaymentMethods(order:Order):string[]{
  const methods=(order.paymentInfo?.payments||[]).map(ref=>ref.obj?.paymentMethodInfo?.method||ref.obj?.paymentMethodInfo?.name?.en).filter((value):value is string=>Boolean(value));
  const custom=order.custom?.fields?.rwPaymentMethod;
  const labels=methods.map(paymentMethod);
  if(typeof custom==='string'&&custom.trim())labels.push(paymentMethod(custom)+(isSimulatedPaymentSelection(order)?' (simulated selection)':''));
  return [...new Set(labels)];
}
export function isSimulatedPaymentSelection(order:Order):boolean{
  return order.custom?.fields?.rwPaymentStatus==='simulated-approved';
}
export function orderDeliveryMethods(order:Order):string[]{
  const methods=[order.shippingInfo?.shippingMethodName,...(order.shipping||[]).map(row=>row.shippingInfo?.shippingMethodName)].filter((value):value is string=>Boolean(value));
  const custom=order.custom?.fields?.rwDeliveryMethod;
  if(typeof custom==='string')methods.push(custom);
  return [...new Set(methods.map(deliveryMethod))];
}
export type ConsignmentGroup={id:string;warehouse:string;lines:Array<{id:string;sku:string;name:string;quantity:number}>;digital:boolean;nativeReserved:number|null};
export function orderConsignments(order:Order):ConsignmentGroup[]{
  const groups=new Map<string,ConsignmentGroup>();
  for(const line of order.lineItems||[]){
    if(!line.id||!Number.isSafeInteger(line.quantity)||line.quantity<=0)continue;
    const kind=classifyFulfillment(line,'lineItem').type;if(kind==='fee'||kind==='service')continue;
    const digital=kind==='digital',id=digital?'digital':line.supplyChannel?.id||'unassigned';
    const group=groups.get(id)||{id,warehouse:digital?'Digital Delivery':warehouseName(line.supplyChannel),digital,lines:[],nativeReserved:0};
    group.lines.push({id:line.id,sku:line.variant?.sku||'No SKU',name:localized(line.name)||line.id,quantity:line.quantity});
    // ReserveOnOrder remains a mode/snapshot, not proof that reservation still
    // exists after shipment. Expose no fabricated per-order reserved balance.
    if(!digital)group.nativeReserved=null;
    groups.set(id,group);
  }
  return [...groups.values()];
}
