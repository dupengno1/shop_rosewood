import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyOmsOperations,validateOmsOperations,createAllocation,cancelAllocation,createReturnRequest,returnCapacity,
  prepareReturnReceipt,reconcileReturnReceipt,releaseRejectedReceipt,createRefundRequest,refundBudget,cancelReturnRequest,cancelRefundRequest,type OmsOrder,type OmsInventory} from './oms-domain';
import {parseOmsMajorAmount} from './oms-money';
const id=(n:number)=>`12345678-1234-1234-1234-${String(n).padStart(12,'0')}`;
const time='2026-11-05T11:00:00.000Z';
test('legacy cancelled refunds remain readable without weakening audit fields for new cancellation',()=>{
  const o=order(),data=createRefundRequest(o,emptyOmsOperations(o.id),{id:id(10),amount:1,currencyCode:'USD',reason:'Legacy request'},time);
  const legacy={...data,refunds:data.refunds.map(item=>({...item,status:'cancelled' as const}))};
  assert.equal(validateOmsOperations(legacy,o.id),legacy);
  assert.equal(refundBudget(o,legacy).remaining,o.totalPrice!.centAmount);
  assert.throws(()=>validateOmsOperations({...legacy,refunds:legacy.refunds.map(item=>({...item,cancelledAt:time}))},o.id));
  assert.throws(()=>cancelRefundRequest(o,data,id(10),'',time));
  const cancelled=cancelRefundRequest(o,data,id(10),'Customer withdrew',time);
  assert.equal(cancelled.refunds[0].cancellationReason,'Customer withdrew');
  assert.equal(cancelled.refunds[0].cancelledAt,time);
});
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
  assert.throws(()=>createAllocation(o,data,{...inventory(),supplyChannel:{id:id(7),obj:{roles:['InventorySupply']}}},input,time),/across the original warehouse/);
  assert.throws(()=>createAllocation(o,data,{...inventory(),sku:'OTHER'},input,time),/same SKU/);
  assert.throws(()=>createAllocation(o,saved,inventory(),{...input,id:id(11)},time),/combined allocation plans exceed/);
  const cancelled=cancelAllocation(saved,id(10));assert.equal(createAllocation(o,cancelled,inventory(),{...input,id:id(11)},time).allocations.length,2);
});
test('allocation validates stock evidence for None mode, roles, classification, quantities and IDs',()=>{
  const o={...order(),inventoryMode:'None'},data=emptyOmsOperations(o.id),input={id:id(10),lineItemId:id(2),quantity:'1',reason:'Plan only'};
  assert.throws(()=>createAllocation(o,data,inventory(),input,time),/Insufficient available inventory/);
  assert.equal(createAllocation(o,data,{...inventory(),availableQuantity:1},input,time).allocations.length,1);
  assert.throws(()=>createAllocation(o,data,{...inventory(),availableQuantity:1,supplyChannel:{id:id(3),obj:{roles:['ProductDistribution']}}},input,time),/InventorySupply/);
  assert.throws(()=>createAllocation(o,data,inventory(),{...input,lineItemId:id(4)},time),/physical/);
  assert.throws(()=>createAllocation(o,data,inventory(),{...input,quantity:'1.5'},time),/integer/);
  assert.throws(()=>createAllocation(o,data,inventory(),{...input,id:'invalid'},time));
});
test('return and exchange requests consume only eligible delivered quantity and persist replacement intent',()=>{
  const o=order(),input={id:id(10),kind:'exchange' as const,lineItemId:id(2),quantity:'1',reason:'Size does not fit',replacementSku:' NEW-SKU '};
  const saved=createReturnRequest(o,emptyOmsOperations(o.id),input,time);
  assert.equal(saved.returns[0].replacementSku,'NEW-SKU');assert.equal(saved.returns[0].status,'requested');assert.equal(returnCapacity(o,saved,id(2)),1);
  assert.throws(()=>createReturnRequest(o,saved,{...input,id:id(11),quantity:2},time),/exceeds|exceed/);
  assert.throws(()=>createReturnRequest(o,saved,{...input,id:id(11),lineItemId:id(4)},time),/physical/);
  assert.throws(()=>createReturnRequest(o,emptyOmsOperations(o.id),{...input,replacementSku:''},time),/Replacement SKU/);
  const withNative={...o,returnInfo:[{items:[{id:id(20),lineItemId:id(2),quantity:1,shipmentState:'Returned'}]}]};
  assert.equal(returnCapacity(withNative,saved,id(2)),0);
});
test('return receipt persists an intent before the single native action and resolves response loss by stable key',()=>{
  const o=order(),saved=createReturnRequest(o,emptyOmsOperations(o.id),{id:id(10),kind:'return',lineItemId:id(2),quantity:1,reason:'Received unwanted item'},time);
  const {intent,action}=prepareReturnReceipt(o,saved,id(10));
  assert.equal(intent.returns[0].status,'receiving');assert.equal(intent.returns[0].attemptedOrderVersion,4);
  assert.deepEqual(action,{action:'addReturnInfo',items:[{key:`rw-return-${id(10)}`,lineItemId:id(2),quantity:1,comment:'Received unwanted item',shipmentState:'Returned'}]});
  assert.throws(()=>prepareReturnReceipt(o,intent,id(10)),/Verify/);
  assert.throws(()=>reconcileReturnReceipt(o,intent,id(10)),/no automatic retry/);
  const received={...o,version:5,returnInfo:[{items:[{id:id(21),...action.items[0]}]}]};
  const confirmed=reconcileReturnReceipt(received,intent,id(10));assert.equal(confirmed.returns[0].status,'received');assert.equal(confirmed.returns[0].returnItemId,id(21));
  assert.equal(returnCapacity(received,confirmed,id(2)),1);
  assert.throws(()=>prepareReturnReceipt(received,saved,id(10)),/already exists/);
  assert.equal(reconcileReturnReceipt(received,confirmed,id(10)).returns[0].returnItemId,id(21));
});
test('return receipt refuses altered native keys, invalid history and later over-return',()=>{
  const o=order(),saved=createReturnRequest(o,emptyOmsOperations(o.id),{id:id(10),kind:'return',lineItemId:id(2),quantity:2,reason:'Wrong item'},time);
  const wrong={...o,returnInfo:[{items:[{id:id(20),key:saved.returns[0].itemKey,lineItemId:id(2),quantity:1,shipmentState:'Returned'}]}]};
  assert.throws(()=>reconcileReturnReceipt(wrong,saved,id(10)),/quantity/);
  const advised={...o,returnInfo:[{items:[{id:id(20),key:saved.returns[0].itemKey,lineItemId:id(2),quantity:2,shipmentState:'Advised'}]}]};
  assert.throws(()=>reconcileReturnReceipt(advised,saved,id(10)),/receipt/);
  const changed={...o,returnInfo:[{items:[{id:id(20),lineItemId:id(2),quantity:1,shipmentState:'Returned'}]}]};
  assert.throws(()=>prepareReturnReceipt(changed,saved,id(10)),/exceeds|exceed/);
});
test('only a definitive rejected Order write can reopen a durable receipt intent',()=>{
  const o=order(),saved=createReturnRequest(o,emptyOmsOperations(o.id),{id:id(10),kind:'return',lineItemId:id(2),quantity:1,reason:'Received item'},time);
  const {intent}=prepareReturnReceipt(o,saved,id(10));
  assert.equal(releaseRejectedReceipt(intent,id(10),409).returns[0].status,'requested');
  for(const status of [408,429,500,502,0])assert.throws(()=>releaseRejectedReceipt(intent,id(10),status),/uncertain/);
  assert.throws(()=>releaseRejectedReceipt(saved,id(10),409),/intent/);
});
test('refund requests use integer minor units and count pending/completed requests against order total',()=>{
  const o=order(),input={id:id(10),amount:'600',currencyCode:'USD',reason:'Customer requested refund'};
  const saved=createRefundRequest(o,emptyOmsOperations(o.id),input,time);
  assert.equal(saved.refunds[0].status,'requested');assert.equal(refundBudget(o,saved).remaining,400);
  assert.throws(()=>createRefundRequest(o,saved,{...input,id:id(11),amount:401},time),/limit/);
  const completed={...saved,refunds:saved.refunds.map(item=>({...item,status:'completed' as const}))};assert.equal(refundBudget(o,completed).remaining,400);
  assert.throws(()=>createRefundRequest(o,saved,{...input,id:id(11),currencyCode:'EUR',amount:1},time),/currency/);
  for(const amount of ['1.5','1e2','-1','0',String(Number.MAX_SAFE_INTEGER+1)])assert.throws(()=>createRefundRequest(o,emptyOmsOperations(o.id),{...input,amount},time),/integer|limit/);
  const externalRefund={...o,returnInfo:[{items:[{lineItemId:id(2),quantity:1,paymentState:'Refunded'}]}]};
  assert.throws(()=>createRefundRequest(externalRefund,emptyOmsOperations(o.id),input,time),/Payment reconciliation/);
});
test('aggregate validation rejects another order, unknown statuses and duplicate operations',()=>{
  const o=order(),data=createRefundRequest(o,emptyOmsOperations(o.id),{id:id(10),amount:1,currencyCode:'USD',reason:'Request only'},time);
  assert.equal(validateOmsOperations(data,o.id),data);
  assert.throws(()=>validateOmsOperations(data,id(99)),/does not match/);
  assert.throws(()=>validateOmsOperations({...data,refunds:[...data.refunds,...data.refunds]},o.id),/duplicate/);
  assert.throws(()=>validateOmsOperations({...data,refunds:[{...data.refunds[0],status:'refunded-success'}]},o.id),/Invalid/);
  assert.throws(()=>createRefundRequest(o,data,{id:id(11),amount:1,currencyCode:'USD',reason:'bad\nreason'},time),/control characters/);
});

test('cancelling requested returns or exchanges preserves audit and releases only their pending capacity',()=>{
  const o=order(),at='2026-11-05T11:05:00.000Z';
  for(const kind of ['return','exchange'] as const){
    const saved=createReturnRequest(o,emptyOmsOperations(o.id),{id:id(10),kind,lineItemId:id(2),quantity:2,reason:'Original reason',replacementSku:'SKU-B'},time);
    assert.equal(returnCapacity(o,saved,id(2)),0);
    const before=structuredClone(saved),nativeBefore=structuredClone(o);
    const cancelled=cancelReturnRequest(o,saved,id(10),' Customer withdrew request ',at);
    assert.equal(cancelled.returns.length,1);assert.equal(cancelled.returns[0].status,'cancelled');
    assert.equal(cancelled.returns[0].reason,'Original reason');assert.equal(cancelled.returns[0].cancellationReason,'Customer withdrew request');assert.equal(cancelled.returns[0].cancelledAt,at);
    assert.equal(cancelled.returns[0].createdAt,time);assert.equal(cancelled.returns[0].itemKey,saved.returns[0].itemKey);
    assert.equal(returnCapacity(o,cancelled,id(2)),2);assert.deepEqual(saved,before);assert.deepEqual(o,nativeBefore);
    assert.deepEqual(validateOmsOperations(JSON.parse(JSON.stringify(cancelled)),o.id),cancelled);
    const replacement=createReturnRequest(o,cancelled,{id:id(11),kind:'return',lineItemId:id(2),quantity:2,reason:'New corrected request'},at);
    assert.equal(returnCapacity(o,replacement,id(2)),0);
    assert.throws(()=>cancelReturnRequest(o,cancelled,id(10),'Again',at),/Only pending/);
    assert.throws(()=>prepareReturnReceipt(o,cancelled,id(10)),/awaiting receipt/);
  }
});

test('return cancellation cannot retract native returns, receipt intents or completed receipts',()=>{
  const o=order(),saved=createReturnRequest(o,emptyOmsOperations(o.id),{id:id(10),kind:'return',lineItemId:id(2),quantity:1,reason:'Original'},time);
  const {intent,action}=prepareReturnReceipt(o,saved,id(10));
  assert.throws(()=>cancelReturnRequest(o,intent,id(10),'Withdraw'),/Only pending/);
  for(const shipmentState of ['Advised','Returned','BackInStock','Unusable']){
    const native={...o,returnInfo:[{items:[{id:id(30),...action.items[0],shipmentState}]}]};
    assert.throws(()=>cancelReturnRequest(native,saved,id(10),'Withdraw'),/native order/);
  }
  const received={...o,returnInfo:[{items:[{id:id(30),...action.items[0]}]}]};
  const complete=reconcileReturnReceipt(received,intent,id(10));
  assert.throws(()=>cancelReturnRequest(received,complete,id(10),'Withdraw'),/Only pending/);
  const cancelled=cancelReturnRequest(o,saved,id(10),'Withdraw');
  assert.throws(()=>returnCapacity(received,cancelled,id(2)),/cancelled request has a native/);
  assert.throws(()=>reconcileReturnReceipt(received,cancelled,id(10)),/cancelled/);
  for(const extra of [{returnItemId:id(30)},{attemptedOrderVersion:4}]){
    const forged={...cancelled,returns:[{...cancelled.returns[0],...extra}]};
    assert.throws(()=>validateOmsOperations(forged,o.id),/receipt/);
    assert.throws(()=>returnCapacity(o,forged,id(2)),/receipt/);
  }
  const reopened=releaseRejectedReceipt(intent,id(10),409);
  assert.equal(reopened.returns[0].attemptedOrderVersion,undefined);
  assert.equal(cancelReturnRequest(o,reopened,id(10),'Definitively rejected before receipt').returns[0].status,'cancelled');
});

test('request cancellation requires a valid reason and time and cannot reopen cancelled audit records',()=>{
  const o=order(),saved=createReturnRequest(o,emptyOmsOperations(o.id),{id:id(10),kind:'return',lineItemId:id(2),quantity:1,reason:'Original'},time);
  for(const reason of ['','  ','bad\nreason','x'.repeat(501)])assert.throws(()=>cancelReturnRequest(o,saved,id(10),reason),/Cancellation reason/);
  for(const at of ['bad','2026-11-05T10:59:59.999Z'])assert.throws(()=>cancelReturnRequest(o,saved,id(10),'Withdraw',at),/Cancellation time/);
  const cancelled=cancelReturnRequest(o,saved,id(10),'Withdraw');
  for(const patch of [{cancellationReason:undefined},{cancelledAt:undefined},{status:'requested'}])assert.throws(()=>validateOmsOperations({...cancelled,returns:[{...cancelled.returns[0],...patch}]},o.id));
  assert.throws(()=>cancelReturnRequest({...o,id:id(99)},saved,id(10),'Withdraw'),/does not match/);
});

test('requested refunds can be cancelled without payment actions and restore exact application budget',()=>{
  const o=order(),saved=createRefundRequest(o,emptyOmsOperations(o.id),{id:id(10),amount:parseOmsMajorAmount('0.01',2),currencyCode:'USD',reason:'Original refund request'},time),at='2026-11-05T11:05:00.000Z';
  assert.equal(saved.refunds[0].amount,1);assert.equal(refundBudget(o,saved).remaining,999);
  const before=structuredClone(saved),nativeBefore=structuredClone(o),cancelled=cancelRefundRequest(o,saved,id(10),'Customer withdrew',at);
  assert.equal(cancelled.refunds.length,1);assert.equal(cancelled.refunds[0].status,'cancelled');assert.equal(cancelled.refunds[0].amount,1);
  assert.equal(cancelled.refunds[0].reason,'Original refund request');assert.equal(cancelled.refunds[0].cancellationReason,'Customer withdrew');assert.equal(cancelled.refunds[0].cancelledAt,at);
  assert.equal(refundBudget(o,cancelled).remaining,1000);assert.deepEqual(saved,before);assert.deepEqual(o,nativeBefore);
  assert.deepEqual(validateOmsOperations(JSON.parse(JSON.stringify(cancelled)),o.id),cancelled);
  assert.equal(createRefundRequest(o,cancelled,{id:id(11),amount:1000,currencyCode:'USD',reason:'Corrected request'},at).refunds.length,2);
  for(const status of ['executing','completed','rejected'] as const){const changed={...saved,refunds:[{...saved.refunds[0],status}]};assert.throws(()=>cancelRefundRequest(o,changed,id(10),'Withdraw',at),/Only pending/);}
  assert.throws(()=>cancelRefundRequest(o,cancelled,id(10),'Again',at),/Only pending/);
  assert.throws(()=>cancelRefundRequest(o,saved,id(10),'',at),/Cancellation reason/);
  assert.throws(()=>validateOmsOperations({...cancelled,refunds:[{...cancelled.refunds[0],cancellationReason:undefined}]},o.id),/Cancellation reason/);
});

test('approval records never execute money and prevent receipt of a rejected request',async()=>{
 const {reviewOmsRequest}=await import('./oms-domain');const o=order(),original=structuredClone(o);
 let data=createRefundRequest(o,emptyOmsOperations(o.id),{id:id(40),amount:100,currencyCode:'USD',reason:'Requested refund'},time);
 assert.equal(data.refunds[0].approval?.status,'pending');
 const approved=reviewOmsRequest(o,data,'refunds',id(40),'approved','Reviewed original payment',time);
 assert.equal(approved.refunds[0].status,'requested');assert.equal(approved.refunds[0].approval?.status,'approved');
 assert.equal(refundBudget(o,approved).remaining,900);
 assert.throws(()=>reviewOmsRequest(o,approved,'refunds',id(40),'rejected','Second decision',time),/already been reviewed/);
 const rejected=reviewOmsRequest(o,data,'refunds',id(40),'rejected','Request not eligible',time);
 assert.equal(rejected.refunds[0].status,'rejected');assert.equal(refundBudget(o,rejected).remaining,1000);
 data=createReturnRequest(o,emptyOmsOperations(o.id),{id:id(41),kind:'return',lineItemId:id(2),quantity:1,reason:'Incorrect size'},time);
 const blocked=reviewOmsRequest(o,data,'returns',id(41),'rejected','Not eligible',time);
 assert.throws(()=>prepareReturnReceipt(o,blocked,id(41)),/rejected/);
 assert.throws(()=>reviewOmsRequest(o,data,'returns',id(41),'approved','',time),/Approval reason/);
 assert.throws(()=>reviewOmsRequest(o,data,'returns',id(41),'approved','Reviewed','2026-01-01'),/review time/);
 assert.deepEqual(o,original);
});
test('consignment transitions are monotonic, versioned and do not modify native orders or allocations',async()=>{
 const {updateConsignment}=await import('./oms-domain');const o=order(),original=structuredClone(o),data=emptyOmsOperations(o.id);
 const input={id:id(50),groupId:id(3),status:'Picking' as const,reason:'Warehouse accepted task'};
 assert.throws(()=>updateConsignment(o,data,{...input,status:'Delivered'},[id(3)],time),/Invalid consignment transition/);
 assert.throws(()=>updateConsignment(o,data,input,['other'],time),/not present/);
 let next=updateConsignment(o,data,input,[id(3)],time);
 assert.equal(next.consignments?.[0].orderVersionObserved,4);
 for(const status of ['Packed','Shipped','Failed Delivery','Shipped','Delivered'] as const)next=updateConsignment(o,next,{...input,status},[id(3)],time);
 assert.throws(()=>updateConsignment(o,next,{...input,status:'Shipped'},[id(3)],time),/Invalid consignment transition/);
 assert.throws(()=>updateConsignment({...o,orderState:'Cancelled'},data,input,[id(3)],time),/Cancelled/);
 const duplicate=createRefundRequest(o,data,{id:id(50),amount:1,currencyCode:'USD',reason:'Refund'},time);
 assert.throws(()=>updateConsignment(o,duplicate,input,[id(3)],time),/identifier already exists/);
 assert.throws(()=>createRefundRequest(o,next,{id:id(50),amount:1,currencyCode:'USD',reason:'Refund'},time),/already exists/);
 assert.equal(next.allocations.length,0);assert.deepEqual(o,original);assert.equal(validateOmsOperations(next,o.id),next);
});
