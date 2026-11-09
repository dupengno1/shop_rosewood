import {fulfillmentLines,type OrderResource,type OrderLine} from './domain';

export const OMS_CONTAINER='rw-mc-oms-operations';
type ReturnItem={id?:string;key?:string;lineItemId?:string;customLineItemId?:string;quantity:number;shipmentState?:string;paymentState?:string};
export type OmsOrder=OrderResource&{id:string;inventoryMode?:string;totalPrice?:{centAmount:number;currencyCode:string;fractionDigits?:number};returnInfo?:Array<{items:ReturnItem[]}>};
export type OmsInventory={id:string;version:number;sku:string;quantityOnStock:number;availableQuantity:number;supplyChannel?:{id:string;obj?:{key?:string;roles?:string[];name?:Record<string,string>}}};
export type Approval={status:'pending'|'approved'|'rejected';reviewedAt?:string;reason?:string};
type RequestBase={id:string;createdAt:string;orderVersionObserved:number;approval?:Approval};
type Cancellation={cancelledAt?:string;cancellationReason?:string};
export type Allocation=RequestBase&{status:'planned'|'cancelled';lineItemId:string;sku:string;inventoryEntryId:string;supplyChannelId?:string;quantity:number;inventoryVersionObserved:number;inventoryMode:string;reason:string};
export type ReturnRequest=RequestBase&Cancellation&{status:'requested'|'receiving'|'received'|'cancelled';kind:'return'|'exchange';lineItemId:string;lineKind:'lineItem'|'customLineItem';quantity:number;reason:string;replacementSku?:string;itemKey:string;attemptedOrderVersion?:number;returnItemId?:string};
export type RefundRequest=RequestBase&Cancellation&{status:'requested'|'executing'|'completed'|'rejected'|'cancelled';amount:number;currencyCode:string;reason:string};
export type ConsignmentRecord={id:string;groupId:string;status:'Pending'|'Picking'|'Packed'|'Shipped'|'Delivered'|'Failed Delivery';updatedAt:string;reason:string;orderVersionObserved:number};
export const consignmentTransitions:Record<ConsignmentRecord['status'],ConsignmentRecord['status'][]>= {Pending:['Picking'],Picking:['Packed'],Packed:['Shipped'],Shipped:['Delivered','Failed Delivery'],'Failed Delivery':['Shipped'],Delivered:[]};
export type OmsOperations={schemaVersion:1;orderId:string;allocations:Allocation[];returns:ReturnRequest[];refunds:RefundRequest[];consignments?:ConsignmentRecord[]};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function text(value:unknown,label:string,max=500):string{check(typeof value==='string',`${label} has an invalid format.`);check(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value),`${label} must not contain control characters or line breaks.`);const result=value.trim();check(result.length>0&&result.length<=max,`${label} must contain 1–${max}  characters.`);return result;}
function quantity(value:string|number,label='Quantity'):number{check(typeof value==='number'||/^\d+$/.test(value.trim()),`${label} must be a positive integer.`);const result=Number(value);check(Number.isSafeInteger(result)&&result>0,`${label} must be a positive safe integer.`);return result;}
function sum(values:number[]):number{const result=values.reduce((a,b)=>a+b,0);check(Number.isSafeInteger(result)&&result>=0,'The cumulative quantity or amount is invalid. Review historical records first.');return result;}
function base(order:OmsOrder,id:string,at:string):RequestBase{check(uuid.test(order.id)&&uuid.test(id),'Invalid order or request identifier.');check(Number.isSafeInteger(order.version)&&Number(order.version)>0,'Order version is missing. Refresh the order.');check(Number.isFinite(Date.parse(at)),'Invalid request time.');return {id,createdAt:at,orderVersionObserved:order.version!};}
function cancellation(request:RequestBase,reason:string,at:string):Required<Cancellation>{
  check(Number.isFinite(Date.parse(at))&&Date.parse(at)>=Date.parse(request.createdAt),'Cancellation time is invalid or precedes the request.');
  return {cancelledAt:at,cancellationReason:text(reason,'Cancellation reason')};
}
function validateCancellation(request:RequestBase&Cancellation&{status:string},allowLegacyRefund=false):void{
  // Refund cancellations predate the audit fields. Keep those existing records readable;
  // all new transitions below still require both a reason and a valid timestamp.
  if(allowLegacyRefund&&request.status==='cancelled'&&request.cancelledAt===undefined&&request.cancellationReason===undefined)return;
  if(request.status==='cancelled')cancellation(request,request.cancellationReason!,request.cancelledAt!);
  else check(request.cancelledAt===undefined&&request.cancellationReason===undefined,'A non-cancelled request cannot contain cancellation details. Review its history.');
}
export function emptyOmsOperations(orderId:string):OmsOperations{check(uuid.test(orderId),'Invalid order identifier.');return {schemaVersion:1,orderId,allocations:[],returns:[],refunds:[]};}
export function validateOmsOperations(value:unknown,orderId:string):OmsOperations{
  check(value&&typeof value==='object','Invalid operations record format.');const data=value as OmsOperations;
  check(data.schemaVersion===1&&data.orderId===orderId,'Operations schema or order does not match.');
  check(Array.isArray(data.allocations)&&Array.isArray(data.returns)&&Array.isArray(data.refunds),'Invalid operations collections.');
  const ids=new Set<string>();
  for(const request of [...data.allocations,...data.returns,...data.refunds]){check(request&&uuid.test(request.id)&&!ids.has(request.id),'Invalid or duplicate operation identifier.');ids.add(request.id);check(Number.isSafeInteger(request.orderVersionObserved)&&request.orderVersionObserved>0&&Number.isFinite(Date.parse(request.createdAt)),'Invalid operation version or time.');}
  for(const allocation of data.allocations){check(['planned','cancelled'].includes(allocation.status)&&uuid.test(allocation.lineItemId)&&uuid.test(allocation.inventoryEntryId),'Invalid allocation record.');quantity(allocation.quantity);}
  for(const request of data.returns){check(['requested','receiving','received','cancelled'].includes(request.status)&&['return','exchange'].includes(request.kind)&&uuid.test(request.lineItemId)&&['lineItem','customLineItem'].includes(request.lineKind)&&request.itemKey===`rw-return-${request.id}`,'Invalid return or exchange record.');quantity(request.quantity);validateCancellation(request);if(request.status==='cancelled')check(request.returnItemId===undefined&&request.attemptedOrderVersion===undefined,'A request with a receipt or receipt intent cannot be marked cancelled.');}
  for(const request of data.refunds){check(['requested','executing','completed','rejected','cancelled'].includes(request.status)&&/^[A-Z]{3}$/.test(request.currencyCode),'Invalid refund request record.');quantity(request.amount,'Refund amount');validateCancellation(request,true);}
  for(const request of [...data.returns,...data.refunds])if(request.approval){check(['pending','approved','rejected'].includes(request.approval.status),'Invalid approval status.');if(request.approval.status!=='pending')check(Number.isFinite(Date.parse(request.approval.reviewedAt||''))&&typeof request.approval.reason==='string'&&request.approval.reason.trim(),'Approval requires a review time and reason.');}
  if(data.consignments!==undefined){check(Array.isArray(data.consignments)&&data.consignments.length<=100,'Invalid consignments.');const groups=new Set<string>();for(const row of data.consignments){check(uuid.test(row.id)&&!ids.has(row.id)&&!groups.has(row.groupId)&&typeof row.groupId==='string'&&row.groupId.length<=100&&['Pending','Picking','Packed','Shipped','Delivered','Failed Delivery'].includes(row.status)&&Number.isFinite(Date.parse(row.updatedAt))&&Number.isSafeInteger(row.orderVersionObserved)&&row.orderVersionObserved>0,'Invalid consignment record.');text(row.reason,'Status reason');groups.add(row.groupId);ids.add(row.id);}}
  return data;
}
function ensureNew(data:OmsOperations,order:OmsOrder,id:string){validateOmsOperations(data,order.id);check(![...data.allocations,...data.returns,...data.refunds,...(data.consignments||[])].some(item=>item.id===id),'This request already exists. Refresh to verify; do not save a duplicate.');check(data.allocations.length+data.returns.length+data.refunds.length<200,'This order has reached the operations record limit. Contact your administrator to archive it.');}
function physical(order:OmsOrder,lineId:string){const lines=fulfillmentLines(order);check(!lines.some(line=>line.overDelivered),'Historical deliveries exceed the ordered quantity. Review them first.');const line=lines.find(item=>item.id===lineId);check(line&&line.classification.type==='physical','This action requires a confirmed physical item.');return line;}
export function originalLine(order:OmsOrder,lineId:string):OrderLine{const line=[...(order.lineItems||[]),...(order.customLineItems||[])].find(item=>item.id===lineId);check(line,'The order item does not exist.');return line;}
export function lineInventoryContext(order:OmsOrder,lineId:string){const line=originalLine(order,lineId);const channel=line.supplyChannel as {id?:string}|undefined;return {supplyChannelId:channel?.id,inventoryMode:typeof line.inventoryMode==='string'?line.inventoryMode:order.inventoryMode||'Unknown'};}
export function createAllocation(order:OmsOrder,data:OmsOperations,inventory:OmsInventory,input:{id:string;lineItemId:string;quantity:string|number;reason:string},at=new Date().toISOString()):OmsOperations{
  ensureNew(data,order,input.id);check(order.orderState!=='Cancelled','Cancelled orders cannot create new allocation plans.');
  const line=physical(order,input.lineItemId),amount=quantity(input.quantity),context=lineInventoryContext(order,line.id);
  check(line.kind==='lineItem'&&line.sku&&inventory.sku===line.sku,'A plan must use the inventory entry for the same SKU.');
  check(uuid.test(inventory.id)&&Number.isSafeInteger(inventory.version)&&inventory.version>0,'Invalid inventory identifier or version.');
  if(inventory.supplyChannel)check(uuid.test(inventory.supplyChannel.id)&&inventory.supplyChannel.obj?.roles?.includes('InventorySupply'),'The selected channel is not an InventorySupply channel.');
  if(context.inventoryMode!=='None')check(context.supplyChannelId===inventory.supplyChannel?.id,'The item stock is tracked, reserved or unknown; reassignment across the original warehouse is not allowed here.');
  else check(Number.isSafeInteger(inventory.availableQuantity)&&amount<=inventory.availableQuantity,'Insufficient available inventory was observed. Nothing was saved or reserved.');
  const planned=sum(data.allocations.filter(item=>item.lineItemId===line.id&&item.status==='planned').map(item=>item.quantity));
  check(planned+amount<=line.remainingQuantity,'The combined allocation plans exceed the remaining unshipped quantity.');
  const allocation:Allocation={...base(order,input.id,at),status:'planned',lineItemId:line.id,sku:line.sku,inventoryEntryId:inventory.id,
    ...(inventory.supplyChannel&&{supplyChannelId:inventory.supplyChannel.id}),quantity:amount,inventoryVersionObserved:inventory.version,inventoryMode:context.inventoryMode,reason:text(input.reason,'Allocation Reason')};
  return {...data,allocations:[...data.allocations,allocation]};
}
export function cancelAllocation(data:OmsOperations,id:string):OmsOperations{const found=data.allocations.find(item=>item.id===id);check(found&&found.status==='planned','This plan has changed. Refresh it.');return {...data,allocations:data.allocations.map(item=>item.id===id?{...item,status:'cancelled'}:item)};}
function nativeReturns(order:OmsOrder):ReturnItem[]{const items=(order.returnInfo||[]).flatMap(info=>info.items||[]);for(const item of items){quantity(item.quantity);check(Boolean(item.lineItemId)!==Boolean(item.customLineItemId),'Invalid historical return item identifier.');}return items;}
export function returnCapacity(order:OmsOrder,data:OmsOperations,lineId:string,excludeRequestId?:string):number{
  validateOmsOperations(data,order.id);
  const line=physical(order,lineId),items=nativeReturns(order),keys=new Set(items.map(item=>item.key).filter(Boolean));
  check(!data.returns.some(item=>item.status==='cancelled'&&keys.has(item.itemKey)),'A cancelled request has a native return record. Review it before releasing return capacity.');
  const returned=sum(items.filter(item=>(item.lineItemId||item.customLineItemId)===lineId).map(item=>item.quantity));
  const pending=sum(data.returns.filter(item=>item.lineItemId===lineId&&item.id!==excludeRequestId&&item.status!=='cancelled'&&!keys.has(item.itemKey)).map(item=>item.quantity));
  check(returned+pending<=line.deliveredQuantity,'Existing returns and pending requests exceed recorded deliveries. Review them first.');
  return line.deliveredQuantity-returned-pending;
}
export function createReturnRequest(order:OmsOrder,data:OmsOperations,input:{id:string;kind:'return'|'exchange';lineItemId:string;quantity:string|number;reason:string;replacementSku?:string},at=new Date().toISOString()):OmsOperations{
  ensureNew(data,order,input.id);check(['return','exchange'].includes(input.kind),'Invalid return or exchange type.');const line=physical(order,input.lineItemId),amount=quantity(input.quantity);
  check(amount<=returnCapacity(order,data,line.id),'The requested quantity exceeds the remaining return capacity.');
  const request:ReturnRequest={...base(order,input.id,at),status:'requested',approval:{status:'pending'},kind:input.kind,lineItemId:line.id,lineKind:line.kind,quantity:amount,reason:text(input.reason,'Return / Exchange Reason'),itemKey:`rw-return-${input.id}`,
    ...(input.kind==='exchange'&&{replacementSku:text(input.replacementSku,'Replacement SKU',256)})};
  return {...data,returns:[...data.returns,request]};
}
export function findRecordedReturn(order:OmsOrder,request:ReturnRequest):ReturnItem|undefined{
  const found=nativeReturns(order).filter(item=>item.key===request.itemKey);check(found.length<=1,'Duplicate native return key. Manual review is required.');
  if(found.length){const item=found[0];check((request.lineKind==='lineItem'?item.lineItemId:item.customLineItemId)===request.lineItemId&&item.quantity===request.quantity,'The native return key exists but its item or quantity differs from this request.');check(['Returned','BackInStock','Unusable'].includes(item.shipmentState||''),'The native return state does not confirm physical receipt.');check(Boolean(item.id),'The native return record has no identifier.');return item;}
  return undefined;
}
export function cancelReturnRequest(order:OmsOrder,data:OmsOperations,requestId:string,reason:string,at=new Date().toISOString()):OmsOperations{
  validateOmsOperations(data,order.id);const request=data.returns.find(item=>item.id===requestId);
  check(request&&request.status==='requested','Only pending return or exchange requests can be cancelled. Receipt in progress, received and cancelled requests cannot be withdrawn.');
  check(request.returnItemId===undefined&&request.attemptedOrderVersion===undefined,'This request has a receipt or receipt intent. Verify its outcome before any further action.');
  check(!nativeReturns(order).some(item=>item.key===request.itemKey),'The native order already has the return key for this request. It cannot be cancelled or its native state changed here.');
  const audit=cancellation(request,reason,at);base(order,request.id,at);
  return {...data,returns:data.returns.map(item=>item.id===requestId?{...item,status:'cancelled',...audit}:item)};
}
export function prepareReturnReceipt(order:OmsOrder,data:OmsOperations,requestId:string):{intent:OmsOperations;action:{action:'addReturnInfo';items:Array<{key:string;quantity:number;lineItemId?:string;customLineItemId?:string;comment:string;shipmentState:'Returned'}>}}{
  validateOmsOperations(data,order.id);const request=data.returns.find(item=>item.id===requestId);check(request&&request.status==='requested','This return request is not awaiting receipt. Verify existing results first.');
  check(request.approval?.status!=='rejected','A rejected return request cannot be received.');
  check(!findRecordedReturn(order,request),'A native return already exists for this request. Verify it; do not create a duplicate.');
  check(physical(order,request.lineItemId).kind===request.lineKind,'The order item type has changed. Review the request.');check(request.quantity<=returnCapacity(order,data,request.lineItemId,request.id),'The receipt quantity exceeds current return capacity.');
  base(order,request.id,request.createdAt);
  const intent={...data,returns:data.returns.map(item=>item.id===request.id?{...item,status:'receiving' as const,attemptedOrderVersion:order.version!}:item)};
  return {intent,action:{action:'addReturnInfo',items:[{key:request.itemKey,quantity:request.quantity,
    ...(request.lineKind==='lineItem'?{lineItemId:request.lineItemId}:{customLineItemId:request.lineItemId}),comment:request.reason,shipmentState:'Returned'}]}};
}
export function reconcileReturnReceipt(order:OmsOrder,data:OmsOperations,requestId:string):OmsOperations{
  validateOmsOperations(data,order.id);const request=data.returns.find(item=>item.id===requestId);check(request,'The return request does not exist.');const record=findRecordedReturn(order,request);
  check(request.status!=='cancelled','A cancelled request cannot be marked received. Review the native records manually.');
  check(record,'Native receipt has not been confirmed. Keep the pending intent; no automatic retry. Check the native order or contact your administrator.');
  return {...data,returns:data.returns.map(item=>item.id===requestId?{...item,status:'received',returnItemId:record.id}:item)};
}
export function releaseRejectedReceipt(data:OmsOperations,requestId:string,status:number):OmsOperations{
  check(Number.isInteger(status)&&status>=400&&status<500&&status!==408&&status!==429,'An uncertain result cannot reopen receipt submission.');
  const request=data.returns.find(item=>item.id===requestId);check(request?.status==='receiving','No receipt intent is awaiting reconciliation.');
  return {...data,returns:data.returns.map(item=>{if(item.id!==requestId)return item;const {attemptedOrderVersion,...reopened}=item;return {...reopened,status:'requested'};})};
}
export function refundBudget(order:OmsOrder,data:OmsOperations):{currencyCode:string;total:number;requested:number;remaining:number;fractionDigits:number}{
  const price=order.totalPrice;check(price&&Number.isSafeInteger(price.centAmount)&&price.centAmount>=0&&/^[A-Z]{3}$/.test(price.currencyCode),'The order total or currency is unavailable; the request limit cannot be calculated.');
  check(data.refunds.every(item=>item.currencyCode===price.currencyCode),'Historical refund currency differs from the order currency. Review it.');
  const requested=sum(data.refunds.filter(item=>!['cancelled','rejected'].includes(item.status)).map(item=>item.amount));check(requested<=price.centAmount,'Cumulative refund requests exceed the order total. Review them.');
  const fractionDigits=price.fractionDigits??2;check(Number.isSafeInteger(fractionDigits)&&fractionDigits>=0&&fractionDigits<=6,'Invalid currency precision.');
  return {currencyCode:price.currencyCode,total:price.centAmount,requested,remaining:price.centAmount-requested,fractionDigits};
}
export function createRefundRequest(order:OmsOrder,data:OmsOperations,input:{id:string;amount:string|number;currencyCode:string;reason:string},at=new Date().toISOString()):OmsOperations{
  ensureNew(data,order,input.id);const budget=refundBudget(order,data),amount=quantity(input.amount,'Minor-unit amount');check(input.currencyCode===budget.currencyCode,'Request currency must match the native order currency.');check(amount<=budget.remaining,'The amount exceeds the request limit after pending and completed requests.');
  check(!nativeReturns(order).some(item=>item.paymentState==='Refunded'),'The native order has refunded return items. Payment reconciliation is required to determine the remaining request allowance.');
  const request:RefundRequest={...base(order,input.id,at),status:'requested',approval:{status:'pending'},amount,currencyCode:budget.currencyCode,reason:text(input.reason,'Refund Reason')};return {...data,refunds:[...data.refunds,request]};
}
export function cancelRefundRequest(order:OmsOrder,data:OmsOperations,requestId:string,reason:string,at=new Date().toISOString()):OmsOperations{
  validateOmsOperations(data,order.id);const request=data.refunds.find(item=>item.id===requestId);
  check(request&&request.status==='requested','Only pending refund requests can be cancelled. Executing, completed or closed records cannot be withdrawn.');
  const audit=cancellation(request,reason,at);base(order,request.id,at);
  return {...data,refunds:data.refunds.map(item=>item.id===requestId?{...item,status:'cancelled',...audit}:item)};
}

export function reviewOmsRequest(order:OmsOrder,data:OmsOperations,collection:'returns'|'refunds',id:string,status:'approved'|'rejected',reason:string,at=new Date().toISOString()):OmsOperations{
 validateOmsOperations(data,order.id);const request=data[collection].find(item=>item.id===id);
 check(request&&request.status==='requested','Only pending requests can be reviewed.');
 check(!request.approval||request.approval.status==='pending','This request has already been reviewed.');
 check(status==='approved'||status==='rejected','Invalid approval decision.');
 check(Number.isFinite(Date.parse(at))&&Date.parse(at)>=Date.parse(request.createdAt),'Invalid review time.');
 const approval:Approval={status,reviewedAt:at,reason:text(reason,'Approval reason')};
 if(collection==='refunds')return {...data,refunds:data.refunds.map(item=>item.id===id?{...item,approval,...(status==='rejected'?{status:'rejected' as const}:{})}:item)};
 return {...data,returns:data.returns.map(item=>item.id===id?{...item,approval}:item)};
}
export function updateConsignment(order:OmsOrder,data:OmsOperations,input:{id:string;groupId:string;status:ConsignmentRecord['status'];reason:string},allowedGroups:string[],at=new Date().toISOString()):OmsOperations{
 validateOmsOperations(data,order.id);check(order.orderState!=='Cancelled','Cancelled orders cannot update fulfilment progress.');check(allowedGroups.includes(input.groupId),'Consignment is not present on the current order.');
 const previous=(data.consignments||[]).find(row=>row.groupId===input.groupId),status=previous?.status||'Pending';
 if(!previous)check(![...data.allocations,...data.returns,...data.refunds,...(data.consignments||[])].some(row=>row.id===input.id),'The operation identifier already exists.');
 check(Boolean(previous)||(data.consignments||[]).length<100,'The consignment record limit has been reached.');
 check(consignmentTransitions[status].includes(input.status),'Invalid consignment transition. Follow Pending, Picking, Packed, Shipped, then Delivered or Failed Delivery.');
 base(order,input.id,at);check(!previous||previous.id===input.id,'Consignment identity changed.');check(!previous||Date.parse(at)>=Date.parse(previous.updatedAt),'Status time precedes the previous update.');
 const row:ConsignmentRecord={id:input.id,groupId:input.groupId,status:input.status,reason:text(input.reason,'Status reason'),updatedAt:at,orderVersionObserved:order.version!};
 return {...data,consignments:[...(data.consignments||[]).filter(item=>item.groupId!==input.groupId),row]};
}
