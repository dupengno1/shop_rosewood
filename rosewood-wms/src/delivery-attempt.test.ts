import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeliveryAttempt} from './delivery-attempt';

test('an unresolved delivery keeps the same key across panel remount and is isolated by project/order',()=>{
  const values=new Map<string,string>();
  const store={getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
  const first=createDeliveryAttempt(store,'project','order',()=> 'attempt-1');
  first.begin();
  const reopened=createDeliveryAttempt(store,'project','order',()=> 'attempt-2');
  assert.equal(reopened.key,'attempt-1');assert.equal(reopened.pending,true);
  assert.equal(createDeliveryAttempt(store,'project','other',()=> 'other-attempt').pending,false);
  assert.equal(createDeliveryAttempt(store,'other-project','order',()=> 'other-attempt').pending,false);
  reopened.complete();
  assert.equal(reopened.key,'attempt-2');assert.equal(reopened.pending,false);assert.equal(values.size,0);
});
