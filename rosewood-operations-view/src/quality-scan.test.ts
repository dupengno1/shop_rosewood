import test from 'node:test';
import assert from 'node:assert/strict';
import type {Product} from './api';
import {scanProductQuality} from './quality-scan';
import {buildListQuery,readHashState,listHashState,workQueue} from './list-queries';
const id=(i:number)=>`12345678-1234-1234-1234-${String(i).padStart(12,'0')}`;
function product(i:number):Product{return {id:id(i),version:1,masterData:{published:false,hasStagedChanges:true,current:{masterVariant:{id:1},variants:[]},staged:{name:{en:'Item '+i},masterVariant:{id:1,sku:'SKU-'+i},variants:[]}}};}

test('operational queues are server predicates and cannot be injected via URL state',()=>{
  const query=(module:'oms'|'pim'|'wms',filter:string)=>new URL('https://example.test/'+buildListQuery(module,'SKU"',0,filter)).searchParams;
  assert.deepEqual(query('wms','low').getAll('where'),['sku="SKU\\\""','availableQuantity <= 5']);
  assert.equal(query('pim','draft').getAll('where').at(-1),'masterData(published=false)');
  assert.equal(query('oms','cancelled').getAll('where').at(-1),'orderState="Cancelled"');
  assert.equal(query('oms','x" or true').getAll('where').length,1);
  assert.equal(workQueue('wms','draft'),'all');
  const state=listHashState({hash:'#filter=draft&q=A&page=2&record=bad&view=quality'});
  assert.equal(state.get('filter'),'draft');assert.equal(state.get('view'),'quality');assert.equal(state.has('record'),false);
  assert.equal(readHashState({search:'?filter=low'}).has('filter'),false);
});

test('catalog scan uses an advancing cursor, includes later-page problems and marks completion',async()=>{
  const paths:string[]=[],progress:number[]=[];
  const data=Array.from({length:103},(_,i)=>product(i+1));
  const result=await scanProductQuality(async<T>(path:string)=>{paths.push(path);return {results:paths.length===1?data.slice(0,100):data.slice(100)} as T;},r=>progress.push(r.checked));
  assert.equal(result.checked,103);assert.equal(result.rows.length,103);assert.ok(result.rows[102].warningCount>0);assert.equal(result.complete,true);
  assert.equal(new URL('https://example.test/'+paths[1]).searchParams.get('where'),`id > "${id(100)}"`);
  assert.deepEqual(progress,[100,103]);
});

test('catalog scan follows server ID order even when UUID strings descend within and across pages',async()=>{
  const observedIds=['877e061a-7f7f-4600-ab41-a98c11c8c701','1a4e9f05-a74c-4c00-b588-2eb783f22fab','ba0cc4ff-6406-4402-a7f2-cd5990097793'];
  const first=[...observedIds.map((value,i)=>({...product(i+1),id:value})),...Array.from({length:97},(_,i)=>product(103-i))];
  const second=[product(6),product(5)],paths:string[]=[];
  const result=await scanProductQuality(async<T>(path:string)=>{
    paths.push(path);return {results:paths.length===1?first:second} as T;
  },()=>{});
  assert.equal(first.length,100);
  assert.ok(first[1].id<first[0].id);
  assert.ok(second[0].id<first.at(-1)!.id);
  assert.equal(new URL('https://example.test/'+paths[1]).searchParams.get('where'),`id > "${first.at(-1)!.id}"`);
  assert.deepEqual(result.rows.map(row=>row.id),[...first,...second].map(row=>row.id));
  assert.equal(result.checked,102);assert.equal(result.complete,true);assert.equal(result.limited,false);
});

test('capped scans probe for more rows and cancellation never reports a complete catalog',async()=>{
  let calls=0;
  const result=await scanProductQuality(async<T>()=>({results:[product(++calls)]}) as T,()=>{},()=>false,1);
  assert.equal(calls,2);assert.equal(result.limited,true);assert.equal(result.complete,false);assert.equal(result.checked,1);
  let cancelled=false,updates=0;
  const stopped=await scanProductQuality(async<T>()=>{cancelled=true;return {results:[product(1)]} as T;},()=>updates++,()=>cancelled);
  assert.equal(updates,0);assert.equal(stopped.complete,false);
});

test('malformed or repeating catalog rows fail instead of looping or presenting false completeness',async()=>{
  await assert.rejects(scanProductQuality(async<T>()=>({results:[product(1),product(1)]}) as T,()=>{}),/重复/);
  await assert.rejects(scanProductQuality(async<T>()=>({results:[{...product(1),id:'invalid-id'}]}) as T,()=>{}),/标识/);
  await assert.rejects(scanProductQuality(async<T>()=>({results:null}) as T,()=>{}),/无效页面/);
  let pages=0;
  await assert.rejects(scanProductQuality(async<T>()=>({results:++pages===1?Array.from({length:100},(_,i)=>product(i+1)):[product(1)]}) as T,()=>{}),/重复/);
  assert.equal(pages,2);
});

test('cap probe validates unique UUIDs before reporting a complete or limited catalog',async()=>{
  for(const probe of [[product(1)],[{...product(2),id:'not-a-uuid'}],[product(2),product(3)]]){
    let requests=0;
    await assert.rejects(scanProductQuality(async<T>()=>({results:++requests===1?[product(1)]:probe}) as T,()=>{},()=>false,1),/标识|范围/);
    assert.equal(requests,2);
  }
  let requests=0;
  const exact=await scanProductQuality(async<T>()=>({results:++requests===1?[product(1)]:[]}) as T,()=>{},()=>false,1);
  assert.equal(exact.checked,1);assert.equal(exact.complete,true);assert.equal(exact.limited,false);
});
