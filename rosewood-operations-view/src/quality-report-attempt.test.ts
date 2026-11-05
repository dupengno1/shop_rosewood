import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingQualityReport,readQualityReport,recoverQualityReport,saveQualityReport,QUALITY_REPORT_CONTAINER,type ReportMarkerStore,type QualityReportDocument} from './quality-report-attempt';
import type {OperationApi} from './operation-store';
import type {QualityScan} from './quality-scan';

const reportId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',productId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const snapshot:QualityScan={checked:1,complete:true,limited:false,rows:[{id:productId,version:1,name:'QA',skus:['QA'],published:true,hasStagedChanges:false,variantCount:1,errorCount:0,warningCount:1}]};
function memory(){const values=new Map<string,string>();return {values,store:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}} satisfies ReportMarkerStore};}
function fixture(){
  const records=new Map<string,QualityReportDocument>(),requests:{path:string;payload?:unknown}[]=[];
  let loseResponse=false,rejectStatus=0;
  const api:OperationApi=async<T,>(path:string,payload?:unknown):Promise<T>=>{
    requests.push({path,payload});
    if(payload){
      if(rejectStatus)throw {statusCode:rejectStatus};
      const body=payload as {key:string;container:string;version:number;value:QualityReportDocument['value']};
      assert.equal(body.version,0);assert.equal(body.container,QUALITY_REPORT_CONTAINER);
      const doc:QualityReportDocument={id:body.key,key:body.key,container:QUALITY_REPORT_CONTAINER,version:1,createdAt:'2026-11-05T12:00:00Z',lastModifiedAt:'2026-11-05T12:00:00Z',value:body.value};records.set(body.key,doc);
      if(loseResponse)throw new Error('response lost after server commit');return doc as T;
    }
    const doc=records.get(path.split('/').at(-1)!);if(!doc)throw {statusCode:404};return doc as T;
  };
  return {api,records,requests,lose:()=>{loseResponse=true;},reject:(status:number)=>{rejectStatus=status;},writes:()=>requests.filter(request=>request.payload!==undefined)};
}

test('lost response survives reopen and recovers original key with GET, never a second POST',async()=>{
  const local=memory(),server=fixture();server.lose();
  await assert.rejects(saveQualityReport(server.api,local.store,'project-a',snapshot,{newKey:()=>reportId}));
  assert.equal(pendingQualityReport(local.store,'project-a'),reportId);assert.deepEqual([...local.values.values()],[reportId]);
  await assert.rejects(saveQualityReport(server.api,local.store,'project-a',snapshot,{newKey:()=>productId}),/原报告/);
  assert.equal(server.writes().length,1);
  const reopenedStore:ReportMarkerStore={...local.store};
  assert.equal((await recoverQualityReport(server.api,reopenedStore,'project-a'))?.key,reportId);
  assert.equal(pendingQualityReport(reopenedStore,'project-a'),'');assert.equal(server.writes().length,1);
  assert.equal(server.requests.at(-1)?.path,`custom-objects/${QUALITY_REPORT_CONTAINER}/${reportId}`);
});

test('storage failure and unverified storage writes stop before the first POST',async()=>{
  for(const failure of ['read','write','silent-write']){
    const server=fixture(),local=memory();
    const store:ReportMarkerStore={...local.store,getItem:key=>{if(failure==='read')throw new Error('blocked');return local.store.getItem(key);},setItem:(key,value)=>{if(failure==='write')throw new Error('quota');if(failure!=='silent-write')local.store.setItem(key,value);}};
    await assert.rejects(saveQualityReport(server.api,store,'project-a',snapshot,{newKey:()=>reportId}));assert.equal(server.writes().length,0);
  }
});

test('404 and invalid reports retain recovery marker; project markers are isolated',async()=>{
  const local=memory(),server=fixture();server.lose();
  await assert.rejects(saveQualityReport(server.api,local.store,'project-a',snapshot,{newKey:()=>reportId}));
  assert.equal(pendingQualityReport(local.store,'project-b'),'');
  const saved=server.records.get(reportId)!;server.records.delete(reportId);
  assert.equal(await recoverQualityReport(server.api,local.store,'project-a'),undefined);assert.equal(pendingQualityReport(local.store,'project-a'),reportId);
  server.records.set(reportId,{...saved,value:{...saved.value,ruleVersion:'unknown' as 'catalog-basic-v1'}});
  await assert.rejects(recoverQualityReport(server.api,local.store,'project-a'),/报告格式/);assert.equal(pendingQualityReport(local.store,'project-a'),reportId);assert.equal(server.writes().length,1);
});

test('only definite rejection releases the create marker; conflict and uncertain outcomes remain pending',async()=>{
  for(const status of [400,403,409,408,429,500]){
    const local=memory(),server=fixture();server.reject(status);
    await assert.rejects(saveQualityReport(server.api,local.store,'project-a',snapshot,{newKey:()=>reportId}));
    assert.equal(pendingQualityReport(local.store,'project-a'),[400,403].includes(status)?'':reportId);assert.equal(server.writes().length,1);
  }
});

test('lookup rejects invalid keys before GET and accepts existing v1 reports',async()=>{
  const local=memory(),server=fixture();
  await assert.rejects(readQualityReport(server.api,'bad/../key'),/UUID/);assert.equal(server.requests.length,0);
  await saveQualityReport(server.api,local.store,'project-a',snapshot,{newKey:()=>reportId});assert.equal(pendingQualityReport(local.store,'project-a'),'');
  const read=await readQualityReport(server.api,reportId);assert.equal(read?.value.ruleVersion,'catalog-basic-v1');assert.deepEqual(read?.value.snapshot,snapshot);
});

test('another in-flight response cannot clear a changed recovery marker',async()=>{
  const local=memory(),server=fixture();
  const api:OperationApi=async<T,>(path:string,payload?:unknown):Promise<T>=>{
    const result=await server.api<T>(path,payload);if(payload)local.values.set([...local.values.keys()][0],productId);return result;
  };
  await assert.rejects(saveQualityReport(api,local.store,'project-a',snapshot,{newKey:()=>reportId}),/标识已变化/);
  assert.equal(pendingQualityReport(local.store,'project-a'),productId);assert.equal(server.writes().length,1);
});
