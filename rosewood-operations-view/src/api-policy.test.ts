import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCommerceRequest} from './api-policy';
const key='62ea1e10-e313-4dfd-8b59-01daff5b7ff3';
test('only registered operation containers can be read or versioned-written',()=>{
  for(const container of ['rw-mc-wms-operations','rw-mc-oms-operations','rw-mc-pim-reports']){
    assert.doesNotThrow(()=>validateCommerceRequest(`custom-objects/${container}?limit=20`));
    assert.doesNotThrow(()=>validateCommerceRequest(`custom-objects/${container}/${key}`));
    assert.doesNotThrow(()=>validateCommerceRequest('custom-objects',{container,key,version:0,value:{status:'draft'}}));
  }
  for(const body of [{container:'other',key,version:0,value:{}},{container:'rw-mc-wms-operations',key,value:{}},{container:'rw-mc-wms-operations',key:'../other',version:0,value:{}}])assert.throws(()=>validateCommerceRequest('custom-objects',body));
  assert.throws(()=>validateCommerceRequest('custom-objects?limit=500'));
  assert.throws(()=>validateCommerceRequest(`custom-objects/other/${key}`));
});
test('API access rejects URL traversal and channel writes',()=>{
  for(const path of ['https://other.invalid/orders','/orders','orders/../custom-objects','orders/%2e%2e/custom-objects','orders\\x','orders#other'])assert.throws(()=>validateCommerceRequest(path));
  assert.doesNotThrow(()=>validateCommerceRequest('channels?where=roles%20contains%20all%20(%22InventorySupply%22)'));
  assert.throws(()=>validateCommerceRequest('channels',{key:'new'}));
});
