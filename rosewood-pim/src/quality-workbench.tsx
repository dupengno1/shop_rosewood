import React,{useRef,useState,useEffect,useCallback} from 'react';
import {useHistory,useLocation} from 'react-router-dom';
import {ContentNotification} from '@commercetools-uikit/notifications';
import DataTable from '@commercetools-uikit/data-table';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import PrimaryButton from '@commercetools-uikit/primary-button';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import SelectField from '@commercetools-uikit/select-field';
import {useCommerceApi} from './api';
import {errorMessage} from './domain';
import {scanProductQuality,MAX_QUALITY_SCAN,type QualityScan} from './quality-scan';
import {qualityViewState,listHashState,hashLocation,type ProductListRow} from './list-queries';
import QualityReports from './quality-reports';

export default function QualityWorkbench({onSelect,snapshot,onSnapshot,canManage=false}:{onSelect:(id:string)=>void;snapshot:QualityScan;onSnapshot:(result:QualityScan)=>void;canManage?:boolean}){
  const api=useCommerceApi(),generation=useRef(0),location=useLocation(),history=useHistory();
  const {report:reportKey,filter,page:requestedPage}=qualityViewState(location),activeReport=useRef(reportKey);
  activeReport.current=reportKey;
  const [storedResult,setResult]=React.useState<QualityScan>(snapshot),[loadedReport,setLoadedReport]=useState<string|null>(reportKey?null:'');
  const result:QualityScan=loadedReport===reportKey?storedResult:{checked:0,rows:[],complete:false,limited:false};
  const [running,setRunning]=useState(false),[error,setError]=useState(''),[stopped,setStopped]=useState(false);
  useEffect(()=>()=>{generation.current++;},[]);
  function changeContext(changes:Record<string,string|undefined>){
    const next=listHashState(location,'pim');next.set('view','quality');
    for(const [key,value] of Object.entries(changes)){if(value)next.set(key,value);else next.delete(key);}
    history.push(hashLocation(location.pathname,next));
  }
  const loaded=useCallback((scan:QualityScan,key:string)=>{
    if(activeReport.current!==key)return;
    generation.current++;setRunning(false);setStopped(false);setError('');setLoadedReport(key);setResult(scan);onSnapshot(scan);
  },[onSnapshot]);
  function selectReport(key:string){
    activeReport.current=key;generation.current++;setRunning(false);setStopped(false);setError('');setLoadedReport(null);
    const empty={checked:0,rows:[],complete:false,limited:false};setResult(empty);onSnapshot(empty);
    changeContext({report:key,qualityPage:undefined});
  }
  async function start(){
    activeReport.current='';setLoadedReport('');changeContext({report:undefined,qualityPage:undefined});
    const run=++generation.current;setRunning(true);setError('');setStopped(false);
    const empty={checked:0,rows:[],complete:false,limited:false};setResult(empty);onSnapshot(empty);
    try{await scanProductQuality(api,value=>{if(generation.current===run){setResult(value);onSnapshot(value);}},()=>generation.current!==run);}
    catch(e){if(generation.current===run)setError(errorMessage(e));}
    finally{if(generation.current===run)setRunning(false);}
  }
  const filtered=result.rows.filter(row=>filter==='all'||filter==='errors'&&row.errorCount>0||filter==='warnings'&&row.warningCount>0||filter==='issues'&&(row.errorCount>0||row.warningCount>0));
  const page=Math.min(requestedPage,Math.max(0,Math.ceil(filtered.length/20)-1));
  const visible=filtered.slice(page*20,(page+1)*20);
  return <Spacings.Stack scale="l">
    <Text.Subheadline as="h4">目录质量工作台</Text.Subheadline>
    <Text.Body>检查当前项目商品的待发布内容，集中查看资料问题。检查只读取数据；修改和发布仍需进入商品逐项确认。</Text.Body>
    <Spacings.Inline><PrimaryButton label={running?'正在检查…':'开始目录检查'} isDisabled={running} onClick={()=>void start()}/>{running&&<SecondaryButton label="停止检查" onClick={()=>{generation.current++;setRunning(false);setStopped(true);}}/>}</Spacings.Inline>
    <Text.Detail>已检查 {result.checked} 件 · 有问题 {result.rows.filter(row=>row.errorCount||row.warningCount).length} 件 · 本次最多 {MAX_QUALITY_SCAN} 件</Text.Detail>
    {error&&<ContentNotification type="error">{error} 已保留本次成功检查的结果，范围尚不完整。可重新开始检查。</ContentNotification>}
    {running&&<ContentNotification type="info">正在按商品 ID 分页检查，以下为已完成部分。</ContentNotification>}
    {stopped&&<ContentNotification type="warning">检查已停止，以下只覆盖已读取的 {result.checked} 件商品。</ContentNotification>}
    {!running&&!stopped&&!error&&result.checked>0&&!result.complete&&!result.limited&&<ContentNotification type="warning">以下为此前已检查的部分结果；需要重新开始才能检查完整目录。</ContentNotification>}
    {result.complete&&<ContentNotification type="success">本次目录遍历完成。结果是检查时的观察，期间商品可能发生变化；发布前会重新读取。</ContentNotification>}
    {result.limited&&<ContentNotification type="warning">已达到 {MAX_QUALITY_SCAN} 件检查上限，以下结果不是完整目录。更大目录需后台批量任务。</ContentNotification>}
    <SelectField name="quality-filter" title="问题范围" value={filter} options={[{value:'issues',label:'有问题的商品'},{value:'errors',label:'发布阻断'},{value:'warnings',label:'待核对提醒'},{value:'all',label:'全部已检查商品'}]} onChange={event=>changeContext({qualityFilter:String(event.target.value)==='issues'?undefined:String(event.target.value),qualityPage:undefined})}/>
    {visible.length?<DataTable<ProductListRow> isCondensed rows={visible} columns={[{key:'name',label:'商品'},{key:'sku',label:'SKU'},{key:'issues',label:'检查结果'},{key:'action',label:'操作'}]} itemRenderer={(row,column)=>column.key==='name'?row.name:column.key==='sku'?row.skus.slice(0,3).join(' · '):column.key==='issues'?`${row.errorCount} 项阻断 · ${row.warningCount} 项提醒`:<SecondaryButton label="查看问题与发布" onClick={()=>onSelect(row.id)}/>}/>:<Text.Body>{result.checked?'当前已检查范围内没有符合筛选的商品。':'开始检查后显示商品问题列表。'}</Text.Body>}
    {filtered.length>0&&<Spacings.Inline><SecondaryButton label="上一页问题" isDisabled={page===0} onClick={()=>changeContext({qualityPage:page>1?String(page-1):undefined})}/><Text.Body>第 {page+1} 页 · {filtered.length} 件</Text.Body><SecondaryButton label="下一页问题" isDisabled={(page+1)*20>=filtered.length} onClick={()=>changeContext({qualityPage:String(page+1)})}/></Spacings.Inline>}
    {reportKey&&<Text.Detail>当前查看已保存报告；开始新的目录检查后才能保存新报告。</Text.Detail>}
    <QualityReports snapshot={result} canSave={canManage&&!running&&!reportKey} reportKey={reportKey} onLoad={loaded} onSelect={selectReport}/>
  </Spacings.Stack>;
}
