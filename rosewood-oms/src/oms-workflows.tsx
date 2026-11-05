import React,{useCallback,useEffect,useRef,useState} from 'react';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import TextField from '@commercetools-uikit/text-field';
import SelectField from '@commercetools-uikit/select-field';
import PrimaryButton from '@commercetools-uikit/primary-button';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import LoadingSpinner from '@commercetools-uikit/loading-spinner';
import {ContentNotification} from '@commercetools-uikit/notifications';
import {useCommerceApi} from './api';
import {errorMessage,fulfillmentLines} from './domain';
import {readInventoryRows} from './inventory-data';
import {readOperation,createOperation,updateOperation,operationStatus,type OperationDocument} from './operation-store';
import {Notice,Section} from './shared';
import {OMS_CONTAINER,emptyOmsOperations,validateOmsOperations,createAllocation,cancelAllocation,lineInventoryContext,
  createReturnRequest,prepareReturnReceipt,reconcileReturnReceipt,releaseRejectedReceipt,refundBudget,createRefundRequest,
  cancelReturnRequest,cancelRefundRequest,returnCapacity,
  type OmsOrder,type OmsOperations,type OmsInventory} from './oms-domain';
import {parseOmsMajorAmount,formatOmsMoney} from './oms-money';

type Document=OperationDocument<OmsOperations>;
type Marker={id:string;collection:'allocations'|'returns'|'refunds';status:string};
type Preview={orderVersion:number;documentVersion:number;summary:string;marker:Marker;build?:(order:OmsOrder,data:OmsOperations,inventory?:OmsInventory)=>OmsOperations;inventory?:OmsInventory;receiptId?:string};
const statuses:Record<string,string>={planned:'计划已保存 · 未占用库存',cancelled:'已取消',requested:'申请已保存 · 待执行',receiving:'实收结果待核对',received:'原生实收已登记',executing:'待执行结果',completed:'已完成申请',rejected:'已拒绝'};

export default function OrderOperations({order:initialOrder,canManage,onReload,onBusyChange}:{order:OmsOrder;canManage:boolean;onReload?:()=>void|Promise<void>;onBusyChange?:(busy:boolean)=>void}){
  const api=useCommerceApi(),lock=useRef(false),storageKey=`rw-oms-operation-attempt:${initialOrder.id}`;
  const [order,setOrder]=React.useState(initialOrder),[document,setDocument]=useState<Document>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[blocked,setBlocked]=useState(false),[preview,setPreview]=useState<Preview>();
  const [lineId,setLineId]=useState(''),[inventoryId,setInventoryId]=useState(''),[inventories,setInventories]=useState<OmsInventory[]>([]),[inventoryLoading,setInventoryLoading]=useState(false),[inventoryError,setInventoryError]=useState('');
  const [allocationQuantity,setAllocationQuantity]=useState(''),[allocationReason,setAllocationReason]=useState('');
  const [returnKind,setReturnKind]=useState<'return'|'exchange'>('return'),[returnLineId,setReturnLineId]=useState(''),[returnQuantity,setReturnQuantity]=useState(''),[returnReason,setReturnReason]=useState(''),[replacement,setReplacement]=useState('');
  const [refundAmount,setRefundAmount]=useState(''),[refundReason,setRefundReason]=useState('');
  const [cancellationReasons,setCancellationReasons]=useState<Record<string,string>>({});
  const data=document?.value||emptyOmsOperations(initialOrder.id);
  const clearPreview=()=>setPreview(undefined);
  const reload=useCallback(async()=>{
    setLoading(true);setError('');setPreview(undefined);
    try{
      const [fresh,stored]=await Promise.all([api<OmsOrder>(`orders/${initialOrder.id}`),readOperation<OmsOperations>(api,OMS_CONTAINER,initialOrder.id)]);
      if(stored)validateOmsOperations(stored.value,initialOrder.id);
      if(fresh.id!==initialOrder.id)throw new Error('平台返回的订单不匹配。');
      setOrder(fresh);setDocument(stored);
      const raw=window.sessionStorage.getItem(storageKey);
      if(raw){
        const marker=JSON.parse(raw) as Marker;
        const collection=marker.collection==='allocations'||marker.collection==='returns'||marker.collection==='refunds'?marker.collection:undefined;
        if(collection&&stored?.value[collection].some(item=>item.id===marker.id&&item.status===marker.status)){
          window.sessionStorage.removeItem(storageKey);setBlocked(false);setMessage('已回读确认上次运营记录，没有重复提交。');
        }else{setBlocked(true);setError('上次保存结果尚未确认，已暂停新增写入。请刷新核对或联系管理员；不会自动重发。');}
      }else setBlocked(false);
    }catch(e){setBlocked(true);setError(errorMessage(e));}finally{setLoading(false);}
  },[api,initialOrder.id,storageKey]);
  useEffect(()=>{void reload();},[reload,initialOrder.version]);
  useEffect(()=>{onBusyChange?.(busy);return ()=>onBusyChange?.(false);},[busy,onBusyChange]);
  useEffect(()=>{
    let active=true;setInventories([]);setInventoryId('');setInventoryError('');
    const line=order.lineItems?.find(item=>item.id===lineId),sku=line?.variant?.sku;
    if(!sku){setInventoryLoading(false);return;}
    setInventoryLoading(true);
    readInventoryRows(api,{kind:'sku',sku}).then(rows=>{if(active)setInventories(rows as OmsInventory[]);}).catch(e=>{if(active)setInventoryError(errorMessage(e));}).finally(()=>{if(active)setInventoryLoading(false);});
    return ()=>{active=false;};
  },[api,lineId,order]);
  let physical:ReturnType<typeof fulfillmentLines>=[],domainError='';
  try{physical=fulfillmentLines(order).filter(line=>line.classification.type==='physical');}catch(e){domainError=errorMessage(e);}
  let budget:ReturnType<typeof refundBudget>|undefined,budgetError='';
  try{budget=refundBudget(order,data);}catch(e){budgetError=errorMessage(e);}
  let returnRemaining:number|undefined,returnError='';
  if(returnLineId)try{returnRemaining=returnCapacity(order,data,returnLineId);}catch(e){returnError=errorMessage(e);}
  const disabled=!canManage||busy||loading||blocked||Boolean(domainError);
  const options=physical.map(line=>({value:line.id,label:`${line.name} · ${line.sku||'自定义实物'} · 已登记 ${line.deliveredQuantity} / 未发 ${line.remainingQuantity}`}));
  const context=lineId&&order.lineItems?.some(line=>line.id===lineId)?lineInventoryContext(order,lineId):undefined;
  function showPreview(candidate:Omit<Preview,'orderVersion'|'documentVersion'>){
    if(disabled)return;
    try{
      if(candidate.receiptId)prepareReturnReceipt(order,data,candidate.receiptId);
      else candidate.build!(order,data,candidate.inventory);
      setPreview({...candidate,orderVersion:order.version!,documentVersion:document?.version||0});setError('');setMessage('');
    }catch(e){setPreview(undefined);setError(errorMessage(e));}
  }
  async function persist(next:OmsOperations,previous:Document|undefined,marker:Marker):Promise<Document>{
    // Only request identity is stored in the browser; all business data lives in CT.
    window.sessionStorage.setItem(storageKey,JSON.stringify(marker));setBlocked(true);
    try{
      const saved=previous?await updateOperation(api,previous,next):await createOperation(api,OMS_CONTAINER,initialOrder.id,next);
      validateOmsOperations(saved.value,initialOrder.id);setDocument(saved);window.sessionStorage.removeItem(storageKey);setBlocked(false);return saved;
    }catch(e){
      const outcome=e&&typeof e==='object'&&'outcome' in e?e.outcome:undefined;
      if(outcome==='conflict'||outcome==='rejected')window.sessionStorage.removeItem(storageKey);
      throw e;
    }
  }
  async function save(){
    if(disabled||!preview||lock.current)return;const chosen=preview;lock.current=true;setBusy(true);setError('');setMessage('');
    try{
      const [fresh,stored]=await Promise.all([api<OmsOrder>(`orders/${initialOrder.id}`),readOperation<OmsOperations>(api,OMS_CONTAINER,initialOrder.id)]);
      const current=stored?validateOmsOperations(stored.value,initialOrder.id):emptyOmsOperations(initialOrder.id);
      if(fresh.id!==initialOrder.id||fresh.version!==chosen.orderVersion||(stored?.version||0)!==chosen.documentVersion)throw new Error('订单或运营记录已变化，请刷新后重新预览。');
      if(chosen.receiptId){
        const prepared=prepareReturnReceipt(fresh,current,chosen.receiptId);
        const intent=await persist(prepared.intent,stored,{id:chosen.receiptId,collection:'returns',status:'receiving'});
        // The durable intent survives navigation and any ambiguous Order response.
        let result:OmsOrder;
        try{result=await api<OmsOrder>(`orders/${fresh.id}`,{version:fresh.version,actions:[prepared.action]});}
        catch(cause){
          const status=operationStatus(cause);
          if(status&&status>=400&&status<500&&status!==408&&status!==429){
            // A definitive rejection changed no Order. Reopen only after saving
            // that fact; the operator must reload, preview and confirm again.
            await persist(releaseRejectedReceipt(intent.value,chosen.receiptId,status),intent,{id:chosen.receiptId,collection:'returns',status:'requested'});
          }
          throw cause;
        }
        setOrder(result);
        await persist(reconcileReturnReceipt(result,intent.value,chosen.receiptId),intent,{id:chosen.receiptId,collection:'returns',status:'received'});
        setMessage('退货实收已登记到原生 ReturnInfo。未增加库存、未退款、未创建替换订单。');
        await onReload?.();
      }else{
        let inventory=chosen.inventory;
        if(inventory){
          const live=await api<OmsInventory>(`inventory/${inventory.id}?expand=supplyChannel`);
          if(live.id!==inventory.id||live.version!==inventory.version)throw new Error('库存记录已变化，请刷新候选并重新预览。');
          inventory=live;
        }
        await persist(chosen.build!(fresh,current,inventory),stored,chosen.marker);setOrder(fresh);
        setMessage(chosen.marker.status==='cancelled'?'申请或计划已取消并保留记录。未变更原生退货、库存或支付；申请额度已重新计算。':'运营记录已持久保存。分仓计划未预留库存；退换及退款申请均待实际执行。');
        setAllocationQuantity('');setAllocationReason('');setReturnQuantity('');setReturnReason('');setReplacement('');setRefundAmount('');setRefundReason('');
        setCancellationReasons(previous=>{const next={...previous};delete next[chosen.marker.id];return next;});
      }
      setPreview(undefined);
    }catch(e){setPreview(undefined);setBlocked(true);setError(errorMessage(e)+' 请刷新核对；不会自动重发。');}
    finally{lock.current=false;setBusy(false);}
  }
  async function reconcile(id:string){
    if(disabled||lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');
    try{
      const [fresh,stored]=await Promise.all([api<OmsOrder>(`orders/${initialOrder.id}`),readOperation<OmsOperations>(api,OMS_CONTAINER,initialOrder.id)]);
      if(!stored)throw new Error('退货意图记录不存在。');
      const next=reconcileReturnReceipt(fresh,validateOmsOperations(stored.value,initialOrder.id),id);
      await persist(next,stored,{id,collection:'returns',status:'received'});setOrder(fresh);setMessage('已按稳定退货键确认原生实收，未重复登记。');await onReload?.();
    }catch(e){setError(errorMessage(e));}finally{lock.current=false;setBusy(false);}
  }
  return <Section title="OMS · 分仓、退换与退款申请">
    <Notice error={error||domainError} message={message}/>
    <Spacings.Inline><SecondaryButton label="刷新运营记录 / 核对保存结果" isDisabled={busy||loading} onClick={()=>void reload()}/>{loading&&<LoadingSpinner/>}</Spacings.Inline>
    <Text.Detail>记录保存在当前项目的 Custom Object，关闭页面后可恢复。版本冲突须重新预览；这里不执行库存预留、回库或支付退款。</Text.Detail>
    <Section title="分仓计划">
      <ContentNotification type="info">计划不改变成单时的原仓。已跟踪或预留的行只允许选择原仓；原仓当前可用量低不代表该订单无法履约，因为下单时可能已扣减。已有计划不会随发运自动撤销，请核对后取消已消耗计划。</ContentNotification>
      <SelectField name="allocation-line" title="实物订单行" value={lineId} options={options.filter(option=>order.lineItems?.some(line=>line.id===option.value))} isDisabled={disabled} onChange={event=>{setLineId(String(event.target.value));clearPreview();}}/>
      {context&&<Text.Detail>原 Supply Channel：{context.supplyChannelId||'无渠道'} · 原库存模式：{context.inventoryMode}</Text.Detail>}
      <Notice error={inventoryError}/>
      {inventoryLoading?<LoadingSpinner/>:<SelectField name="allocation-inventory" title="真实库存记录 / 仓库" value={inventoryId} options={inventories.map(row=>({value:row.id,label:`${row.supplyChannel?.obj?.key||row.supplyChannel?.id||'无 Supply Channel'} · 在库 ${row.quantityOnStock} · 可用 ${row.availableQuantity}`}))} isDisabled={disabled||!inventories.length} onChange={event=>{setInventoryId(String(event.target.value));clearPreview();}}/>}
      {lineId&&!inventoryLoading&&!inventoryError&&!inventories.length&&<Text.Detail>没有此 SKU 的库存记录；这不等于零库存，不生成推测的仓库。</Text.Detail>}
      <TextField name="allocation-quantity" title="计划数量（整数）" value={allocationQuantity} isDisabled={disabled} onChange={event=>{setAllocationQuantity(event.target.value);clearPreview();}}/>
      <TextField name="allocation-reason" title="分仓说明" value={allocationReason} isDisabled={disabled} onChange={event=>{setAllocationReason(event.target.value);clearPreview();}}/>
      <Spacings.Inline><PrimaryButton label="预览保存分仓计划" isDisabled={disabled||inventoryLoading||!inventoryId} onClick={()=>{
        const id=crypto.randomUUID(),inventory=inventories.find(row=>row.id===inventoryId),input={id,lineItemId:lineId,quantity:allocationQuantity,reason:allocationReason};
        if(!inventory)return;showPreview({marker:{id,collection:'allocations',status:'planned'},inventory,summary:`将保存 ${allocationQuantity} 件分仓计划；不预留库存、不改原仓、不登记发运。`,build:(fresh,current,live)=>createAllocation(fresh,current,live!,input)});
      }}/></Spacings.Inline>
      {data.allocations.map(item=><Spacings.Stack key={item.id} scale="s"><Text.Body>{item.sku} · {item.quantity} 件 · {item.supplyChannelId||'无渠道'} · {statuses[item.status]}</Text.Body><Text.Detail>{item.reason}</Text.Detail>{item.status==='planned'&&<Spacings.Inline><SecondaryButton label="预览取消此计划" isDisabled={disabled} onClick={()=>showPreview({marker:{id:item.id,collection:'allocations',status:'cancelled'},summary:'仅取消分仓计划记录，不变更库存或已有 Delivery。',build:(_fresh,current)=>cancelAllocation(current,item.id)})}/></Spacings.Inline>}</Spacings.Stack>)}
    </Section>
    <Section title="退货 / 换货申请与实收">
      <Text.Body>申请数量以已登记发运量为上限，扣除已有原生退货及待执行申请。换货只保存期望 SKU，尚未核对可售条件或创建替换订单。登记实收前请确认货物已实际收到。</Text.Body>
      <SelectField name="return-kind" title="申请类型" value={returnKind} options={[{value:'return',label:'退货'},{value:'exchange',label:'换货'}]} isDisabled={disabled} onChange={event=>{setReturnKind(event.target.value==='exchange'?'exchange':'return');clearPreview();}}/>
      <SelectField name="return-line" title="退换实物行" value={returnLineId} options={options} isDisabled={disabled} onChange={event=>{setReturnLineId(String(event.target.value));clearPreview();}}/>
      <Notice error={returnError}/>
      {returnRemaining!==undefined&&<Text.Detail>当前可申请退换：{returnRemaining} 件。已扣除原生退货及未取消申请；取消待执行申请后释放其占用数量。</Text.Detail>}
      <TextField name="return-quantity" title="申请数量（整数）" value={returnQuantity} isDisabled={disabled} onChange={event=>{setReturnQuantity(event.target.value);clearPreview();}}/>
      <TextField name="return-reason" title="退换原因" value={returnReason} isDisabled={disabled} onChange={event=>{setReturnReason(event.target.value);clearPreview();}}/>
      {returnKind==='exchange'&&<TextField name="replacement-sku" title="期望替换 SKU（待业务确认）" value={replacement} isDisabled={disabled} onChange={event=>{setReplacement(event.target.value);clearPreview();}}/>}
      <Spacings.Inline><PrimaryButton label="预览保存退换申请" isDisabled={disabled} onClick={()=>{
        const id=crypto.randomUUID(),input={id,kind:returnKind,lineItemId:returnLineId,quantity:returnQuantity,reason:returnReason,replacementSku:replacement};
        showPreview({marker:{id,collection:'returns',status:'requested'},summary:`保存 ${returnQuantity} 件${returnKind==='exchange'?'换货':'退货'}申请，尚未登记实收、回库或退款。`,build:(fresh,current)=>createReturnRequest(fresh,current,input)});
      }}/></Spacings.Inline>
      {data.returns.map(item=><Spacings.Stack key={item.id} scale="s"><Text.Body>{item.kind==='exchange'?'换货':'退货'} · {item.quantity} 件 · {physical.find(line=>line.id===item.lineItemId)?.name||item.lineItemId} · {statuses[item.status]}</Text.Body><Text.Detail>{item.reason}{item.replacementSku?` · 期望替换 SKU：${item.replacementSku}（未执行）`:''}</Text.Detail>
        {item.status==='requested'&&<React.Fragment><Spacings.Inline><SecondaryButton label="预览登记实际收到退货" isDisabled={disabled} onClick={()=>showPreview({marker:{id:item.id,collection:'returns',status:'receiving'},receiptId:item.id,summary:`确认已实际收到 ${item.quantity} 件，将新增原生 Returned 记录。不会回库、退款或创建替换订单。`})}/></Spacings.Inline>
          <TextField name={`return-cancel-${item.id}`} title="取消此退换申请的原因" value={cancellationReasons[item.id]||''} isDisabled={disabled} onChange={event=>{setCancellationReasons(previous=>({...previous,[item.id]:event.target.value}));clearPreview();}}/>
          <Spacings.Inline><SecondaryButton label="预览取消退换申请" isDisabled={disabled} onClick={()=>{const reason=cancellationReasons[item.id]||'';showPreview({marker:{id:item.id,collection:'returns',status:'cancelled'},summary:`取消此 ${item.quantity} 件${item.kind==='exchange'?'换货':'退货'}申请并保留记录，释放其申请数量。原因：${reason}。不变更原生退货、库存或支付。`,build:(fresh,current)=>cancelReturnRequest(fresh,current,item.id,reason)});}}/></Spacings.Inline>
        </React.Fragment>}
        {item.status==='receiving'&&<Spacings.Inline><SecondaryButton label="核对原生实收结果（不重发）" isDisabled={disabled} onClick={()=>void reconcile(item.id)}/></Spacings.Inline>}
        {item.status==='cancelled'&&<Text.Detail>取消时间：{item.cancelledAt||'旧记录未提供'} · 取消原因：{item.cancellationReason||'旧记录未提供'}</Text.Detail>}
      </Spacings.Stack>)}
    </Section>
    <Section title="退款申请 · 待支付方执行">
      <ContentNotification type="warning">仅保存申请，不调用 PSP、不标记退款成功。下方上限只扣除本工作台的待执行和已完成申请，不能作为支付方实际可退余额；执行前须对账。</ContentNotification>
      <Notice error={budgetError}/>
      {budget&&<Text.Detail>订单总额 {formatOmsMoney(budget.total,budget.currencyCode,budget.fractionDigits)} · 本工作台可申请上限 {formatOmsMoney(budget.remaining,budget.currencyCode,budget.fractionDigits)}。按主币单位填写，最多 {budget.fractionDigits} 位小数；保存时使用整数最小货币单位。</Text.Detail>}
      <TextField name="refund-amount" title={`申请金额（${budget?.currencyCode||'订单币种'} 主币单位）`} value={refundAmount} isDisabled={disabled||!budget} onChange={event=>{setRefundAmount(event.target.value);clearPreview();}}/>
      <TextField name="refund-reason" title="退款原因" value={refundReason} isDisabled={disabled||!budget} onChange={event=>{setRefundReason(event.target.value);clearPreview();}}/>
      <Spacings.Inline><PrimaryButton label="预览保存退款申请" isDisabled={disabled||!budget} onClick={()=>{
        if(!budget)return;try{const amount=parseOmsMajorAmount(refundAmount,budget.fractionDigits),id=crypto.randomUUID(),input={id,amount,currencyCode:budget.currencyCode,reason:refundReason};
          showPreview({marker:{id,collection:'refunds',status:'requested'},summary:`保存 ${formatOmsMoney(amount,budget.currencyCode,budget.fractionDigits)} 退款申请（整数最小货币单位：${amount} ${budget.currencyCode}），状态为待执行，不执行资金交易。`,build:(fresh,current)=>createRefundRequest(fresh,current,input)});
        }catch(e){setPreview(undefined);setError(errorMessage(e));}
      }}/></Spacings.Inline>
      {data.refunds.map(item=><Spacings.Stack key={item.id} scale="s"><Text.Body>{budget?formatOmsMoney(item.amount,item.currencyCode,budget.fractionDigits):`${item.amount} ${item.currencyCode} 最小单位（币种精度待核对）`} · {statuses[item.status]} · {item.reason}</Text.Body>
        <Text.Detail>整数最小货币单位：{item.amount} {item.currencyCode}</Text.Detail>
        {item.status==='requested'&&<React.Fragment><TextField name={`refund-cancel-${item.id}`} title="取消此退款申请的原因" value={cancellationReasons[item.id]||''} isDisabled={disabled} onChange={event=>{setCancellationReasons(previous=>({...previous,[item.id]:event.target.value}));clearPreview();}}/>
          <Spacings.Inline><SecondaryButton label="预览取消退款申请" isDisabled={disabled} onClick={()=>{const reason=cancellationReasons[item.id]||'';showPreview({marker:{id:item.id,collection:'refunds',status:'cancelled'},summary:`取消此 ${budget?formatOmsMoney(item.amount,item.currencyCode,budget.fractionDigits):`${item.amount} ${item.currencyCode} 最小单位`} 退款申请并保留记录，释放本工作台申请额度。原因：${reason}。不撤回已执行交易、不调用支付方。`,build:(fresh,current)=>cancelRefundRequest(fresh,current,item.id,reason)});}}/></Spacings.Inline>
        </React.Fragment>}
        {item.status==='cancelled'&&<Text.Detail>取消时间：{item.cancelledAt||'旧记录未提供'} · 取消原因：{item.cancellationReason||'旧记录未提供'}</Text.Detail>}
      </Spacings.Stack>)}
    </Section>
    {preview&&<Section title="确认本次操作"><ContentNotification type="warning">{preview.summary}</ContentNotification><Text.Detail>订单版本 {preview.orderVersion} · 运营记录版本 {preview.documentVersion} · 请求 {preview.marker.id}</Text.Detail><Spacings.Inline><PrimaryButton label={busy?'正在保存…':'确认保存'} isDisabled={disabled} onClick={()=>void save()}/><SecondaryButton label="取消预览" isDisabled={busy} onClick={clearPreview}/></Spacings.Inline></Section>}
  </Section>;
}
