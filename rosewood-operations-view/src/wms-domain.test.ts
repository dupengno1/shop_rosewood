import test from 'node:test';
import assert from 'node:assert/strict';
import type {Inventory} from './api';
import {newTransfer,newCount,dispatchTransfer,receiveTransfer,reviewCount,applyCount,cancelWmsDocument,closeUnchangedCount,stockNumber,type WmsValue} from './wms-domain';
const source:Inventory={id:'11111111-1111-4111-8111-111111111111',version:1,sku:'QA',quantityOnStock:10,availableQuantity:8,supplyChannel:{id:'channel-a'}};
const dest:Inventory={...source,id:'22222222-2222-4222-8222-222222222222',quantityOnStock:2,availableQuantity:2,supplyChannel:{id:'channel-b'}};
test('transfer requires matching SKU and distinct explicit supply channels and sufficient available stock',()=>{
  assert.throws(()=>newTransfer(source,source,'3','Reason',''),/必须不同/);
  assert.throws(()=>newTransfer(source,{...dest,sku:'Other'},'3','Reason',''),/相同 SKU/);
  assert.throws(()=>newTransfer(source,{...dest,supplyChannel:undefined},'3','Reason',''),/Supply Channel/);
  assert.throws(()=>newTransfer(source,dest,'9','Reason',''),/可用库存不足/);
  assert.throws(()=>newTransfer({...source,quantityOnStock:-1},dest,'1','Reason',''),/负/);
  assert.throws(()=>newTransfer(source,dest,'1',' ','ref'),/原因/);
});
test('dispatch only changes source; partial receipts retain in-transit remainder and prevent excess or duplicate completion',()=>{
  const planned=newTransfer(source,dest,'3','Test transfer','T-1');
  const dispatch=dispatchTransfer(planned,source);
  assert.deepEqual(dispatch.action,{action:'removeQuantity',quantity:3});assert.equal(dispatch.after,7);
  assert.equal(dispatch.next.received,0);assert.equal(dispatch.next.status,'in_transit');
  assert.throws(()=>dispatchTransfer(dispatch.next,source),/再次/);
  const partial=receiveTransfer(dispatch.next,dest,'2');
  assert.deepEqual(partial.action,{action:'addQuantity',quantity:2});assert.equal(partial.after,4);
  assert.equal(partial.next.status,'in_transit');assert.equal(partial.next.dispatched-partial.next.received,1);
  assert.throws(()=>receiveTransfer(partial.next,dest,'2'),/超过/);
  const finished=receiveTransfer(partial.next,{...dest,version:2,quantityOnStock:4},'1');
  assert.equal(finished.after,5);assert.equal(finished.next.status,'received');
  assert.throws(()=>receiveTransfer(finished.next,dest,'1'),/只有在途/);
});
test('dispatch rechecks availability and immutable identity rather than trusting creation snapshot',()=>{
  const doc=newTransfer(source,dest,'3','Reason','');
  assert.throws(()=>dispatchTransfer(doc,{...source,availableQuantity:2}),/可用库存不足/);
  assert.throws(()=>dispatchTransfer(doc,{...source,supplyChannel:{id:'different'}}),/已变化/);
  assert.throws(()=>receiveTransfer(dispatchTransfer(doc,source).next,{...dest,id:source.id},'1'),/已变化/);
});
test('count requires review and exact snapshot version and quantity, including unrelated version changes',()=>{
  const counted=newCount(source,'9','Sales stock recount','C-1');
  assert.throws(()=>applyCount(counted,source),/先复核/);
  const reviewed=reviewCount(counted);
  assert.throws(()=>applyCount(reviewed,{...source,version:2}),/快照后库存已变化/);
  assert.throws(()=>applyCount(reviewed,{...source,quantityOnStock:11}),/快照后库存已变化/);
  const applied=applyCount(reviewed,source);
  assert.deepEqual(applied.action,{action:'changeQuantity',quantity:9});assert.equal(applied.next.status,'applied');
  assert.throws(()=>applyCount(applied.next,source),/先复核/);
});
test('unsafe quantities, overflow and no-change count cannot mutate stock',()=>{
  for(const value of ['-1','1.5','1e3','','Infinity',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>stockNumber(value));
  const doc=dispatchTransfer(newTransfer(source,dest,'3','Reason',''),source).next;
  assert.throws(()=>receiveTransfer(doc,{...dest,quantityOnStock:Number.MAX_SAFE_INTEGER},'1'));
  assert.throws(()=>applyCount(reviewCount(newCount(source,'10','Reason','')),source),/没有差异/);
});
test('unchanged reviewed count closes as a durable observation without an inventory effect',()=>{
  const reviewed=reviewCount(newCount(source,'10','Same stock','COUNT-1'));
  const before=structuredClone(reviewed),inventoryBefore=structuredClone(source);
  const closed=closeUnchangedCount(reviewed,source);
  assert.equal(closed.status,'closed_no_change');assert.equal(closed.history.at(-1)?.action,'close_no_change');
  assert.equal(closed.history.at(-1)?.quantity,0);assert.ok(closed.closedAt);assert.match(closed.closureReason||'',/不修改库存/);
  assert.deepEqual(reviewed,before);assert.deepEqual(source,inventoryBefore);
  assert.equal('inventorySteps' in closed,false);assert.equal('pending' in closed,false);
  assert.throws(()=>closeUnchangedCount(closed,source),/先复核/);
  assert.throws(()=>closeUnchangedCount(reviewed,{...source,version:2}),/快照后库存已变化/);
  assert.throws(()=>closeUnchangedCount(reviewed,{...source,quantityOnStock:11}),/快照后库存已变化/);
  assert.throws(()=>closeUnchangedCount(reviewed,{...source,supplyChannel:{id:'other'}}),/已变化/);
  assert.throws(()=>closeUnchangedCount(reviewCount(newCount(source,'9','Diff','')),source),/存在差异/);
});
test('cancel only untouched planned transfers or unposted counts, preserving history and a required reason',()=>{
  const planned=newTransfer(source,dest,'3','Transfer reason','REF-1');
  const cancelled=cancelWmsDocument(planned,'计划重复，保留原单');
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.reason,'Transfer reason');assert.equal(cancelled.reference,'REF-1');
  assert.equal(cancelled.dispatched,0);assert.equal(cancelled.received,0);assert.equal(cancelled.closureReason,'计划重复，保留原单');
  assert.ok(cancelled.closedAt);assert.equal(cancelled.history.at(-1)?.action,'cancel');
  assert.equal(planned.status,'planned');assert.equal(planned.history.length,0);
  const reviewed=reviewCount(newCount(source,'9','Count reason','COUNT-2'));
  assert.equal(cancelWmsDocument(reviewed,'快照已过期，重新盘点').history.length,reviewed.history.length+1);
  assert.equal(cancelWmsDocument(newCount(source,'9','Count reason',''),'录入错误').status,'cancelled');
  assert.throws(()=>cancelWmsDocument(planned,'  '),/取消原因/);
  assert.throws(()=>cancelWmsDocument(cancelled,'again'),/只有未发出/);
  assert.throws(()=>cancelWmsDocument(dispatchTransfer(planned,source).next,'No'),/已发出/);
  assert.throws(()=>cancelWmsDocument(applyCount(reviewed,source).next,'No'),/只有未发出/);
});
test('pending, confirmed or malformed inventory history cannot be bypassed by cancellation or no-change closure',()=>{
  const base=reviewCount(newCount(source,'10','Same stock',''));
  for(const extra of [{pending:{stepId:'pending'}},{pending:null},{inventorySteps:[{status:'confirmed'}]},{inventorySteps:{}},{dispatched:1},{received:1}]){
    const value={...base,...extra} as WmsValue;
    assert.throws(()=>cancelWmsDocument(value,'No'),/库存步骤|已发出/);
    assert.throws(()=>closeUnchangedCount(value,source),/库存步骤|已发出/);
  }
});
