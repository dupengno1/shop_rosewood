import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyOmsOperations,validateOmsOperations,createAllocation,cancelAllocation,createReturnRequest,returnCapacity,
  prepareReturnReceipt,reconcileReturnReceipt,releaseRejectedReceipt,createRefundRequest,refundBudget,type OmsOrder,type OmsInventory} from './oms-domain';
const id=(n:number)=>`12345678-1234-1234-1234-${String(n).padStart(12,'0')}`;
const time='2026-11-05T11:00:00.000Z';
function order():OmsOrder{return {id:id(1),version:4,orderState:'Open',inventoryMode:'ReserveOnOrder',totalPrice:{centAmount:1000,currencyCode:'USD',fractionDigits:2},
  lineItems:[{id:id(2),name:{en:'Physical'},quantity:3,variant:{sku:'SKU-A'},supplyChannel:{id:id(3)},custom:{fields:{rwFulfillmentType:'physical'}}}],
  customLineItems:[{id:id(4),name:{en:'Tax'},key:'rw-tax',quantity:1,custom:{fields:{rwFulfillmentType:'physical'}}}],
  shippingInfo:{deliveries:[{id:id(5),items:[{id:id(2),quantity:2}],parcels:[]}]},returnInfo:[]};}
function inventory():OmsInventory{return {id:id(6),version:2,sku:'SKU-A',quantityOnStock:0,availableQuantity:0,supplyChannel:{id:id(3),obj:{roles:['InventorySupply'],key:'same-warehouse'}}};}
test('allocation stays in original tracked warehouse without rejecting already-consumed availability',()=>{
  const o=order(),data=emptyOmsOperations(o.id),input={id:id(10),lineItemId:id(2),quantity:'1',reason:'Use original fulfillment node'};
  const saved=createAllocation(o,data,inventory(),input,time);
  assert.equal(saved.allocations[0].status,'planned');assert.equal(saved.allocations[0].inventoryMode,'ReserveOnOrder');
  assert.equal(saved.allocations[0].inventoryEntryId,id(6));assert.equal(inventory().quantityOnStock,0);
  assert.throws(()=>createAllocation(o,data,{...inventory(),supplyChannel:{id:id(7),obj:{roles:['InventorySupply']}}},input,time),/跨原仓/);
  assert.throws(()=>createAllocation(o,data,{...inventory(),sku:'OTHER'},input,time),/同一真实/);
  assert.throws(()=>createAllocation(o,saved,inventory(),{...input,id:id(11)},time),/合计超过/);
  const cancelled=cancelAllocation(saved,id(10));assert.equal(createAllocation(o,cancelled,inventory(),{...input,id:id(11)},time).allocations.length,2);
});
test('allocation validates stock evidence for None mode, roles, classification, quantities and IDs',()=>{
  const o={...order(),inventoryMode:'None'},data=emptyOmsOperations(o.id),input={id:id(10),lineItemId:id(2),quantity:'1',reason:'Plan only'};
  assert.throws(()=>createAllocation(o,data,inventory(),input,time),/可用库存不足/);
  assert.equal(createAllocation(o,data,{...inventory(),availableQuantity:1},input,time).allocations.length,1);
  assert.throws(()=>createAllocation(o,data,{...inventory(),availableQuantity:1,supplyChannel:{id:id(3),obj:{roles:['ProductDistribution']}}},input,time),/InventorySupply/);
  assert.throws(()=>createAllocation(o,data,inventory(),{...input,lineItemId:id(4)},time),/实物/);
  assert.throws(()=>createAllocation(o,data,inventory(),{...input,quantity:'1.5'},time),/整数/);
  assert.throws(()=>createAllocation(o,data,inventory(),{...input,id:'invalid'},time));
});
test('return and exchange requests consume only eligible delivered quantity and persist replacement intent',()=>{
  const o=order(),input={id:id(10),kind:'exchange' as const,lineItemId:id(2),quantity:'1',reason:'Size does not fit',replacementSku:' NEW-SKU '};
  const saved=createReturnRequest(o,emptyOmsOperations(o.id),input,time);
  assert.equal(saved.returns[0].replacementSku,'NEW-SKU');assert.equal(saved.returns[0].status,'requested');assert.equal(returnCapacity(o,saved,id(2)),1);
  assert.throws(()=>createReturnRequest(o,saved,{...input,id:id(11),quantity:2},time),/超过/);
  assert.throws(()=>createReturnRequest(o,saved,{...input,id:id(11),lineItemId:id(4)},time),/实物/);
  assert.throws(()=>createReturnRequest(o,emptyOmsOperations(o.id),{...input,replacementSku:''},time),/替换 SKU/);
  const withNative={...o,returnInfo:[{items:[{id:id(20),lineItemId:id(2),quantity:1,shipmentState:'Returned'}]}]};
  assert.equal(returnCapacity(withNative,saved,id(2)),0);
});
test('return receipt persists an intent before the single native action and resolves response loss by stable key',()=>{
  const o=order(),saved=createReturnRequest(o,emptyOmsOperations(o.id),{id:id(10),kind:'return',lineItemId:id(2),quantity:1,reason:'Received unwanted item'},time);
  const {intent,action}=prepareReturnReceipt(o,saved,id(10));
  assert.equal(intent.returns[0].status,'receiving');assert.equal(intent.returns[0].attemptedOrderVersion,4);
  assert.deepEqual(action,{action:'addReturnInfo',items:[{key:`rw-return-${id(10)}`,lineItemId:id(2),quantity:1,comment:'Received unwanted item',shipmentState:'Returned'}]});
  assert.throws(()=>prepareReturnReceipt(o,intent,id(10)),/核对/);
  assert.throws(()=>reconcileReturnReceipt(o,intent,id(10)),/不自动重发/);
  const received={...o,version:5,returnInfo:[{items:[{id:id(21),...action.items[0]}]}]};
  const confirmed=reconcileReturnReceipt(received,intent,id(10));assert.equal(confirmed.returns[0].status,'received');assert.equal(confirmed.returns[0].returnItemId,id(21));
  assert.equal(returnCapacity(received,confirmed,id(2)),1);
  assert.throws(()=>prepareReturnReceipt(received,saved,id(10)),/已存在/);
  assert.equal(reconcileReturnReceipt(received,confirmed,id(10)).returns[0].returnItemId,id(21));
});
test('return receipt refuses altered native keys, invalid history and later over-return',()=>{
  const o=order(),saved=createReturnRequest(o,emptyOmsOperations(o.id),{id:id(10),kind:'return',lineItemId:id(2),quantity:2,reason:'Wrong item'},time);
  const wrong={...o,returnInfo:[{items:[{id:id(20),key:saved.returns[0].itemKey,lineItemId:id(2),quantity:1,shipmentState:'Returned'}]}]};
  assert.throws(()=>reconcileReturnReceipt(wrong,saved,id(10)),/数量/);
  const advised={...o,returnInfo:[{items:[{id:id(20),key:saved.returns[0].itemKey,lineItemId:id(2),quantity:2,shipmentState:'Advised'}]}]};
  assert.throws(()=>reconcileReturnReceipt(advised,saved,id(10)),/实收/);
  const changed={...o,returnInfo:[{items:[{id:id(20),lineItemId:id(2),quantity:1,shipmentState:'Returned'}]}]};
  assert.throws(()=>prepareReturnReceipt(changed,saved,id(10)),/超过/);
});
test('only a definitive rejected Order write can reopen a durable receipt intent',()=>{
  const o=order(),saved=createReturnRequest(o,emptyOmsOperations(o.id),{id:id(10),kind:'return',lineItemId:id(2),quantity:1,reason:'Received item'},time);
  const {intent}=prepareReturnReceipt(o,saved,id(10));
  assert.equal(releaseRejectedReceipt(intent,id(10),409).returns[0].status,'requested');
  for(const status of [408,429,500,502,0])assert.throws(()=>releaseRejectedReceipt(intent,id(10),status),/不确定/);
  assert.throws(()=>releaseRejectedReceipt(saved,id(10),409),/意图/);
});
test('refund requests use integer minor units and count pending/completed requests against order total',()=>{
  const o=order(),input={id:id(10),amount:'600',currencyCode:'USD',reason:'Customer requested refund'};
  const saved=createRefundRequest(o,emptyOmsOperations(o.id),input,time);
  assert.equal(saved.refunds[0].status,'requested');assert.equal(refundBudget(o,saved).remaining,400);
  assert.throws(()=>createRefundRequest(o,saved,{...input,id:id(11),amount:401},time),/上限/);
  const completed={...saved,refunds:saved.refunds.map(item=>({...item,status:'completed' as const}))};assert.equal(refundBudget(o,completed).remaining,400);
  assert.throws(()=>createRefundRequest(o,saved,{...input,id:id(11),currencyCode:'EUR',amount:1},time),/币种/);
  for(const amount of ['1.5','1e2','-1','0',String(Number.MAX_SAFE_INTEGER+1)])assert.throws(()=>createRefundRequest(o,emptyOmsOperations(o.id),{...input,amount},time),/整数|上限/);
  const externalRefund={...o,returnInfo:[{items:[{lineItemId:id(2),quantity:1,paymentState:'Refunded'}]}]};
  assert.throws(()=>createRefundRequest(externalRefund,emptyOmsOperations(o.id),input,time),/支付对账/);
});
test('aggregate validation rejects another order, unknown statuses and duplicate operations',()=>{
  const o=order(),data=createRefundRequest(o,emptyOmsOperations(o.id),{id:id(10),amount:1,currencyCode:'USD',reason:'Request only'},time);
  assert.equal(validateOmsOperations(data,o.id),data);
  assert.throws(()=>validateOmsOperations(data,id(99)),/不匹配/);
  assert.throws(()=>validateOmsOperations({...data,refunds:[...data.refunds,...data.refunds]},o.id),/重复/);
  assert.throws(()=>validateOmsOperations({...data,refunds:[{...data.refunds[0],status:'refunded-success'}]},o.id),/无效/);
  assert.throws(()=>createRefundRequest(o,data,{id:id(11),amount:1,currencyCode:'USD',reason:'bad\nreason'},time),/控制字符/);
});
