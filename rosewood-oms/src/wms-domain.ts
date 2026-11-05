import type {Inventory} from './api';
import {inventoryAdjustmentBlock} from './inventory-adjustment';

export const WMS_CONTAINER='rw-mc-wms-operations';
export type WmsMode='transfer'|'count';
export type StockSnapshot={id:string;sku:string;version:number;quantity:number;available:number;channelId?:string;channelLabel:string};
export type WmsHistory={at:string;action:string;quantity?:number;note:string};
export type WmsValue={
  schemaVersion:1;type:WmsMode;status:string;sku:string;reason:string;reference:string;createdAt:string;
  source:StockSnapshot;destination?:StockSnapshot;planned:number;dispatched:number;received:number;
  counted?:number;history:WmsHistory[];closedAt?:string;closureReason?:string;
};
export type WmsDocument={id:string;version:number;container:string;key:string;value:WmsValue};
export type QuantityAction={action:'addQuantity'|'removeQuantity'|'changeQuantity';quantity:number};
export type WmsEffect={inventory:Inventory;action:QuantityAction;after:number;next:WmsValue;label:string};

export function wmsText(value:string,label:string,maximum=500,required=false):string{
  if(typeof value!=='string'||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value))throw new Error(`${label}不能包含控制字符或换行。`);
  const result=value.trim();
  if(required&&!result)throw new Error(`请填写${label}。`);
  if(result.length>maximum)throw new Error(`${label}最多 ${maximum} 个字符。`);
  return result;
}
export function stockNumber(value:string|number,positive=false):number{
  if(typeof value==='string'&&!/^\d+$/.test(value.trim()))throw new Error('数量必须为非负整数。');
  const number=typeof value==='string'?Number(value.trim()):value;
  if(!Number.isSafeInteger(number)||number<0||(positive&&number===0))throw new Error(positive?'数量必须为大于零的安全整数。':'数量必须为非负安全整数。');
  return number;
}
export function stockSnapshot(entry:Inventory):StockSnapshot{
  if(!/^[0-9a-f-]{36}$/i.test(entry.id)||!entry.sku?.trim()||!Number.isSafeInteger(entry.version)||entry.version<1)throw new Error('库存记录身份或版本无效，请重新读取。');
  if(!Number.isSafeInteger(entry.quantityOnStock)||!Number.isSafeInteger(entry.availableQuantity))throw new Error('库存数量无效，不能执行仓储操作。');
  return {id:entry.id,sku:entry.sku,version:entry.version,quantity:entry.quantityOnStock,available:entry.availableQuantity,
    ...(entry.supplyChannel?.id?{channelId:entry.supplyChannel.id}:{}),channelLabel:entry.supplyChannel?.obj?.key||entry.supplyChannel?.id||'无 Supply Channel'};
}
function assertEditable(entry:Inventory){
  stockSnapshot(entry);
  const block=inventoryAdjustmentBlock(entry);if(block)throw new Error(block);
  if(entry.quantityOnStock<0)throw new Error('源库存或目标库存为负，先核对异常后再操作。');
}
function sameTarget(entry:Inventory,snapshot:StockSnapshot){
  assertEditable(entry);
  if(entry.id!==snapshot.id||entry.sku!==snapshot.sku||(entry.supplyChannel?.id||'')!==(snapshot.channelId||''))throw new Error('库存的 SKU 或 Supply Channel 已变化，请核对单据。');
}
function stamp(value:WmsValue,action:string,note:string,quantity?:number):WmsHistory[]{
  return [...value.history,{at:new Date().toISOString(),action,note,...(quantity!==undefined?{quantity}:{})}];
}
export function newTransfer(source:Inventory,destination:Inventory,quantity:string,reason:string,reference:string):WmsValue{
  assertEditable(source);assertEditable(destination);
  if(source.id===destination.id)throw new Error('源库存和目的库存必须不同。');
  if(source.sku!==destination.sku)throw new Error('调拨只能使用相同 SKU。');
  if(!source.supplyChannel?.id||!destination.supplyChannel?.id||source.supplyChannel.id===destination.supplyChannel.id)throw new Error('调拨两端必须为不同且明确的 Supply Channel。');
  const planned=stockNumber(quantity,true);
  if(planned>source.quantityOnStock||planned>source.availableQuantity)throw new Error('源仓可用库存不足，不能创建此数量的调拨。');
  return {schemaVersion:1,type:'transfer',status:'planned',sku:source.sku,reason:wmsText(reason,'调拨原因',500,true),reference:wmsText(reference,'关联单据',120),createdAt:new Date().toISOString(),
    source:stockSnapshot(source),destination:stockSnapshot(destination),planned,dispatched:0,received:0,history:[]};
}
export function newCount(entry:Inventory,counted:string,reason:string,reference:string):WmsValue{
  assertEditable(entry);
  return {schemaVersion:1,type:'count',status:'counted',sku:entry.sku,reason:wmsText(reason,'盘点原因',500,true),reference:wmsText(reference,'关联单据',120),createdAt:new Date().toISOString(),
    source:stockSnapshot(entry),planned:0,dispatched:0,received:0,counted:stockNumber(counted),history:[]};
}
export function reviewCount(value:WmsValue):WmsValue{
  if(value.type!=='count'||value.status!=='counted')throw new Error('只有已录入的盘点单可以复核。');
  stockNumber(value.counted!);
  return {...value,status:'reviewed',history:stamp(value,'review','已复核 CT 销售库存盘点值；不代表物理实物总量。')};
}
export function dispatchTransfer(value:WmsValue,entry:Inventory):WmsEffect{
  if(value.type!=='transfer'||value.status!=='planned'||value.dispatched!==0)throw new Error('此调拨单不能再次发出。');
  sameTarget(entry,value.source);
  const quantity=stockNumber(value.planned,true);
  if(quantity>entry.quantityOnStock||quantity>entry.availableQuantity)throw new Error('源仓可用库存不足，请调整计划或核对库存。');
  const next={...value,status:'in_transit',dispatched:quantity,history:stamp(value,'dispatch','已从源仓发出，目的仓尚未收货。',quantity)};
  return {inventory:entry,action:{action:'removeQuantity',quantity},after:stockNumber(entry.quantityOnStock-quantity),next,label:'确认发出并扣减源仓'};
}
export function receiveTransfer(value:WmsValue,entry:Inventory,input:string):WmsEffect{
  if(value.type!=='transfer'||value.status!=='in_transit'||!value.destination)throw new Error('只有在途调拨可以收货。');
  sameTarget(entry,value.destination);
  const quantity=stockNumber(input,true),remaining=stockNumber(value.dispatched)-stockNumber(value.received);
  if(quantity>remaining)throw new Error('本次收货不能超过剩余在途数量。');
  const received=stockNumber(value.received+quantity),after=stockNumber(entry.quantityOnStock+quantity);
  const next={...value,received,status:received===value.dispatched?'received':'in_transit',history:stamp(value,'receive','按实际收货增加目的仓；未收部分继续在途。',quantity)};
  return {inventory:entry,action:{action:'addQuantity',quantity},after,next,label:'确认收货并增加目的仓'};
}
export function applyCount(value:WmsValue,entry:Inventory):WmsEffect{
  if(value.type!=='count'||value.status!=='reviewed')throw new Error('盘点单必须先复核，再确认过账。');
  sameTarget(entry,value.source);
  if(entry.version!==value.source.version||entry.quantityOnStock!==value.source.quantity)throw new Error('盘点快照后库存已变化，不能覆盖。请重新读取库存并重新录入盘点单。');
  const after=stockNumber(value.counted!);
  if(after===entry.quantityOnStock)throw new Error('盘点数量没有差异，无需调整库存。');
  return {inventory:entry,action:{action:'changeQuantity',quantity:after},after,next:{...value,status:'applied',history:stamp(value,'apply','已按快照版本应用 CT 销售库存盘点差异。',after-entry.quantityOnStock)},label:'确认盘点差异并过账'};
}
function assertNoInventoryEffects(value:WmsValue){
  const workflow=value as WmsValue&{pending?:unknown;inventorySteps?:unknown};
  if(workflow.pending!==undefined)throw new Error('单据有待核对库存步骤，不能取消或无差异结案。请先恢复原步骤。');
  if(workflow.inventorySteps!==undefined&&(!Array.isArray(workflow.inventorySteps)||workflow.inventorySteps.length>0))throw new Error('单据已有库存步骤或记录格式不明，不能取消或无差异结案。');
  if(stockNumber(value.dispatched)!==0||stockNumber(value.received)!==0)throw new Error('单据已发出或收货，不能取消或无差异结案。');
}
export function cancelWmsDocument(value:WmsValue,reason:string):WmsValue{
  assertNoInventoryEffects(value);
  if(!((value.type==='transfer'&&value.status==='planned')||(value.type==='count'&&['counted','reviewed'].includes(value.status))))throw new Error('只有未发出的调拨或未过账盘点可以取消。');
  const closureReason=wmsText(reason,'取消原因',500,true);
  return {...value,status:'cancelled',closedAt:new Date().toISOString(),closureReason,history:stamp(value,'cancel',`取消单据；未更改库存。原因：${closureReason}`)};
}
export function closeUnchangedCount(value:WmsValue,entry:Inventory):WmsValue{
  assertNoInventoryEffects(value);
  if(value.type!=='count'||value.status!=='reviewed')throw new Error('无差异结案前必须先复核盘点值。');
  sameTarget(entry,value.source);
  if(entry.version!==value.source.version||entry.quantityOnStock!==value.source.quantity)throw new Error('盘点快照后库存已变化，不能按旧快照结案。请取消旧单后重新盘点。');
  if(stockNumber(value.counted!)!==entry.quantityOnStock)throw new Error('盘点存在差异，不能按无差异结案。');
  const closureReason='读取时库存与原快照版本、数量及盘点值一致；仅结案，不修改库存。';
  return {...value,status:'closed_no_change',closedAt:new Date().toISOString(),closureReason,history:stamp(value,'close_no_change',closureReason,0)};
}
export function validWmsValue(value:unknown,mode:WmsMode):value is WmsValue{
  if(!value||typeof value!=='object')return false;
  const v=value as WmsValue;
  return v.schemaVersion===1&&v.type===mode&&typeof v.status==='string'&&typeof v.sku==='string'&&!!v.source&&typeof v.source.id==='string'&&Array.isArray(v.history);
}
export const WMS_STATUS:Record<string,string>={planned:'待发出',in_transit:'在途 / 待收货',received:'已收齐',counted:'待复核',reviewed:'已复核 / 待过账',applied:'已过账',closed_no_change:'无差异已结案',cancelled:'已取消'};
export const WMS_MODE_STATUSES:Record<WmsMode,readonly string[]>={transfer:['planned','in_transit','received','cancelled'],count:['counted','reviewed','applied','closed_no_change','cancelled']};
