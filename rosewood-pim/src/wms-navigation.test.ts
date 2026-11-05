import test from 'node:test';
import assert from 'node:assert/strict';
import {readWmsNavigation,writeWmsNavigation,wmsFilters,wmsDocumentKey} from './wms-navigation';

const document='11111111-1111-4111-8111-111111111111';
test('WMS filters and document survive a fresh URL read without using query strings or local state',()=>{
  const filters=wmsFilters('count','QA " SKU','closed_no_change','COUNT & / 01');
  const hash=writeWmsNavigation('#view=count&q=existing', 'count',filters,document);
  assert.deepEqual(readWmsNavigation(hash,'count'),{document,filters});
  assert.equal(new URLSearchParams(hash.slice(1)).get('q'),'existing');
  assert.deepEqual(readWmsNavigation('?wmsDocument='+document,'count'),{document:'',filters:{type:'count'}});
});
test('returning to the list clears only selected WMS document and preserves exact applied filters',()=>{
  const filters=wmsFilters('transfer','QA','planned','TRANSFER-1');
  const detail=writeWmsNavigation('#view=transfer','transfer',filters,document);
  const list=writeWmsNavigation(detail,'transfer',filters);
  assert.deepEqual(readWmsNavigation(list,'transfer'),{document:'',filters});
  const cleared=writeWmsNavigation(list,'transfer',wmsFilters('transfer'));
  assert.deepEqual(readWmsNavigation(cleared,'transfer'),{document:'',filters:{type:'transfer'}});
});
test('invalid direct links fail closed instead of broadening the server query or reading a different document',()=>{
  assert.throws(()=>readWmsNavigation('#wmsDocument=../other','count'),/UUID/);
  assert.throws(()=>readWmsNavigation('#wmsStatus=applied','transfer'),/不支持/);
  assert.throws(()=>wmsFilters('count','SKU\nINJECT'),/控制字符/);
  assert.throws(()=>wmsFilters('count','x'.repeat(257)),/最多/);
  assert.throws(()=>wmsFilters('count','','','x'.repeat(121)),/最多/);
  assert.throws(()=>wmsDocumentKey('not-a-uuid'),/UUID/);
});
