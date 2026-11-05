import React,{useCallback,useEffect,useRef,useState} from 'react';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import TextField from '@commercetools-uikit/text-field';
import SelectField from '@commercetools-uikit/select-field';
import DataTable from '@commercetools-uikit/data-table';
import LoadingSpinner from '@commercetools-uikit/loading-spinner';
import PrimaryButton from '@commercetools-uikit/primary-button';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import {ContentNotification} from '@commercetools-uikit/notifications';
import {useCommerceApi,type Inventory} from './api';
import {errorMessage} from './domain';
import {Notice} from './shared';
import {readInventoryRows} from './inventory-data';
import {createOperation,readOperation,updateOperation,listOperations,type OperationDocument,type OperationCursor} from './operation-store';
import {executeInventoryStep,resumeInventoryStep,inspectInventoryReceipt,type PendingInventoryStep} from './inventory-workflow';
import {WMS_CONTAINER,WMS_STATUS,newTransfer,newCount,reviewCount,dispatchTransfer,receiveTransfer,applyCount,validWmsValue,type WmsMode,type WmsValue,type WmsEffect} from './wms-domain';

type Document=OperationDocument<WmsValue>;
type Preview={kind:'inventory';document:Document;effect:WmsEffect;stepId:string}|{kind:'review';document:Document;next:WmsValue};
const hasPending=(document:Document)=>Boolean((document.value as WmsValue&{pending?:unknown}).pending);
const location=(entry:Inventory)=>entry.supplyChannel?.obj?.key||entry.supplyChannel?.id||'无 Supply Channel';

export default function WmsWorkflows({canManage,mode}:{canManage:boolean;mode:WmsMode}){
  const api=useCommerceApi();
  const [documents,setDocuments]=React.useState<Document[]>([]),[nextCursor,setNextCursor]=useState<OperationCursor>();
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [selected,setSelected]=useState<Document>(),[keyInput,setKeyInput]=useState('');
  const [lookupKind,setLookupKind]=useState('sku'),[query,setQuery]=useState(''),[entries,setEntries]=useState<Inventory[]>([]);
  const [sourceId,setSourceId]=useState(''),[destinationId,setDestinationId]=useState('');
  const [quantity,setQuantity]=useState(''),[reason,setReason]=useState(''),[reference,setReference]=useState('');
  const [createPreview,setCreatePreview]=useState<{key:string;value:WmsValue}>(),[preview,setPreview]=useState<Preview>();
  const [receiveQuantity,setReceiveQuantity]=useState(''),[retryAllowed,setRetryAllowed]=useState(false);
  const saving=useRef(false),generation=useRef(0);
  const title=mode==='transfer'?'调拨单':'销售库存盘点单';
  const source=entries.find(entry=>entry.id===sourceId),destination=entries.find(entry=>entry.id===destinationId);

  const loadList=useCallback(async(cursor?:OperationCursor)=>{
    setLoading(true);const run=generation.current;
    try{
      const result=await listOperations<WmsValue>(api,WMS_CONTAINER,cursor);
      if(run!==generation.current)return;
      const values=result.results.filter(document=>validWmsValue(document.value,mode));
      setDocuments(previous=>cursor?[...previous,...values.filter(value=>!previous.some(row=>row.id===value.id))]:values);
      setNextCursor(result.nextCursor);
    }catch(e){if(run===generation.current)setError(errorMessage(e));}
    finally{if(run===generation.current)setLoading(false);}
  },[api,mode]);
  useEffect(()=>{
    generation.current++;setDocuments([]);setSelected(undefined);setPreview(undefined);setCreatePreview(undefined);setEntries([]);setSourceId('');setDestinationId('');setQuantity('');setReason('');setReference('');setReceiveQuantity('');setRetryAllowed(false);setMessage('');
    void loadList();return()=>{generation.current++;};
  },[loadList]);

  async function guarded(action:()=>Promise<void>){
    if(saving.current)return;saving.current=true;setBusy(true);setError('');setMessage('');
    try{await action();}catch(e){setError(`${errorMessage(e)} 请重新读取单据；结果不明确时先核对恢复，不要新建重复操作。`);setPreview(undefined);}
    finally{saving.current=false;setBusy(false);}
  }
  function clearCreate(){setCreatePreview(undefined);setMessage('');}
  async function locate(){await guarded(async()=>{
    if(!query.trim())throw new Error('请填写 SKU 或库存 ID。');
    setEntries([]);setSourceId('');setDestinationId('');clearCreate();
    const rows=await readInventoryRows(api,lookupKind==='id'?{kind:'entry',id:query.trim()}:{kind:'sku',sku:query.trim()});
    setEntries(rows);
    if(mode==='count'&&rows.length===1)setSourceId(rows[0].id);
    if(!rows.length)setMessage('未找到库存记录；不会自动把缺失记录当作零库存或创建仓库。');
  });}
  function prepareCreate(){
    if(!canManage||busy)return;
    try{
      if(!source)throw new Error('请选择库存记录。');
      const value=mode==='transfer'?(destination?newTransfer(source,destination,quantity,reason,reference):(()=>{throw new Error('请选择目的仓库存。');})()):newCount(source,quantity,reason,reference);
      setCreatePreview({key:crypto.randomUUID(),value});setError('');
    }catch(e){setError(errorMessage(e));setCreatePreview(undefined);}
  }
  async function saveCreate(){if(!canManage||!createPreview)return;await guarded(async()=>{
    const document=await createOperation<WmsValue>(api,WMS_CONTAINER,createPreview.key,createPreview.value);
    setSelected(document);setKeyInput(document.key);setCreatePreview(undefined);setPreview(undefined);setRetryAllowed(false);
    setDocuments(previous=>[document,...previous.filter(item=>item.key!==document.key)]);
    setMessage('单据已保存到 commercetools。此步骤没有改变库存；后续动作需逐次确认。');
  });}
  async function openDocument(key:string){await guarded(async()=>{
    if(!/^[a-zA-Z0-9._~-]{1,256}$/.test(key.trim()))throw new Error('请输入正确的单据编号。');
    const document=await readOperation<WmsValue>(api,WMS_CONTAINER,key.trim());
    if(!document||!validWmsValue(document.value,mode))throw new Error('没有找到此类型的仓储单据。');
    setSelected(document);setKeyInput(document.key);setPreview(undefined);setRetryAllowed(false);setReceiveQuantity('');
  });}
  async function prepareStep(kind:'dispatch'|'receive'|'review'|'apply'){
    if(!canManage||!selected)return;
    await guarded(async()=>{
      const document=await readOperation<WmsValue>(api,WMS_CONTAINER,selected.key);
      if(!document||!validWmsValue(document.value,mode))throw new Error('单据已不存在或格式不正确。');
      setSelected(document);setPreview(undefined);setRetryAllowed(false);
      if(hasPending(document))throw new Error('此单据有未核对步骤，请先核对恢复。');
      if(kind==='review'){setPreview({kind:'review',document,next:reviewCount(document.value)});return;}
      const id=kind==='receive'?document.value.destination?.id:document.value.source.id;
      if(!id)throw new Error('单据缺少库存记录。');
      const inventory=await api<Inventory>(`inventory/${encodeURIComponent(id)}?expand=supplyChannel`);
      const guard=await inspectInventoryReceipt(api,inventory);if(guard.blocked)throw new Error(guard.message||'库存有未核对的仓储步骤。');
      const effect=kind==='dispatch'?dispatchTransfer(document.value,inventory):kind==='receive'?receiveTransfer(document.value,inventory,receiveQuantity):applyCount(document.value,inventory);
      setPreview({kind:'inventory',document,effect,stepId:crypto.randomUUID()});
    });
  }
  async function confirmStep(){
    if(!canManage||!preview)return;
    await guarded(async()=>{
      if(preview.kind==='review'){
        const document=await updateOperation(api,preview.document,preview.next);setSelected(document);setMessage('盘点值已复核并保存；库存尚未更改。请预览差异后确认过账。');
      }else{
        const {effect}=preview;
        const result=await executeInventoryStep(api,preview.document,{stepId:preview.stepId,inventory:effect.inventory,action:effect.action,
          reason:preview.document.value.type==='count'?'count':'reconcile',note:preview.document.value.reason,reference:preview.document.value.reference||preview.document.key,nextValue:effect.next});
        setSelected(result.document);setRetryAllowed(result.state==='retry-allowed');
        if(result.state==='complete')setMessage('库存步骤与单据结果已保存并核对。未收数量继续保留在途，不会自动退回源仓。');
        else setError(result.message||'步骤尚未完成，请核对恢复单据。');
      }
      setPreview(undefined);await loadList();
    });
  }
  async function reconcile(retry=false){if(!canManage||!selected)return;await guarded(async()=>{
    // Explicit retry approval belongs to the exact pending step and document
    // version displayed to this operator, not a newer step fetched on click.
    const viewedPending=(selected.value as WmsValue&{pending?:PendingInventoryStep<WmsValue>}).pending;
    if(retry&&!viewedPending)throw new Error('当前显示的单据没有待重送步骤，请重新读取并核对。');
    const document=retry?selected:await readOperation<WmsValue>(api,WMS_CONTAINER,selected.key);
    if(!document||!validWmsValue(document.value,mode))throw new Error('单据不存在或格式无效。');
    const result=await resumeInventoryStep(api,document,retry?{retryIfUnchanged:true,expectedStepId:viewedPending!.stepId,expectedDocumentVersion:selected.version}:undefined);
    setSelected(result.document);setPreview(undefined);setRetryAllowed(result.state==='retry-allowed');
    if(result.state==='complete')setMessage('此步骤已核对并保存结果；没有重复更改已确认库存。');
    else setError(result.message||'结果仍待核对，不能盲目重试。');
    await loadList();
  });}

  const value=selected?.value;
  const pending=(value as (WmsValue&{pending?:PendingInventoryStep<WmsValue>})|undefined)?.pending;
  return <Spacings.Stack scale="l">
    <Text.Subheadline as="h4">{mode==='transfer'?'库存调拨':'CT 销售库存盘点'}</Text.Subheadline>
    <Text.Body>{mode==='transfer'?'先保存调拨计划，再分别确认发出和收货。每次只更改一条库存；部分收货保留剩余在途数量。':'记录并复核 CT 销售库存数量后，按快照版本应用差异。此数量不是仓库实物总量；已有订单扣减、预留及外部库存同步必须先核对。'}</Text.Body>
    <ContentNotification type="info">单据与步骤记录保存在 commercetools。离开页面不会自动执行；重新打开后可读取并核对恢复。平台原生操作和外部系统不受本面板协作检查约束。</ContentNotification>
    <Notice error={error} message={message}/>
    <Text.Subheadline as="h4">新建{title}</Text.Subheadline>
    <SelectField name="wms-lookup-kind" title="库存定位方式" value={lookupKind} options={[{value:'sku',label:'按 SKU 查找分仓库存'},{value:'id',label:'按 InventoryEntry ID 精确查找'}]} isDisabled={busy} onChange={event=>{setLookupKind(String(event.target.value));setEntries([]);setSourceId('');setDestinationId('');clearCreate();}}/>
    <TextField name="wms-query" title={lookupKind==='id'?'InventoryEntry ID':'完整 SKU'} value={query} isDisabled={busy} onChange={event=>{setQuery(event.target.value);setEntries([]);setSourceId('');setDestinationId('');clearCreate();}}/>
    <SecondaryButton label="读取库存记录" isDisabled={busy||!query.trim()} onClick={()=>void locate()}/>
    {entries.length>0&&<>
      <DataTable<Inventory> rows={entries} isCondensed columns={[{key:'sku',label:'SKU'},{key:'channel',label:'Supply Channel'},{key:'stock',label:'在库 / 可用'},{key:'version',label:'版本'}]} itemRenderer={(entry,column)=>column.key==='sku'?entry.sku:column.key==='channel'?location(entry):column.key==='stock'?`${entry.quantityOnStock} / ${entry.availableQuantity}`:entry.version}/>
      <SelectField name="wms-source" title={mode==='transfer'?'源仓库存':'盘点库存'} value={sourceId} options={entries.map(entry=>({value:entry.id,label:`${location(entry)} · ${entry.sku} · ${entry.quantityOnStock}/${entry.availableQuantity}`}))} isDisabled={busy} onChange={event=>{setSourceId(String(event.target.value));clearCreate();}}/>
      {mode==='transfer'&&<SelectField name="wms-destination" title="目的仓库存（必须同 SKU、不同 Supply Channel）" value={destinationId} options={entries.filter(entry=>entry.id!==sourceId).map(entry=>({value:entry.id,label:`${location(entry)} · ${entry.sku}`}))} isDisabled={busy} onChange={event=>{setDestinationId(String(event.target.value));clearCreate();}}/>}
      <TextField name="wms-quantity" title={mode==='transfer'?'计划调拨数量':'盘点后的 CT 销售库存数量（非实物总量）'} value={quantity} isDisabled={busy} onChange={event=>{setQuantity(event.target.value);clearCreate();}}/>
      <TextField name="wms-reason" title={mode==='transfer'?'调拨原因（必填）':'盘点口径与原因（必填）'} value={reason} isDisabled={busy} onChange={event=>{setReason(event.target.value);clearCreate();}}/>
      <TextField name="wms-reference" title="关联单据编号（可选）" value={reference} isDisabled={busy} onChange={event=>{setReference(event.target.value);clearCreate();}}/>
      <SecondaryButton label="预览新单据" isDisabled={!canManage||busy} onClick={prepareCreate}/>
    </>}
    {createPreview&&<Spacings.Stack scale="s">
      <ContentNotification type="warning">{createPreview.value.sku} · {createPreview.value.source.channelLabel}{mode==='transfer'?` → ${createPreview.value.destination?.channelLabel} · 计划 ${createPreview.value.planned} 件`:` · 快照 ${createPreview.value.source.quantity} → 盘点 ${createPreview.value.counted} · 库存版本 ${createPreview.value.source.version}`}。保存单据不会立即修改库存。</ContentNotification>
      <Text.Detail>原因：{createPreview.value.reason} · 关联：{createPreview.value.reference||'无'} · 单据 {createPreview.key}</Text.Detail>
      <PrimaryButton label="确认保存单据" isDisabled={!canManage||busy} onClick={()=>void saveCreate()}/>
      <SecondaryButton label="取消新单据预览" isDisabled={busy} onClick={()=>setCreatePreview(undefined)}/>
    </Spacings.Stack>}
    <Text.Subheadline as="h4">已保存{title}</Text.Subheadline>
    <Spacings.Inline><SecondaryButton label="刷新单据列表" isDisabled={busy||loading} onClick={()=>void loadList()}/>{loading&&<LoadingSpinner/>}</Spacings.Inline>
    <TextField name="wms-document-key" title="按单据编号继续处理" value={keyInput} isDisabled={busy} onChange={event=>setKeyInput(event.target.value)}/>
    <SecondaryButton label="读取此单据" isDisabled={busy||!keyInput.trim()} onClick={()=>void openDocument(keyInput)}/>
    {documents.length>0?<DataTable<Document> rows={documents} isCondensed columns={[{key:'key',label:'单据编号'},{key:'sku',label:'SKU'},{key:'status',label:'状态'},{key:'action',label:'操作'}]} itemRenderer={(document,column)=>column.key==='key'?document.key:column.key==='sku'?document.value.sku:column.key==='status'?(hasPending(document)?'步骤待核对':WMS_STATUS[document.value.status]||document.value.status):<SecondaryButton label="查看 / 继续" isDisabled={busy} onClick={()=>void openDocument(document.key)}/>}/>:!loading&&<Text.Detail>当前已读取批次中没有此类型单据。可继续读取更多或按编号打开。</Text.Detail>}
    {nextCursor&&<SecondaryButton label="读取更多单据" isDisabled={busy||loading} onClick={()=>void loadList(nextCursor)}/>}
    {selected&&value&&<Spacings.Stack scale="m">
      <Text.Subheadline as="h4">单据 {selected.key}</Text.Subheadline>
      <Text.Detail>{value.sku} · {WMS_STATUS[value.status]||value.status} · 单据版本 {selected.version}</Text.Detail>
      <Text.Detail>源记录：{value.source.channelLabel} · {value.source.id}{value.destination?` → ${value.destination.channelLabel} · ${value.destination.id}`:''}</Text.Detail>
      <Text.Detail>原因：{value.reason} · 关联单据：{value.reference||'无'}</Text.Detail>
      {value.type==='transfer'?<Text.Body>计划 {value.planned} · 已发出 {value.dispatched} · 已收货 {value.received} · 剩余在途 {value.dispatched-value.received}</Text.Body>:<Text.Body>库存快照 {value.source.quantity}（版本 {value.source.version}）· 盘点值 {value.counted} · 差异 {(value.counted??0)-value.source.quantity}</Text.Body>}
      <SecondaryButton label="重新读取单据" isDisabled={busy} onClick={()=>void openDocument(selected.key)}/>
      {hasPending(selected)?<>
        <ContentNotification type="warning">存在已保存的库存步骤，先核对收据。未确认完成前不能创建下一步；不会自动重新扣减或增加库存。</ContentNotification>
        {pending&&<Text.Detail>已确认的原步骤：{pending.action?.action==='removeQuantity'?'调拨发出':pending.action?.action==='addQuantity'?'调拨收货':'盘点过账'} · 数量 {pending.action?.quantity} · 在库 {pending.before} → {pending.after} · 原版本 {pending.expectedVersion} · 库存记录 {pending.inventoryId}</Text.Detail>}
        <SecondaryButton label="核对并恢复此步骤" isDisabled={!canManage||busy} onClick={()=>void reconcile()}/>
        {retryAllowed&&<><Text.Detail>核对确认库存尚未变化。仅重送此单据已保存的原步骤、原数量和原版本；不会创建新的库存动作。</Text.Detail><PrimaryButton label="确认重送原步骤" isDisabled={!canManage||busy} onClick={()=>void reconcile(true)}/></>}
      </>:<>
        {value.type==='transfer'&&value.status==='planned'&&<SecondaryButton label="预览发出库存" isDisabled={!canManage||busy} onClick={()=>void prepareStep('dispatch')}/>}
        {value.type==='transfer'&&value.status==='in_transit'&&<><TextField name="wms-receive-quantity" title="本次实际收货数量" value={receiveQuantity} isDisabled={busy} onChange={event=>{setReceiveQuantity(event.target.value);setPreview(undefined);}}/><SecondaryButton label="预览本次收货" isDisabled={!canManage||busy} onClick={()=>void prepareStep('receive')}/></>}
        {value.type==='count'&&value.status==='counted'&&<SecondaryButton label="预览复核盘点值" isDisabled={!canManage||busy} onClick={()=>void prepareStep('review')}/>}
        {value.type==='count'&&value.status==='reviewed'&&<SecondaryButton label="读取库存并预览过账" isDisabled={!canManage||busy} onClick={()=>void prepareStep('apply')}/>}
      </>}
      {preview&&<Spacings.Stack scale="s">
        <ContentNotification type="warning">{preview.kind==='review'?`复核盘点值 ${preview.next.counted}。此步骤仅保存当前操作人的确认，不改变库存，也不代表独立审批人批准。`:`${preview.effect.inventory.sku} · ${location(preview.effect.inventory)} · 在库 ${preview.effect.inventory.quantityOnStock} → ${preview.effect.after} · 库存版本 ${preview.effect.inventory.version}。确认只更新这一条库存，并保存单据步骤收据。`}</ContentNotification>
        <PrimaryButton label={busy?'正在保存…':preview.kind==='review'?'确认复核盘点值':preview.effect.label} isDisabled={!canManage||busy} onClick={()=>void confirmStep()}/>
        <SecondaryButton label="取消步骤预览" isDisabled={busy} onClick={()=>setPreview(undefined)}/>
      </Spacings.Stack>}
      {value.history.length>0&&<details><summary>已保存操作记录（{value.history.length}）</summary>{value.history.map((item,index)=><Text.Detail key={`${item.at}-${index}`}>{item.at} · {item.action} {item.quantity!==undefined?`· ${item.quantity}`:''} · {item.note}</Text.Detail>)}</details>}
    </Spacings.Stack>}
  </Spacings.Stack>;
}
