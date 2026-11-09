import React,{useCallback,useEffect,useRef,useState} from 'react';
import {useApplicationContext} from '@commercetools-frontend/application-shell-connectors';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import TextField from '@commercetools-uikit/text-field';
import SelectField from '@commercetools-uikit/select-field';
import PrimaryButton from '@commercetools-uikit/primary-button';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import LoadingSpinner from '@commercetools-uikit/loading-spinner';
import {ContentNotification} from '@commercetools-uikit/notifications';
import {useCommerceApi,type Order} from './api';
import DataTable from '@commercetools-uikit/data-table';
import {orderConsignments,warehouseName} from './operations-data';
import {errorMessage,fulfillmentLines} from './domain';
import {readInventoryRows} from './inventory-data';
import {readOperation,createOperation,updateOperation,operationStatus,type OperationDocument} from './operation-store';
import {Notice,Section} from './shared';
import {OMS_CONTAINER,emptyOmsOperations,validateOmsOperations,createAllocation,cancelAllocation,lineInventoryContext,
  createReturnRequest,prepareReturnReceipt,reconcileReturnReceipt,releaseRejectedReceipt,refundBudget,createRefundRequest,
  cancelReturnRequest,cancelRefundRequest,returnCapacity,reviewOmsRequest,updateConsignment,consignmentTransitions,recordDigitalFulfilment,currentDigitalFulfilment,type DigitalFulfilmentRecord,type ConsignmentRecord,
  type OmsOrder,type OmsOperations,type OmsInventory} from './oms-domain';
import {parseOmsMajorAmount,formatOmsMoney} from './oms-money';
import {readOrderReservationCart,orderReservationRows,reservationTotal,type ReservationObservation} from './order-reservations';

type Document=OperationDocument<OmsOperations>;
type Marker={id:string;collection:'allocations'|'returns'|'refunds'|'consignments'|'digitalFulfilment';status:string;approval?:string};
type Preview={actorId?:string;orderVersion:number;documentVersion:number;summary:string;marker:Marker;build?:(order:OmsOrder,data:OmsOperations,inventory?:OmsInventory)=>OmsOperations;inventory?:OmsInventory;receiptId?:string};
const statuses:Record<string,string>={planned:'Planned — not reserved',cancelled:'Cancelled',requested:'Requested — awaiting execution',receiving:'Receipt reconciliation required',received:'Receipt recorded',executing:'Execution pending',completed:'Completed',rejected:'Rejected'};

export default function OrderOperations({order:initialOrder,canManage,onReload,onBusyChange}:{order:OmsOrder;canManage:boolean;onReload?:()=>void|Promise<void>;onBusyChange?:(busy:boolean)=>void}){
  const operatorId=useApplicationContext(context=>context.user?.id);
  const api=useCommerceApi(),lock=useRef(false),storageKey=`rw-oms-operation-attempt:${initialOrder.id}`;
  const [order,setOrder]=React.useState(initialOrder),[document,setDocument]=useState<Document>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[blocked,setBlocked]=useState(false),[preview,setPreview]=useState<Preview>();
  const [lineId,setLineId]=useState(''),[inventoryId,setInventoryId]=useState(''),[inventories,setInventories]=useState<OmsInventory[]>([]),[inventoryLoading,setInventoryLoading]=useState(false),[inventoryError,setInventoryError]=useState('');
  const [allocationQuantity,setAllocationQuantity]=useState(''),[allocationReason,setAllocationReason]=useState('');
  const [returnKind,setReturnKind]=useState<'return'|'exchange'>('return'),[returnLineId,setReturnLineId]=useState(''),[returnQuantity,setReturnQuantity]=useState(''),[returnReason,setReturnReason]=useState(''),[replacement,setReplacement]=useState('');
  const [digitalStatus,setDigitalStatus]=useState<DigitalFulfilmentRecord['status']|''>(''),[digitalMode,setDigitalMode]=useState<DigitalFulfilmentRecord['mode']|''>(''),[digitalNote,setDigitalNote]=useState('');
  const [refundAmount,setRefundAmount]=useState(''),[refundReason,setRefundReason]=useState('');
  const [reservationObservation,setReservationObservation]=useState<ReservationObservation>({}),[reservationClock,setReservationClock]=useState(Date.now());
  const [cancellationReasons,setCancellationReasons]=useState<Record<string,string>>({});
  const [statusReasons,setStatusReasons]=useState<Record<string,string>>({}),[nextStatuses,setNextStatuses]=useState<Record<string,ConsignmentRecord['status']>>({}),[approvalReasons,setApprovalReasons]=useState<Record<string,string>>({});
  const data=document?.value||emptyOmsOperations(initialOrder.id);
  const clearPreview=()=>setPreview(undefined);
  const reload=useCallback(async()=>{
    setLoading(true);setError('');setPreview(undefined);setReservationObservation({});
    try{
      const [fresh,stored]=await Promise.all([api<OmsOrder>(`orders/${initialOrder.id}?expand=lineItems[*].supplyChannel&expand=paymentInfo.payments[*]`),readOperation<OmsOperations>(api,OMS_CONTAINER,initialOrder.id)]);
      if(stored)validateOmsOperations(stored.value,initialOrder.id);
      if(fresh.id!==initialOrder.id)throw new Error('The returned order does not match the request.');
      setReservationObservation(await readOrderReservationCart(api,fresh as Order));setReservationClock(Date.now());
      setOrder(fresh);setDocument(stored);
      const raw=window.sessionStorage.getItem(storageKey);
      if(raw){
        const marker=JSON.parse(raw) as Marker;
        const collection=marker.collection==='allocations'||marker.collection==='returns'||marker.collection==='refunds'||marker.collection==='consignments'||marker.collection==='digitalFulfilment'?marker.collection:undefined;
        if(collection&&stored?.value[collection]?.some(item=>item.id===marker.id&&item.status===marker.status&&(!marker.approval||('approval' in item&&item.approval?.status===marker.approval)))){
          window.sessionStorage.removeItem(storageKey);setBlocked(false);setMessage('The previous operation was confirmed. No duplicate was submitted.');
        }else{setBlocked(true);setError('The previous save is unconfirmed. New writes are paused. Refresh to verify or contact your administrator; there is no automatic retry.');}
      }else setBlocked(false);
    }catch(e){setBlocked(true);setError(errorMessage(e));}finally{setLoading(false);}
  },[api,initialOrder.id,storageKey]);
  useEffect(()=>{void reload();},[reload,initialOrder.version]);
  useEffect(()=>{const timer=setInterval(()=>setReservationClock(Date.now()),15000);return ()=>clearInterval(timer);},[]);
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
  const options=physical.map(line=>({value:line.id,label:`${line.name} · ${line.sku||'Custom Physical Item'} · Recorded ${line.deliveredQuantity} / Unshipped ${line.remainingQuantity}`}));
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
      const [fresh,stored]=await Promise.all([api<OmsOrder>(`orders/${initialOrder.id}?expand=lineItems[*].supplyChannel&expand=paymentInfo.payments[*]`),readOperation<OmsOperations>(api,OMS_CONTAINER,initialOrder.id)]);
      const current=stored?validateOmsOperations(stored.value,initialOrder.id):emptyOmsOperations(initialOrder.id);
      if(chosen.actorId&&chosen.actorId!==operatorId)throw new Error('The Merchant Center operator changed. Refresh and review again.');
      if(fresh.id!==initialOrder.id||fresh.version!==chosen.orderVersion||(stored?.version||0)!==chosen.documentVersion)throw new Error('The order or operations record changed. Refresh and review again.');
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
        setMessage('Receipt recorded in native ReturnInfo. Stock, funds and replacement orders have not been changed.');
        await onReload?.();
      }else{
        let inventory=chosen.inventory;
        if(inventory){
          const live=await api<OmsInventory>(`inventory/${inventory.id}?expand=supplyChannel`);
          if(live.id!==inventory.id||live.version!==inventory.version)throw new Error('The inventory record changed. Refresh available entries and review again.');
          inventory=live;
        }
        await persist(chosen.build!(fresh,current,inventory),stored,chosen.marker);setOrder(fresh);
        setMessage(chosen.marker.collection==='digitalFulfilment'?'Digital fulfilment record saved with its operator and item snapshot. No email, gift card, payment or native shipment was executed.':chosen.marker.status==='cancelled'?'The request or plan was cancelled and retained for audit. Native returns, stock and payments are unchanged; capacity has been recalculated.':'Operation saved. Allocation plans do not reserve stock; return, exchange and refund requests await execution.');
        setAllocationQuantity('');setAllocationReason('');setReturnQuantity('');setReturnReason('');setReplacement('');setRefundAmount('');setRefundReason('');setDigitalStatus('');setDigitalMode('');setDigitalNote('');
        setCancellationReasons(previous=>{const next={...previous};delete next[chosen.marker.id];return next;});
      }
      setPreview(undefined);
    }catch(e){setPreview(undefined);setBlocked(true);setError(errorMessage(e)+' Refresh to verify; there is no automatic retry.');}
    finally{lock.current=false;setBusy(false);}
  }
  async function reconcile(id:string){
    if(disabled||lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');
    try{
      const [fresh,stored]=await Promise.all([api<OmsOrder>(`orders/${initialOrder.id}?expand=lineItems[*].supplyChannel&expand=paymentInfo.payments[*]`),readOperation<OmsOperations>(api,OMS_CONTAINER,initialOrder.id)]);
      if(!stored)throw new Error('The return receipt intent was not found.');
      const next=reconcileReturnReceipt(fresh,validateOmsOperations(stored.value,initialOrder.id),id);
      await persist(next,stored,{id,collection:'returns',status:'received'});setOrder(fresh);setMessage('Native receipt verified using its stable return key. No duplicate was created.');await onReload?.();
    }catch(e){setError(errorMessage(e));}finally{lock.current=false;setBusy(false);}
  }
  const groups=orderConsignments(order as Order),digitalRecord=currentDigitalFulfilment(order,data),reservationRows=orderReservationRows(order as Order,reservationObservation,reservationClock);
  const approvalActions=(collection:'returns'|'refunds',id:string,status:string,approval?:{status:string})=>status==='requested'&&(!approval||approval.status==='pending')?<Spacings.Stack scale="s"><TextField name={`approval-${id}`} title="Approval reason" value={approvalReasons[id]||''} isDisabled={disabled} onChange={event=>{setApprovalReasons(previous=>({...previous,[id]:event.target.value}));clearPreview();}}/><Spacings.Inline>{(['approved','rejected'] as const).map(decision=><SecondaryButton key={decision} label={decision==='approved'?'Review approval':'Review rejection'} isDisabled={disabled} onClick={()=>showPreview({marker:{id,collection,status:collection==='refunds'&&decision==='rejected'?'rejected':'requested',approval:decision},summary:`Record ${decision} decision for this request. This does not execute a refund, restock or create a replacement order.`,build:(fresh,current)=>reviewOmsRequest(fresh,current,collection,id,decision,approvalReasons[id]||'')})}/>)}</Spacings.Inline></Spacings.Stack>:null;
  return <Section title="OMS · Allocation, Returns & Refund Requests">
    <Notice error={error||domainError} message={message}/>
    <Spacings.Inline><SecondaryButton label="Refresh Operations / Verify Result" isDisabled={busy||loading} onClick={()=>void reload()}/>{loading&&<LoadingSpinner/>}</Spacings.Inline>
    <Text.Detail>Records persist in commercetools. Version conflicts require a new review. Stock reservation, restocking and payment refunds are not executed here.</Text.Detail>
    <Section title="Consignments">
      <Text.Detail>Groups use the order's saved Supply Channels. Progress below is operator-recorded; it does not send goods, confirm carrier delivery or change payment state.</Text.Detail>
      {!groups.length&&<Text.Body>No fulfilment groups are recorded on this order.</Text.Body>}
      {groups.map((group,index)=>{const stored=data.consignments?.find(item=>item.groupId===group.id);const status=stored?.status||'Pending';return <Spacings.Stack scale="m" key={group.id}>
        <Text.Subheadline as="h4">Consignment {index+1} · {group.warehouse}</Text.Subheadline>
        <Text.Body>Status: {group.digital?(digitalRecord?`${digitalRecord.status} (${digitalRecord.mode==='simulation'?'simulated record':'manually recorded'})`:'Digital fulfilment status not recorded'):stored?status:'Pending (no progress recorded)'}</Text.Body>
        <DataTable isCondensed rows={group.lines} columns={[{key:'name',label:'Product'},{key:'sku',label:'SKU'},{key:'quantity',label:'Quantity'}]} itemRenderer={(row,col)=>row[col.key as 'name'|'sku'|'quantity']}/>
        {stored&&<Text.Detail>Updated {stored.updatedAt} · {stored.reason}</Text.Detail>}
        {group.digital&&<>
          <ContentNotification type="info">Record an operator-reported or simulated digital fulfilment status. This does not send an email or gift card, call a delivery provider, or change payment or native shipment state. Completed is a recorded statement, not provider-confirmed delivery.</ContentNotification>
          {data.digitalFulfilment?.length&&!digitalRecord?<ContentNotification type="warning">The digital items differ from the latest recorded item snapshot. Review the current items before recording a new status.</ContentNotification>:null}
          {!operatorId&&<ContentNotification type="warning">Your Merchant Center operator identity is unavailable. Digital status recording is disabled.</ContentNotification>}
          <SelectField name="digital-status" title="Digital Status to Record" value={digitalStatus} options={(['Pending','Completed'] as const).filter(value=>value!==digitalRecord?.status).map(value=>({value,label:value}))} isDisabled={disabled||!operatorId||order.orderState==='Cancelled'} onChange={event=>{setDigitalStatus(String(event.target.value) as DigitalFulfilmentRecord['status']);clearPreview();}}/>
          <SelectField name="digital-mode" title="Recording Basis" value={digitalMode} options={[{value:'manual',label:'Operator report (not provider-verified)'},{value:'simulation',label:'Simulation / QA (no delivery)'}]} isDisabled={disabled||!operatorId||order.orderState==='Cancelled'} onChange={event=>{setDigitalMode(String(event.target.value) as DigitalFulfilmentRecord['mode']);clearPreview();}}/>
          <TextField name="digital-note" title="Digital Fulfilment Note" value={digitalNote} isDisabled={disabled||!operatorId||order.orderState==='Cancelled'} onChange={event=>{setDigitalNote(event.target.value);clearPreview();}}/>
          <SecondaryButton label="Review Digital Status Record" isDisabled={disabled||!operatorId||!digitalStatus||!digitalMode||!digitalNote.trim()||order.orderState==='Cancelled'} onClick={()=>{if(!operatorId||!digitalStatus||!digitalMode)return;const id=crypto.randomUUID(),input={id,status:digitalStatus,mode:digitalMode,operatorId,note:digitalNote};showPreview({actorId:operatorId,marker:{id,collection:'digitalFulfilment',status:digitalStatus},summary:`Record all ${group.lines.length} digital order items as ${digitalStatus}, basis ${digitalMode==='simulation'?'Simulation / QA':'Operator report'}, by Merchant Center user ${operatorId}. This records a statement only; no email, gift card, payment or native shipment is executed.`,build:(fresh,current)=>recordDigitalFulfilment(fresh,current,input)});}}/>
          {(data.digitalFulfilment||[]).map(entry=><Spacings.Stack key={entry.id} scale="xs"><Text.Body>{entry.status} · {entry.mode==='simulation'?'Simulation / QA — no delivery':'Operator report — not provider-verified'}</Text.Body><Text.Detail>Recorded at {entry.createdAt} · Merchant Center user {entry.recordedBy.userId} · Order version {entry.orderVersionObserved}</Text.Detail><Text.Detail>{entry.note}</Text.Detail><Text.Detail>Item snapshot: {entry.items.map(item=>`${item.lineItemId} × ${item.quantity}`).join('; ')} · Record {entry.id}</Text.Detail></Spacings.Stack>)}
        </>}
        {!group.digital&&<><SelectField name={`consignment-status-${group.id}`} title="Next Status" value={consignmentTransitions[status].includes(nextStatuses[group.id])?nextStatuses[group.id]:''} options={consignmentTransitions[status].map(value=>({value,label:value}))} isDisabled={disabled||status==='Delivered'} onChange={event=>{setNextStatuses(previous=>({...previous,[group.id]:String(event.target.value) as ConsignmentRecord['status']}));clearPreview();}}/>
        <TextField name={`consignment-reason-${group.id}`} title="Status Reason" value={statusReasons[group.id]||''} isDisabled={disabled||status==='Delivered'} onChange={event=>{setStatusReasons(previous=>({...previous,[group.id]:event.target.value}));clearPreview();}}/>
        <SecondaryButton label="Review Consignment Update" isDisabled={disabled||!consignmentTransitions[status].includes(nextStatuses[group.id])} onClick={()=>{const id=stored?.id||crypto.randomUUID(),nextStatus=nextStatuses[group.id];showPreview({marker:{id,collection:'consignments',status:nextStatus},summary:`Record ${group.warehouse} status as ${nextStatus}. No shipment or financial action is executed.`,build:(fresh,current)=>updateConsignment(fresh,current,{id,groupId:group.id,status:nextStatus,reason:statusReasons[group.id]||''},orderConsignments(fresh as Order).filter(row=>!row.digital).map(row=>row.id))});}}/></>}
      </Spacings.Stack>;})}
    </Section>
    <Section title="Inventory Allocation">
      <Text.Detail>Ordered quantities and allocation plans are separate from native reservations. Active Reserved Qty is read from this order's source Cart and verified against each item and Inventory Entry; it is never inferred from ordered quantities or inventory totals.</Text.Detail>
      <Text.Detail>Source Cart: {(order as Order).cart?.id||'Not recorded'} · Cart State: {reservationObservation.cart?.cartState||'Not recorded'} · Observed: {reservationObservation.observedAt||'Not recorded'}. Use Refresh Operations / Verify Result to read the latest state.</Text.Detail>
      {reservationObservation.error&&<ContentNotification type="warning">{reservationObservation.error}</ContentNotification>}
      <DataTable isCondensed rows={groups.filter(group=>!group.digital).map(group=>{const rows=reservationRows.filter(row=>group.lines.some(line=>line.id===row.id));return {id:group.id,warehouse:group.warehouse,assigned:group.lines.reduce((sum,line)=>sum+line.quantity,0),planned:data.allocations.filter(item=>item.status==='planned'&&(item.supplyChannelId||'unassigned')===group.id).reduce((sum,item)=>sum+item.quantity,0),reserved:loading?null:reservationTotal(rows,'active'),committed:loading?null:reservationTotal(rows,'committed')};})} columns={[{key:'warehouse',label:'Warehouse'},{key:'assigned',label:'Ordered Qty'},{key:'planned',label:'Planned Qty'},{key:'reserved',label:'Active Reserved Qty'},{key:'committed',label:'Committed Qty'}]} itemRenderer={(row,col)=>row[col.key as 'warehouse'|'assigned'|'planned'|'reserved'|'committed']??'Unknown'}/>
      <Text.Detail>Missing legacy reservations are Not recorded. A missing, inaccessible or mismatched reference remains Unknown in totals. Digital items and explicitly untracked items without a reservation are excluded. Committed means inventory was deducted for fulfilment, not still held. Expiry processing can take a few minutes; no released state is inferred from the clock. This is the current native record, not a complete reservation event history.</Text.Detail>
      {reservationRows.filter(row=>groups.some(group=>!group.digital&&group.lines.some(line=>line.id===row.id))).map(row=><Spacings.Stack scale="xs" key={row.id}>
        <Text.Body>{row.sku} · {row.warehouse} · {loading?'Reading native reservation…':row.state}</Text.Body>
        <Text.Detail>Order Item: {row.id} · Cart Item: {row.cartLineId||'Not recorded'} · Reservation: {row.reservationId||'Not recorded'}</Text.Detail>
        <Text.Detail>Native Quantity: {row.quantity??'Unknown'} · Active Reserved: {row.active??'Unknown'} · Committed: {row.committed??'Unknown'} · Expires At: {row.expiresAt||'Not recorded'}</Text.Detail>
        <Text.Detail>{row.detail}</Text.Detail>
      </Spacings.Stack>)}
    </Section>
    <Section title="Allocation Plans">
      <ContentNotification type="info">Plans do not change the original fulfilment warehouse. Tracked items remain bound to that warehouse. Stock may already have been deducted when an order was created; the saved inventory mode does not prove an active reservation. No order-specific reserved quantity is inferred. Review and cancel consumed plans after shipment.</ContentNotification>
      <SelectField name="allocation-line" title="Physical Order Item" value={lineId} options={options.filter(option=>order.lineItems?.some(line=>line.id===option.value))} isDisabled={disabled} onChange={event=>{setLineId(String(event.target.value));clearPreview();}}/>
      {context&&<Text.Detail>Original Warehouse: {context.supplyChannelId||'Unassigned'} · Inventory Mode: {context.inventoryMode}</Text.Detail>}
      <Notice error={inventoryError}/>
      {inventoryLoading?<LoadingSpinner/>:<SelectField name="allocation-inventory" title="Inventory Entry / Warehouse" value={inventoryId} options={inventories.map(row=>({value:row.id,label:`${warehouseName(row.supplyChannel)} · On-stock ${row.quantityOnStock} · Available ${row.availableQuantity}`}))} isDisabled={disabled||!inventories.length} onChange={event=>{setInventoryId(String(event.target.value));clearPreview();}}/>}
      {lineId&&!inventoryLoading&&!inventoryError&&!inventories.length&&<Text.Detail>No inventory entry exists for this SKU. This is not a zero-stock observation; no warehouse is inferred.</Text.Detail>}
      <TextField name="allocation-quantity" title="Planned Quantity" value={allocationQuantity} isDisabled={disabled} onChange={event=>{setAllocationQuantity(event.target.value);clearPreview();}}/>
      <TextField name="allocation-reason" title="Allocation Reason" value={allocationReason} isDisabled={disabled} onChange={event=>{setAllocationReason(event.target.value);clearPreview();}}/>
      <Spacings.Inline><PrimaryButton label="Review Allocation Plan" isDisabled={disabled||inventoryLoading||!inventoryId} onClick={()=>{
        const id=crypto.randomUUID(),inventory=inventories.find(row=>row.id===inventoryId),input={id,lineItemId:lineId,quantity:allocationQuantity,reason:allocationReason};
        if(!inventory)return;showPreview({marker:{id,collection:'allocations',status:'planned'},inventory,summary:`Save ${allocationQuantity} items in an allocation plan. No stock reservation, warehouse reassignment or shipment is performed.`,build:(fresh,current,live)=>createAllocation(fresh,current,live!,input)});
      }}/></Spacings.Inline>
      {data.allocations.map(item=><Spacings.Stack key={item.id} scale="s"><Text.Body>{item.sku} · {item.quantity} items · {groups.find(group=>group.id===(item.supplyChannelId||'unassigned'))?.warehouse||item.supplyChannelId||'Unassigned'} · {statuses[item.status]}</Text.Body><Text.Detail>{item.reason}</Text.Detail>{item.status==='planned'&&<Spacings.Inline><SecondaryButton label="Review Plan Cancellation" isDisabled={disabled} onClick={()=>showPreview({marker:{id:item.id,collection:'allocations',status:'cancelled'},summary:'Cancel only this allocation plan. Stock and existing Deliveries remain unchanged.',build:(_fresh,current)=>cancelAllocation(current,item.id)})}/></Spacings.Inline>}</Spacings.Stack>)}
    </Section>
    <Section title="Return / Exchange Requests & Receipts">
      <Text.Body>Return capacity is recorded shipments less native returns and pending requests. Exchanges store a requested replacement SKU; availability and replacement orders require separate processing. Confirm physical receipt before recording it.</Text.Body>
      <SelectField name="return-kind" title="Request Type" value={returnKind} options={[{value:'return',label:'Return'},{value:'exchange',label:'Exchange'}]} isDisabled={disabled} onChange={event=>{setReturnKind(event.target.value==='exchange'?'exchange':'return');clearPreview();}}/>
      <SelectField name="return-line" title="Returned Item / SKU" value={returnLineId} options={options} isDisabled={disabled} onChange={event=>{setReturnLineId(String(event.target.value));clearPreview();}}/>
      <Notice error={returnError}/>
      {returnRemaining!==undefined&&<Text.Detail>Remaining Return Capacity: {returnRemaining} items, after native returns and pending requests. Cancelling a pending request releases its capacity.</Text.Detail>}
      <TextField name="return-quantity" title="Requested Quantity" value={returnQuantity} isDisabled={disabled} onChange={event=>{setReturnQuantity(event.target.value);clearPreview();}}/>
      <TextField name="return-reason" title="Return / Exchange Reason" value={returnReason} isDisabled={disabled} onChange={event=>{setReturnReason(event.target.value);clearPreview();}}/>
      {returnKind==='exchange'&&<TextField name="replacement-sku" title="Requested Replacement SKU" value={replacement} isDisabled={disabled} onChange={event=>{setReplacement(event.target.value);clearPreview();}}/>}
      <Spacings.Inline><PrimaryButton label="Review Return / Exchange Request" isDisabled={disabled} onClick={()=>{
        const id=crypto.randomUUID(),input={id,kind:returnKind,lineItemId:returnLineId,quantity:returnQuantity,reason:returnReason,replacementSku:replacement};
        showPreview({marker:{id,collection:'returns',status:'requested'},summary:`Save ${returnQuantity} items ${returnKind==='exchange'?'Exchange':'Return'} request. Receipt, restocking and refund are not executed.`,build:(fresh,current)=>createReturnRequest(fresh,current,input)});
      }}/></Spacings.Inline>
      {data.returns.map(item=><Spacings.Stack key={item.id} scale="s"><Text.Body>{item.kind==='exchange'?'Exchange':'Return'} · {item.quantity} items · {physical.find(line=>line.id===item.lineItemId)?.name||item.lineItemId} · {statuses[item.status]}</Text.Body><Text.Detail>Returned SKU: {physical.find(line=>line.id===item.lineItemId)?.sku||'Not recorded'} · Approval Status: {item.approval?.status||'Not recorded'}</Text.Detail>{approvalActions('returns',item.id,item.status,item.approval)}<Text.Detail>{item.reason}{item.replacementSku?` · Requested Replacement SKU: ${item.replacementSku}(not executed)`:''}</Text.Detail>
        {item.status==='requested'&&<React.Fragment><Spacings.Inline><SecondaryButton label="Review Actual Return Receipt" isDisabled={disabled||item.approval?.status==='rejected'} onClick={()=>showPreview({marker:{id:item.id,collection:'returns',status:'receiving'},receiptId:item.id,summary:`Confirm actual receipt of ${item.quantity} items and record native Returned state. Stock, refunds and replacement orders are not changed.`})}/></Spacings.Inline>
          <TextField name={`return-cancel-${item.id}`} title="Return / Exchange Cancellation Reason" value={cancellationReasons[item.id]||''} isDisabled={disabled} onChange={event=>{setCancellationReasons(previous=>({...previous,[item.id]:event.target.value}));clearPreview();}}/>
          <Spacings.Inline><SecondaryButton label="Review Return Cancellation" isDisabled={disabled} onClick={()=>{const reason=cancellationReasons[item.id]||'';showPreview({marker:{id:item.id,collection:'returns',status:'cancelled'},summary:`Cancel ${item.quantity} items ${item.kind==='exchange'?'Exchange':'Return'} request and retain its history, releasing request capacity. Reason: ${reason}. Native returns, stock and payments are unchanged.`,build:(fresh,current)=>cancelReturnRequest(fresh,current,item.id,reason)});}}/></Spacings.Inline>
        </React.Fragment>}
        {item.status==='receiving'&&<Spacings.Inline><SecondaryButton label="Verify Receipt (no resubmission)" isDisabled={disabled} onClick={()=>void reconcile(item.id)}/></Spacings.Inline>}
        {item.status==='cancelled'&&<Text.Detail>Cancelled At: {item.cancelledAt||'Not recorded'} · Cancellation Reason: {item.cancellationReason||'Not recorded'}</Text.Detail>}
      </Spacings.Stack>)}
    </Section>
    <Section title="Refund Requests — Awaiting Payment Execution">
      <ContentNotification type="warning">This saves a request; it does not call a payment provider or mark funds refunded. The limit accounts for this workbench's requests only. Reconcile the payment provider balance before executing any refund.</ContentNotification>
      <Notice error={budgetError}/>
      {budget&&<Text.Detail>Order Total {formatOmsMoney(budget.total,budget.currencyCode,budget.fractionDigits)} · Remaining Request Limit {formatOmsMoney(budget.remaining,budget.currencyCode,budget.fractionDigits)}. Enter a major-unit amount, with up to {budget.fractionDigits} decimal places. The amount is stored in integer minor units.</Text.Detail>}
      <TextField name="refund-amount" title={`Requested Amount (${budget?.currencyCode||'Order Currency'} major units)`} value={refundAmount} isDisabled={disabled||!budget} onChange={event=>{setRefundAmount(event.target.value);clearPreview();}}/>
      <TextField name="refund-reason" title="Refund Reason" value={refundReason} isDisabled={disabled||!budget} onChange={event=>{setRefundReason(event.target.value);clearPreview();}}/>
      <Spacings.Inline><PrimaryButton label="Review Refund Request" isDisabled={disabled||!budget} onClick={()=>{
        if(!budget)return;try{const amount=parseOmsMajorAmount(refundAmount,budget.fractionDigits),id=crypto.randomUUID(),input={id,amount,currencyCode:budget.currencyCode,reason:refundReason};
          showPreview({marker:{id,collection:'refunds',status:'requested'},summary:`Save ${formatOmsMoney(amount,budget.currencyCode,budget.fractionDigits)} refund request (integer minor units: ${amount} ${budget.currencyCode}), pending execution. No financial transaction is performed.`,build:(fresh,current)=>createRefundRequest(fresh,current,input)});
        }catch(e){setPreview(undefined);setError(errorMessage(e));}
      }}/></Spacings.Inline>
      {data.refunds.map(item=><Spacings.Stack key={item.id} scale="s"><Text.Body>{budget?formatOmsMoney(item.amount,item.currencyCode,budget.fractionDigits):`${item.amount} ${item.currencyCode} minor units (currency precision unverified)`} · {statuses[item.status]} · {item.reason}</Text.Body>
        <Text.Detail>Integer Minor Units: {item.amount} {item.currencyCode}</Text.Detail><Text.Detail>Request Type: Refund · Approval Status: {item.approval?.status||'Not recorded'}</Text.Detail>{approvalActions('refunds',item.id,item.status,item.approval)}
        {item.status==='requested'&&<React.Fragment><TextField name={`refund-cancel-${item.id}`} title="Refund Cancellation Reason" value={cancellationReasons[item.id]||''} isDisabled={disabled} onChange={event=>{setCancellationReasons(previous=>({...previous,[item.id]:event.target.value}));clearPreview();}}/>
          <Spacings.Inline><SecondaryButton label="Review Refund Cancellation" isDisabled={disabled} onClick={()=>{const reason=cancellationReasons[item.id]||'';showPreview({marker:{id:item.id,collection:'refunds',status:'cancelled'},summary:`Cancel ${budget?formatOmsMoney(item.amount,item.currencyCode,budget.fractionDigits):`${item.amount} ${item.currencyCode} minor units`} refund request and retain its history, releasing its request allowance. Reason: ${reason}. Executed transactions are not reversed; no payment provider is called.`,build:(fresh,current)=>cancelRefundRequest(fresh,current,item.id,reason)});}}/></Spacings.Inline>
        </React.Fragment>}
        {item.status==='cancelled'&&<Text.Detail>Cancelled At: {item.cancelledAt||'Not recorded'} · Cancellation Reason: {item.cancellationReason||'Not recorded'}</Text.Detail>}
      </Spacings.Stack>)}
    </Section>
    {preview&&<Section title="Confirm Operation"><ContentNotification type="warning">{preview.summary}</ContentNotification><Text.Detail>Order Version {preview.orderVersion} · Operations Version {preview.documentVersion} · Request {preview.marker.id}</Text.Detail><Spacings.Inline><PrimaryButton label={busy?'Saving…':'Confirm Save'} isDisabled={disabled} onClick={()=>void save()}/><SecondaryButton label="Cancel Review" isDisabled={busy} onClick={clearPreview}/></Spacings.Inline></Section>}
  </Section>;
}
