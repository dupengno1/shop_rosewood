import React,{useEffect,useRef,useState} from 'react';
import {ContentNotification} from '@commercetools-uikit/notifications';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import {useCommerceApi} from './api';
import {errorMessage} from './domain';
import {createOperation,listOperations,readOperation,type OperationDocument,type OperationCursor} from './operation-store';
import {MAX_QUALITY_SCAN,type QualityScan} from './quality-scan';
import {isResourceId} from './list-queries';

type QualityReport={schemaVersion:1;ruleVersion:'catalog-basic-v1';recordedAt:string;snapshot:QualityScan};
const CONTAINER='rw-mc-pim-reports';
function validSnapshot(value:QualityScan):boolean{
  if(!value||!Number.isSafeInteger(value.checked)||value.checked<0||value.checked>MAX_QUALITY_SCAN||!Array.isArray(value.rows)||value.checked!==value.rows.length||typeof value.complete!=='boolean'||typeof value.limited!=='boolean'||value.complete&&value.limited)return false;
  const seen=new Set<string>();
  return value.rows.every(row=>{
    if(!row||!isResourceId(row.id)||seen.has(row.id)||typeof row.name!=='string'||!Array.isArray(row.skus)||!row.skus.every(sku=>typeof sku==='string')||typeof row.published!=='boolean'||typeof row.hasStagedChanges!=='boolean')return false;
    if(![row.variantCount,row.errorCount,row.warningCount].every(number=>Number.isSafeInteger(number)&&number>=0)||row.version!==undefined&&(!Number.isSafeInteger(row.version)||row.version<1))return false;
    seen.add(row.id);return true;
  });
}

export default function QualityReports({snapshot,canSave,onLoad}:{snapshot:QualityScan;canSave:boolean;onLoad:(scan:QualityScan)=>void}){
  const api=useCommerceApi();
  const [reports,setReports]=React.useState<OperationDocument<QualityReport>[]>([]),[cursor,setCursor]=useState<OperationCursor>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[pendingKey,setPendingKey]=useState('');
  const saving=useRef(false);
  async function list(next?:OperationCursor){
    setBusy(true);setError('');
    try{const page=await listOperations<QualityReport>(api,CONTAINER,next);setReports(previous=>next?[...previous,...page.results]:page.results);setCursor(page.nextCursor);}
    catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}
  }
  useEffect(()=>{void list();},[api]);
  async function save(){
    if(!canSave||busy||pendingKey||saving.current)return;
    setError('');setMessage('');
    if(!snapshot.checked||!validSnapshot(snapshot)){setError('当前检查结果无效，请重新检查。');return;}
    const value:QualityReport={schemaVersion:1,ruleVersion:'catalog-basic-v1',recordedAt:new Date().toISOString(),snapshot};
    // Bound documents independently of platform limits; never silently truncate a report.
    if(new TextEncoder().encode(JSON.stringify(value)).length>2*1024*1024){setError('报告超过本应用 2 MiB 上限，未保存；请缩小检查范围。');return;}
    const key=crypto.randomUUID();saving.current=true;setPendingKey(key);setBusy(true);
    try{
      const saved=await createOperation(api,CONTAINER,key,value);
      setReports(previous=>[saved,...previous]);setPendingKey('');setMessage(`检查报告已保存：${saved.key}`);
    }catch(cause){setError(`${errorMessage(cause)} 请先回读此报告编号核对结果。`);}
    finally{saving.current=false;setBusy(false);}
  }
  async function reconcile(){
    if(!pendingKey||busy)return;setBusy(true);setError('');
    try{
      const saved=await readOperation<QualityReport>(api,CONTAINER,pendingKey);
      if(saved){setReports(previous=>[saved,...previous.filter(r=>r.key!==saved.key)]);setPendingKey('');setMessage(`已确认报告保存：${saved.key}`);}
      else setError('尚未找到该报告，写入结果仍待核对。请稍后回读或联系管理员，不自动重复创建。');
    }catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}
  }
  function load(report:OperationDocument<QualityReport>){
    const value=report.value;
    if(value.schemaVersion!==1||value.ruleVersion!=='catalog-basic-v1'||typeof value.recordedAt!=='string'||!Number.isFinite(Date.parse(value.recordedAt))||!validSnapshot(value.snapshot)){setError('报告格式不可识别，未载入。');return;}
    setError('');onLoad(value.snapshot);setMessage(`已载入 ${value.recordedAt} 的历史观察；商品可能已改变，发布前仍需重新读取。`);
  }
  return <Spacings.Stack scale="m">
    <Text.Subheadline as="h4">检查报告</Text.Subheadline>
    <Text.Detail>报告保存在当前项目，可关闭页面后回查。报告记录检查结果及当时商品版本，不代表审批或库存、价格、渠道均可售。</Text.Detail>
    <Spacings.Inline><SecondaryButton label="保存本次检查报告" isDisabled={!canSave||busy||!snapshot.checked||Boolean(pendingKey)} onClick={()=>void save()}/><SecondaryButton label="刷新报告列表" isDisabled={busy} onClick={()=>void list()}/></Spacings.Inline>
    {pendingKey&&<Spacings.Stack scale="s"><ContentNotification type="warning">待核对报告编号：{pendingKey}</ContentNotification><SecondaryButton label="回读待核对报告" isDisabled={busy} onClick={()=>void reconcile()}/></Spacings.Stack>}
    {error&&<ContentNotification type="error">{error}</ContentNotification>}{message&&<ContentNotification type="info">{message}</ContentNotification>}
    {reports.map(report=><Spacings.Inline key={report.key}><Text.Detail>{typeof report.value.recordedAt==='string'?report.value.recordedAt:report.createdAt} · {Number.isSafeInteger(report.value.snapshot?.checked)?report.value.snapshot.checked:'?'} 件 · {report.value.snapshot?.complete===true?'遍历完成':'部分范围'} · {report.key}</Text.Detail><SecondaryButton label="载入报告" isDisabled={busy} onClick={()=>load(report)}/></Spacings.Inline>)}
    {!reports.length&&!busy&&<Text.Detail>暂无已保存报告。</Text.Detail>}
    {cursor&&<SecondaryButton label="更多历史报告" isDisabled={busy} onClick={()=>void list(cursor)}/>}
  </Spacings.Stack>;
}
