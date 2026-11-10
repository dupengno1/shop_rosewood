import type {Inventory,Order,Product} from './api';
import {classifyFulfillment} from './fulfillment-classification';
import {localized} from './domain';
import {configuredPrimaryWarehouse,fulfilmentWarehouseLabel,lineFulfilmentWarehouse,nativePrimaryWarehouse,productInfo,warehouseName} from './fulfilment-warehouse';
export {DIGITAL_DELIVERY,PRIMARY_WAREHOUSE_ATTRIBUTE,warehouseName,warehouseNames,lineFulfilmentWarehouse} from './fulfilment-warehouse';
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
const strategies:Record<string,string>={'primary-only':'Primary warehouse only',digital:'Digital delivery','Nearest Available Warehouse':'Nearest available warehouse'};
export function productOperationalData(product:Product,inventory:Inventory[],complete=true){
  const staged=product.masterData.staged,variants=[staged.masterVariant,...staged.variants],info=productInfo(staged.masterVariant.attributes);
  const fulfillment=info.fulfillment&&typeof info.fulfillment==='object'?info.fulfillment as Record<string,unknown>:{};
  const digital=info.kind==='digital';
  const observedSkus=new Set(inventory.map(row=>row.sku));
  const allVariantsObserved=variants.every(variant=>Boolean(variant.sku)&&observedSkus.has(variant.sku!));
  const name=localized(staged.name)||localized(product.masterData.current?.name)||product.key||product.id;
  const configured=configuredPrimaryWarehouse(staged.masterVariant.attributes);
  const native=nativePrimaryWarehouse(staged.attributes as {name:string;value?:unknown}[]|undefined);
  return {id:product.id,key:product.key||product.id,name,image:staged.masterVariant.images?.[0]?.url,
    digital,primaryWarehouse:configured.label,primaryWarehouseKey:configured.key,
    // The native attribute mirrors the configuration; a difference must be visible, never silently preferred.
    nativePrimaryWarehouse:native?.label??null,primaryWarehouseMismatch:Boolean(native&&native.key!==configured.key),
    fallbackWarehouse:typeof fulfillment.fallbackWarehouse==='string'&&fulfillment.fallbackWarehouse?fulfilmentWarehouseLabel(fulfillment.fallbackWarehouse):digital?'Not applicable':'Not configured',
    strategy:typeof fulfillment.strategy==='string'?strategies[fulfillment.strategy]||fulfillment.strategy:digital?strategies.digital:'Not configured',
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
  const methods=[order.shippingInfo?.shippingMethodName,...(order.shipping||[]).map(row=>row.shippingInfo?.shippingMethodName)].filter((value):value is string=>typeof value==='string'&&Boolean(value.trim()));
  const custom=order.custom?.fields?.rwDeliveryMethod;
  if(typeof custom==='string'&&custom.trim())methods.push(custom);
  if(methods.length)return [...new Set(methods.map(deliveryMethod))];
  // A reliable order-item snapshot can establish the digital delivery category,
  // not delivery execution. Never infer it from SKU, stock mode or an empty order.
  const items=[...(order.lineItems||[]).map(line=>({line,kind:'lineItem' as const})),...(order.customLineItems||[]).map(line=>({line,kind:'customLineItem' as const}))];
  return items.length&&items.every(({line,kind})=>Number.isSafeInteger(line.quantity)&&line.quantity>0&&classifyFulfillment(line,kind).type==='digital')?['Digital Delivery (item classification)']:[];
}
export type ConsignmentGroup={id:string;warehouse:string;lines:Array<{id:string;sku:string;name:string;quantity:number;fulfilmentWarehouse:string}>;digital:boolean;nativeReserved:number|null};
export function orderConsignments(order:Order):ConsignmentGroup[]{
  const groups=new Map<string,ConsignmentGroup>();
  for(const line of order.lineItems||[]){
    if(!line.id||!Number.isSafeInteger(line.quantity)||line.quantity<=0)continue;
    const kind=classifyFulfillment(line,'lineItem').type;if(kind==='fee'||kind==='service')continue;
    const digital=kind==='digital',id=digital?'digital':line.supplyChannel?.id||'unassigned';
    const group=groups.get(id)||{id,warehouse:digital?'Digital Delivery':warehouseName(line.supplyChannel),digital,lines:[],nativeReserved:0};
    group.lines.push({id:line.id,sku:line.variant?.sku||'No SKU',name:localized(line.name)||line.id,quantity:line.quantity,fulfilmentWarehouse:lineFulfilmentWarehouse(line,digital)});
    // ReserveOnOrder remains a mode/snapshot, not proof that reservation still
    // exists after shipment. Expose no fabricated per-order reserved balance.
    if(!digital)group.nativeReserved=null;
    groups.set(id,group);
  }
  return [...groups.values()];
}
