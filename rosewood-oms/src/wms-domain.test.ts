import test from 'node:test';
import assert from 'node:assert/strict';
import type {Inventory} from './api';
import {newTransfer,newCount,dispatchTransfer,receiveTransfer,reviewCount,applyCount,stockNumber} from './wms-domain';
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
