import React,{useCallback,useEffect,useRef,useState} from 'react';
import {useApplicationContext} from '@commercetools-frontend/application-shell-connectors';
import {ContentNotification} from '@commercetools-uikit/notifications';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import TextField from '@commercetools-uikit/text-field';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import {useCommerceApi} from './api';
import {errorMessage} from './domain';
import {listOperations,type OperationCursor} from './operation-store';
import type {QualityScan} from './quality-scan';
import {isResourceId} from './list-queries';
import {QUALITY_REPORT_CONTAINER,pendingQualityReport,readQualityReport,recoverQualityReport,saveQualityReport,type QualityReport,type QualityReportDocument} from './quality-report-attempt';

export default function QualityReports({snapshot,canSave,reportKey,onLoad,onSelect}:{snapshot:QualityScan;canSave:boolean;reportKey:string;onLoad:(scan:QualityScan,key:string)=>void;onSelect:(key:string)=>void}){
  const api=useCommerceApi(),project=useApplicationContext(context=>context.project?.key||'');
  const [reports,setReports]=React.useState<QualityReportDocument[]>([]),[cursor,setCursor]=useState<OperationCursor>();
  const [activity,setActivity]=useState(0),[error,setError]=useState(''),[message,setMessage]=useState(''),[pendingKey,setPendingKey]=useState('');
  const [storageReady,setStorageReady]=useState(false),[storageError,setStorageError]=useState(''),[lookup,setLookup]=useState(reportKey);
  const saving=useRef(false),mounted=useRef(true),reportRequest=useRef(0);
  const busy=activity>0;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;reportRequest.current++;};},[]);
  const syncPending=useCallback(()=>{
    try{const key=pendingQualityReport(window.localStorage,project);setPendingKey(key);setStorageReady(true);setStorageError('');return key;}
    catch{setStorageReady(false);setStorageError('无法读取或保存本机报告恢复标识。已暂停新报告保存；仍可按编号读取已保存报告。');return undefined;}
  },[project]);
  const remember=(saved:QualityReportDocument)=>setReports(previous=>[saved,...previous.filter(report=>report.key!==saved.key)]);
  const reconcile=useCallback(async()=>{
    setActivity(value=>value+1);setError('');
    try{
      const key=pendingQualityReport(window.localStorage,project);
      if(!key)return;
      const saved=await recoverQualityReport(api,window.localStorage,project);
      if(mounted.current){
        if(saved){remember(saved);setMessage(`已确认报告保存：${saved.key}`);}
        else setError(`尚未找到报告 ${key}，保存结果仍待核对。保留原编号，请稍后回读或联系管理员；不会重复创建。`);
      }
    }catch(cause){if(mounted.current)setError(errorMessage(cause));}
    finally{if(mounted.current){syncPending();setActivity(value=>value-1);}}
  },[api,project,syncPending]);
  const list=useCallback(async(next?:OperationCursor)=>{
    setActivity(value=>value+1);setError('');
    try{const page=await listOperations<QualityReport>(api,QUALITY_REPORT_CONTAINER,next);if(mounted.current){setReports(previous=>next?[...previous,...page.results.filter(report=>!previous.some(row=>row.key===report.key))]:page.results);setCursor(page.nextCursor);}}
    catch(cause){if(mounted.current)setError(errorMessage(cause));}finally{if(mounted.current)setActivity(value=>value-1);}
  },[api]);
  useEffect(()=>{void list();const key=syncPending();if(key)void reconcile();
    const changed=()=>{syncPending();};window.addEventListener('storage',changed);
    return()=>window.removeEventListener('storage',changed);
  },[list,syncPending,reconcile]);
  const load=useCallback(async(key:string)=>{
    const request=++reportRequest.current;setActivity(value=>value+1);setError('');setMessage('');
    try{
      const saved=await readQualityReport(api,key);
      if(mounted.current&&request===reportRequest.current){
        if(!saved)throw new Error('没有找到该报告。请核对编号与当前项目；不会创建替代报告。');
        remember(saved);onLoad(saved.value.snapshot,key);setMessage(`已载入 ${saved.value.recordedAt} 的历史观察；商品可能已改变，发布前仍需重新读取。`);
      }
    }catch(cause){if(mounted.current&&request===reportRequest.current)setError(errorMessage(cause));}
    finally{if(mounted.current)setActivity(value=>value-1);}
  },[api,onLoad]);
  useEffect(()=>{setLookup(reportKey);if(reportKey)void load(reportKey);else{reportRequest.current++;setMessage('');}
    return()=>{reportRequest.current++;};
  },[reportKey,load]);
  function select(key:string){
    const normalized=key.trim();
    if(!isResourceId(normalized)){setError('报告编号必须是有效 UUID。');return;}
    if(normalized===reportKey)void load(normalized);else onSelect(normalized);
  }
  async function save(){
    if(!canSave||busy||pendingKey||!storageReady||saving.current)return;
    saving.current=true;setActivity(value=>value+1);setError('');setMessage('');
    try{
      const saved=await saveQualityReport(api,window.localStorage,project,snapshot);
      if(mounted.current){remember(saved);setMessage(`检查报告已保存：${saved.key}`);onSelect(saved.key);}
    }catch(cause){if(mounted.current)setError(`${errorMessage(cause)} 如显示待核对编号，请先回读原报告。`);}
    finally{saving.current=false;if(mounted.current){syncPending();setActivity(value=>value-1);}}
  }
  return <Spacings.Stack scale="m">
    <Text.Subheadline as="h4">检查报告</Text.Subheadline>
    <Text.Detail>报告保存在当前项目，可按编号回查。报告记录检查结果及当时商品版本，不代表审批或库存、价格、渠道均可售。</Text.Detail>
    {busy&&<div role="status"><Text.Detail>正在读取或保存报告…</Text.Detail></div>}
    <Spacings.Inline><SecondaryButton label="保存本次检查报告" isDisabled={!canSave||busy||!snapshot.checked||Boolean(pendingKey)||!storageReady} onClick={()=>void save()}/><SecondaryButton label="刷新报告列表" isDisabled={busy} onClick={()=>void list()}/></Spacings.Inline>
    <TextField name="quality-report-key" title="报告编号（UUID）" value={lookup} onChange={event=>setLookup(event.target.value)}/>
    <Spacings.Inline><SecondaryButton label="读取此报告" isDisabled={busy||!lookup.trim()} onClick={()=>select(lookup)}/></Spacings.Inline>
    {pendingKey&&<Spacings.Stack scale="s"><ContentNotification type="warning">待核对报告编号：{pendingKey}。已暂停新报告保存；重新打开后仍按此编号核对。</ContentNotification><Spacings.Inline><SecondaryButton label="回读待核对报告" isDisabled={busy} onClick={()=>void reconcile()}/></Spacings.Inline></Spacings.Stack>}
    {storageError&&<ContentNotification type="warning">{storageError}</ContentNotification>}
    {error&&<ContentNotification type="error">{error}</ContentNotification>}{message&&<ContentNotification type="info">{message}</ContentNotification>}
    {reportKey&&<Text.Detail>当前报告：{reportKey} · 地址保留报告编号与问题筛选，可刷新后继续查看。</Text.Detail>}
    {reports.map(report=><Spacings.Inline key={report.key}><Text.Detail>{typeof report.value.recordedAt==='string'?report.value.recordedAt:report.createdAt} · {Number.isSafeInteger(report.value.snapshot?.checked)?report.value.snapshot.checked:'?'} 件 · {report.value.snapshot?.complete===true?'遍历完成':'部分范围'} · {report.key}</Text.Detail><SecondaryButton label="载入报告" isDisabled={busy} onClick={()=>select(report.key)}/></Spacings.Inline>)}
    {!reports.length&&!busy&&<Text.Detail>暂无已保存报告。</Text.Detail>}
    {cursor&&<SecondaryButton label="更多历史报告" isDisabled={busy} onClick={()=>void list(cursor)}/>}
  </Spacings.Stack>;
}
