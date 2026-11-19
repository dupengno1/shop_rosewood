import test from 'node:test';
import assert from 'node:assert/strict';
import {readCatalogMemberships,readProductMemberships} from './catalog-memberships';

test('shared, arbitrary hotel and B2B selections are discovered natively with exact inclusion/exclusion restrictions',async()=>{
 const selections=[{id:'shared',key:'rosewood-global-shared',mode:'Individual',name:{en:'Global shared'}},{id:'hotel',key:'hotel-new',mode:'Individual'},{id:'b2b',key:'wholesale',mode:'IndividualExclusion'}];
 const paths:string[]=[];
 const api=async<T,>(path:string):Promise<T>=>{paths.push(path);if(path.startsWith('product-selections?'))return {results:selections} as T;const id=path.split('/')[1];return {results:[{product:{id:'single-master'},...(id==='hotel'?{variantSelection:{type:'includeOnly',skus:['SKU-HOTEL']}}:id==='b2b'?{variantExclusion:{skus:['SKU-EXCEPTION']}}:{})}]} as T;};
 const result=await readCatalogMemberships(api);
 assert.deepEqual(result.selections.map(row=>row.value),['shared','hotel','b2b']);
 assert.match(result.memberships.get('single-master')![0].detail,/Global shared.*Inclusion selection; all variants/);
 assert.match(result.memberships.get('single-master')![1].detail,/only SKUs: SKU-HOTEL/);
 assert.match(result.memberships.get('single-master')![2].detail,/Exclusion selection; excluded SKUs: SKU-EXCEPTION/);
 assert.equal(paths.length,4);assert.ok(paths.every(path=>!path.includes('key=rosewood-us-catalog')));
});
test('an incomplete or repeating selection scan never reports missing products as unassigned',async()=>{
 const repeated={id:'same',key:'same'};
 await assert.rejects(readCatalogMemberships(async<T,>()=>({results:Array(100).fill(repeated)}) as T),/did not advance/);
 await assert.rejects(readCatalogMemberships(async<T,>(path:string)=>path.startsWith('product-selections?')?({results:[repeated]}) as T:Promise.reject(Error('403'))),/403/);
});
test('detail displays native selection names and explicit variant exclusion scope',async()=>{
 const result=await readProductMemberships(async<T,>()=>({results:[{productSelection:{id:'exclude',obj:{id:'exclude',key:'closed-skus',mode:'IndividualExclusion',name:{en:'Hidden variants'}}},variantExclusion:{skus:['HIDDEN-SKU']}}]}) as T,'product');
 assert.equal(result[0].detail,'Hidden variants (Exclusion selection; excluded SKUs: HIDDEN-SKU)');
});
