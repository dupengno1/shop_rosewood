import {fulfillmentLines,type OrderResource,type OrderLine} from './domain';

export const OMS_CONTAINER='rw-mc-oms-operations';
type ReturnItem={id?:string;key?:string;lineItemId?:string;customLineItemId?:string;quantity:number;shipmentState?:string;paymentState?:string};
export type OmsOrder=OrderResource&{id:string;inventoryMode?:string;totalPrice?:{centAmount:number;currencyCode:string;fractionDigits?:number};returnInfo?:Array<{items:ReturnItem[]}>};
export type OmsInventory={id:string;version:number;sku:string;quantityOnStock:number;availableQuantity:number;supplyChannel?:{id:string;obj?:{key?:string;roles?:string[];name?:Record<string,string>}}};
type RequestBase={id:string;createdAt:string;orderVersionObserved:number};
export type Allocation=RequestBase&{status:'planned'|'cancelled';lineItemId:string;sku:string;inventoryEntryId:string;supplyChannelId?:string;quantity:number;inventoryVersionObserved:number;inventoryMode:string;reason:string};
export type ReturnRequest=RequestBase&{status:'requested'|'receiving'|'received';kind:'return'|'exchange';lineItemId:string;lineKind:'lineItem'|'customLineItem';quantity:number;reason:string;replacementSku?:string;itemKey:string;attemptedOrderVersion?:number;returnItemId?:string};
export type RefundRequest=RequestBase&{status:'requested'|'executing'|'completed'|'rejected'|'cancelled';amount:number;currencyCode:string;reason:string};
export type OmsOperations={schemaVersion:1;orderId:string;allocations:Allocation[];returns:ReturnRequest[];refunds:RefundRequest[]};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function text(value:unknown,label:string,max=500):string{check(typeof value==='string',`${label}格式不正确。`);check(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value),`${label}不能包含控制字符或换行。`);const result=value.trim();check(result.length>0&&result.length<=max,`${label}须为 1–${max} 个字符。`);return result;}
function quantity(value:string|number,label='数量'):number{check(typeof value==='number'||/^\d+$/.test(value.trim()),`${label}须为正整数。`);const result=Number(value);check(Number.isSafeInteger(result)&&result>0,`${label}须为安全范围内的正整数。`);return result;}
function sum(values:number[]):number{const result=values.reduce((a,b)=>a+b,0);check(Number.isSafeInteger(result)&&result>=0,'累计数量或金额无效，请先核对历史数据。');return result;}
function base(order:OmsOrder,id:string,at:string):RequestBase{check(uuid.test(order.id)&&uuid.test(id),'订单或请求标识无效。');check(Number.isSafeInteger(order.version)&&Number(order.version)>0,'订单版本缺失，请刷新。');check(Number.isFinite(Date.parse(at)),'请求时间无效。');return {id,createdAt:at,orderVersionObserved:order.version!};}
export function emptyOmsOperations(orderId:string):OmsOperations{check(uuid.test(orderId),'订单标识无效。');return {schemaVersion:1,orderId,allocations:[],returns:[],refunds:[]};}
export function validateOmsOperations(value:unknown,orderId:string):OmsOperations{
  check(value&&typeof value==='object','运营记录格式无效。');const data=value as OmsOperations;
  check(data.schemaVersion===1&&data.orderId===orderId,'运营记录版本或订单不匹配。');
  check(Array.isArray(data.allocations)&&Array.isArray(data.returns)&&Array.isArray(data.refunds),'运营记录集合无效。');
  const ids=new Set<string>();
  for(const request of [...data.allocations,...data.returns,...data.refunds]){check(request&&uuid.test(request.id)&&!ids.has(request.id),'运营请求标识无效或重复。');ids.add(request.id);check(Number.isSafeInteger(request.orderVersionObserved)&&request.orderVersionObserved>0&&Number.isFinite(Date.parse(request.createdAt)),'运营请求版本或时间无效。');}
  for(const allocation of data.allocations){check(['planned','cancelled'].includes(allocation.status)&&uuid.test(allocation.lineItemId)&&uuid.test(allocation.inventoryEntryId),'分仓记录无效。');quantity(allocation.quantity);}
  for(const request of data.returns){check(['requested','receiving','received'].includes(request.status)&&['return','exchange'].includes(request.kind)&&uuid.test(request.lineItemId)&&['lineItem','customLineItem'].includes(request.lineKind)&&request.itemKey===`rw-return-${request.id}`,'退换记录无效。');quantity(request.quantity);}
  for(const request of data.refunds){check(['requested','executing','completed','rejected','cancelled'].includes(request.status)&&/^[A-Z]{3}$/.test(request.currencyCode),'退款申请记录无效。');quantity(request.amount,'退款金额');}
  return data;
}
function ensureNew(data:OmsOperations,order:OmsOrder,id:string){validateOmsOperations(data,order.id);check(![...data.allocations,...data.returns,...data.refunds].some(item=>item.id===id),'请求已存在，请刷新核对，勿重复保存。');check(data.allocations.length+data.returns.length+data.refunds.length<200,'此订单已达到工作台记录上限，请由后台归档处理。');}
function physical(order:OmsOrder,lineId:string){const lines=fulfillmentLines(order);check(!lines.some(line=>line.overDelivered),'历史发运量超过订购量，请先核对。');const line=lines.find(item=>item.id===lineId);check(line&&line.classification.type==='physical','只能为已明确分类的实物行操作。');return line;}
export function originalLine(order:OmsOrder,lineId:string):OrderLine{const line=[...(order.lineItems||[]),...(order.customLineItems||[])].find(item=>item.id===lineId);check(line,'订单行不存在。');return line;}
export function lineInventoryContext(order:OmsOrder,lineId:string){const line=originalLine(order,lineId);const channel=line.supplyChannel as {id?:string}|undefined;return {supplyChannelId:channel?.id,inventoryMode:typeof line.inventoryMode==='string'?line.inventoryMode:order.inventoryMode||'Unknown'};}
export function createAllocation(order:OmsOrder,data:OmsOperations,inventory:OmsInventory,input:{id:string;lineItemId:string;quantity:string|number;reason:string},at=new Date().toISOString()):OmsOperations{
  ensureNew(data,order,input.id);check(order.orderState!=='Cancelled','已取消订单不能保存新的分仓计划。');
  const line=physical(order,input.lineItemId),amount=quantity(input.quantity),context=lineInventoryContext(order,line.id);
  check(line.kind==='lineItem'&&line.sku&&inventory.sku===line.sku,'计划必须绑定同一真实 SKU 的库存记录。');
  check(uuid.test(inventory.id)&&Number.isSafeInteger(inventory.version)&&inventory.version>0,'库存标识或版本无效。');
  if(inventory.supplyChannel)check(uuid.test(inventory.supplyChannel.id)&&inventory.supplyChannel.obj?.roles?.includes('InventorySupply'),'所选渠道未确认为 InventorySupply。');
  if(context.inventoryMode!=='None')check(context.supplyChannelId===inventory.supplyChannel?.id,'此订单行已采用库存跟踪/预留或模式不明，不能在本面板跨原仓改派。');
  else check(Number.isSafeInteger(inventory.availableQuantity)&&amount<=inventory.availableQuantity,'当前观察到的可用库存不足；尚未保存或预留。');
  const planned=sum(data.allocations.filter(item=>item.lineItemId===line.id&&item.status==='planned').map(item=>item.quantity));
  check(planned+amount<=line.remainingQuantity,'本次与已有有效分仓计划合计超过当前未发运数量。');
  const allocation:Allocation={...base(order,input.id,at),status:'planned',lineItemId:line.id,sku:line.sku,inventoryEntryId:inventory.id,
    ...(inventory.supplyChannel&&{supplyChannelId:inventory.supplyChannel.id}),quantity:amount,inventoryVersionObserved:inventory.version,inventoryMode:context.inventoryMode,reason:text(input.reason,'分仓说明')};
  return {...data,allocations:[...data.allocations,allocation]};
}
export function cancelAllocation(data:OmsOperations,id:string):OmsOperations{const found=data.allocations.find(item=>item.id===id);check(found&&found.status==='planned','该计划已变化，请刷新。');return {...data,allocations:data.allocations.map(item=>item.id===id?{...item,status:'cancelled'}:item)};}
function nativeReturns(order:OmsOrder):ReturnItem[]{const items=(order.returnInfo||[]).flatMap(info=>info.items||[]);for(const item of items){quantity(item.quantity);check(Boolean(item.lineItemId)!==Boolean(item.customLineItemId),'历史退货行标识无效。');}return items;}
export function returnCapacity(order:OmsOrder,data:OmsOperations,lineId:string,excludeRequestId?:string):number{
  const line=physical(order,lineId),items=nativeReturns(order),keys=new Set(items.map(item=>item.key).filter(Boolean));
  const returned=sum(items.filter(item=>(item.lineItemId||item.customLineItemId)===lineId).map(item=>item.quantity));
  const pending=sum(data.returns.filter(item=>item.lineItemId===lineId&&item.id!==excludeRequestId&&!keys.has(item.itemKey)).map(item=>item.quantity));
  check(returned+pending<=line.deliveredQuantity,'已有退货/待执行申请超过已登记发运量，请先核对。');
  return line.deliveredQuantity-returned-pending;
}
export function createReturnRequest(order:OmsOrder,data:OmsOperations,input:{id:string;kind:'return'|'exchange';lineItemId:string;quantity:string|number;reason:string;replacementSku?:string},at=new Date().toISOString()):OmsOperations{
  ensureNew(data,order,input.id);check(['return','exchange'].includes(input.kind),'退换类型无效。');const line=physical(order,input.lineItemId),amount=quantity(input.quantity);
  check(amount<=returnCapacity(order,data,line.id),'申请数量超过尚可申请退换的已登记发运数量。');
  const request:ReturnRequest={...base(order,input.id,at),status:'requested',kind:input.kind,lineItemId:line.id,lineKind:line.kind,quantity:amount,reason:text(input.reason,'退换原因'),itemKey:`rw-return-${input.id}`,
    ...(input.kind==='exchange'&&{replacementSku:text(input.replacementSku,'期望替换 SKU',256)})};
  return {...data,returns:[...data.returns,request]};
}
export function findRecordedReturn(order:OmsOrder,request:ReturnRequest):ReturnItem|undefined{
  const found=nativeReturns(order).filter(item=>item.key===request.itemKey);check(found.length<=1,'原生退货键重复，请人工核对。');
  if(found.length){const item=found[0];check((request.lineKind==='lineItem'?item.lineItemId:item.customLineItemId)===request.lineItemId&&item.quantity===request.quantity,'原生退货键已存在，但行或数量与本申请不同。');check(['Returned','BackInStock','Unusable'].includes(item.shipmentState||''),'原生退货键对应的记录尚不能证明已经实收。');check(Boolean(item.id),'原生退货记录缺少标识。');return item;}
  return undefined;
}
export function prepareReturnReceipt(order:OmsOrder,data:OmsOperations,requestId:string):{intent:OmsOperations;action:{action:'addReturnInfo';items:Array<{key:string;quantity:number;lineItemId?:string;customLineItemId?:string;comment:string;shipmentState:'Returned'}>}}{
  validateOmsOperations(data,order.id);const request=data.returns.find(item=>item.id===requestId);check(request&&request.status==='requested','退货申请不是待实收状态；请先核对已有结果。');
  check(!findRecordedReturn(order,request),'此申请已存在原生退货记录，请核对，勿重复登记。');
  check(physical(order,request.lineItemId).kind===request.lineKind,'申请中的订单行类型已变化，请核对。');check(request.quantity<=returnCapacity(order,data,request.lineItemId,request.id),'实收数量超过当前可退数量。');
  base(order,request.id,request.createdAt);
  const intent={...data,returns:data.returns.map(item=>item.id===request.id?{...item,status:'receiving' as const,attemptedOrderVersion:order.version!}:item)};
  return {intent,action:{action:'addReturnInfo',items:[{key:request.itemKey,quantity:request.quantity,
    ...(request.lineKind==='lineItem'?{lineItemId:request.lineItemId}:{customLineItemId:request.lineItemId}),comment:request.reason,shipmentState:'Returned'}]}};
}
export function reconcileReturnReceipt(order:OmsOrder,data:OmsOperations,requestId:string):OmsOperations{
  validateOmsOperations(data,order.id);const request=data.returns.find(item=>item.id===requestId);check(request,'退货申请不存在。');const record=findRecordedReturn(order,request);
  check(record,'尚未在原生订单中确认实收记录。保留待核对意图，不自动重发；请检查原生订单或联系管理员。');
  return {...data,returns:data.returns.map(item=>item.id===requestId?{...item,status:'received',returnItemId:record.id}:item)};
}
export function releaseRejectedReceipt(data:OmsOperations,requestId:string,status:number):OmsOperations{
  check(Number.isInteger(status)&&status>=400&&status<500&&status!==408&&status!==429,'结果不确定时不能重新开放实收提交。');
  const request=data.returns.find(item=>item.id===requestId);check(request?.status==='receiving','没有待核对的实收意图。');
  return {...data,returns:data.returns.map(item=>item.id===requestId?{...item,status:'requested'}:item)};
}
export function refundBudget(order:OmsOrder,data:OmsOperations):{currencyCode:string;total:number;requested:number;remaining:number;fractionDigits:number}{
  const price=order.totalPrice;check(price&&Number.isSafeInteger(price.centAmount)&&price.centAmount>=0&&/^[A-Z]{3}$/.test(price.currencyCode),'原生订单总额或币种不可用，不能计算申请上限。');
  check(data.refunds.every(item=>item.currencyCode===price.currencyCode),'历史退款申请币种与订单不一致，请核对。');
  const requested=sum(data.refunds.filter(item=>!['cancelled','rejected'].includes(item.status)).map(item=>item.amount));check(requested<=price.centAmount,'累计退款申请已超过订单总额，请核对。');
  const fractionDigits=price.fractionDigits??2;check(Number.isSafeInteger(fractionDigits)&&fractionDigits>=0&&fractionDigits<=6,'币种精度无效，请核对。');
  return {currencyCode:price.currencyCode,total:price.centAmount,requested,remaining:price.centAmount-requested,fractionDigits};
}
export function createRefundRequest(order:OmsOrder,data:OmsOperations,input:{id:string;amount:string|number;currencyCode:string;reason:string},at=new Date().toISOString()):OmsOperations{
  ensureNew(data,order,input.id);const budget=refundBudget(order,data),amount=quantity(input.amount,'最小货币单位金额');check(input.currencyCode===budget.currencyCode,'申请币种必须与原生订单一致。');check(amount<=budget.remaining,'金额超过扣除待执行/已完成申请后的本工作台申请上限。');
  check(!nativeReturns(order).some(item=>item.paymentState==='Refunded'),'原生订单已有已退款退货行，尚未接入支付对账，不能自动判定剩余可申请金额。');
  const request:RefundRequest={...base(order,input.id,at),status:'requested',amount,currencyCode:budget.currencyCode,reason:text(input.reason,'退款原因')};return {...data,refunds:[...data.refunds,request]};
}
