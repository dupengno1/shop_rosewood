import React, {useCallback,useEffect,useRef,useState} from 'react';
import LoadingSpinner from '@commercetools-uikit/loading-spinner';
import DataTable from '@commercetools-uikit/data-table';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import TextField from '@commercetools-uikit/text-field';
import TextInput from '@commercetools-uikit/text-input';
import PrimaryButton from '@commercetools-uikit/primary-button';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import {ContentNotification} from '@commercetools-uikit/notifications';
import {useCommerceApi,type Order} from './api';
import {fulfillmentLines,buildDeliveryAction,errorMessage,orderDeliveries,type FulfillmentLine} from './domain';
import {Notice,Section,NativeLink} from './shared';
import {createDeliveryAttempt} from './delivery-attempt';
import OrderOperations from './oms-workflows';
import {OrderInformation} from './oms-presentation';

export default function OrderPanel({id,nativeUrl,canManage}:{id:string;nativeUrl:string;canManage:boolean}) {
  const api=useCommerceApi();
  const [order,setOrder]=React.useState<Order>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState('');
  const [quantities,setQuantities]=useState<Record<string,string>>({}),[tracking,setTracking]=useState(''),[carrier,setCarrier]=useState('');
  const [preview,setPreview]=useState<ReturnType<typeof buildDeliveryAction>>();
  const [needsReload,setNeedsReload]=useState(false);
  const [workflowsBusy,setWorkflowsBusy]=useState(false);
  const [attempt]=useState(()=>createDeliveryAttempt(window.sessionStorage,new URL(nativeUrl).pathname.split('/')[1],id));
  const saving=useRef(false);
  const clear=useCallback(()=>{setQuantities({});setTracking('');setCarrier('');setPreview(undefined);attempt.complete();},[attempt]);
  const reload=useCallback(async()=>{
    setLoading(true);setError('');setQuantities({});setPreview(undefined);
    try {
      const result=await api<Order>(`orders/${id}?expand=lineItems[*].supplyChannel&expand=paymentInfo.payments[*]`);setOrder(result);setNeedsReload(false);
      if(attempt.pending && orderDeliveries(result).some(delivery=>delivery.key===attempt.key)) {
        clear();setMessage('The previous delivery is confirmed in the native order. No duplicate was created.');
      }
    }catch(e){setError(errorMessage(e));}finally{setLoading(false);}
  },[api,id,clear,attempt]);
  useEffect(()=>{void reload();},[reload]);
  function review() {
    if(!canManage||!order||needsReload||loading||busy||workflowsBusy)return;
    try {setPreview(buildDeliveryAction(order,quantities,tracking,carrier,attempt.key));setError('');setMessage('');}
    catch(e){setPreview(undefined);setError(errorMessage(e));}
  }
  async function save() {
    if(!canManage||!order||!preview||saving.current||needsReload||loading||workflowsBusy)return;
    saving.current=true;setBusy(true);setError('');setMessage('');
    try {
      // Revalidate the review against the exact resource version being submitted.
      const action=buildDeliveryAction(order,quantities,tracking,carrier,attempt.key);
      attempt.begin();
      const result=await api<Order>(`orders/${id}?expand=lineItems[*].supplyChannel&expand=paymentInfo.payments[*]`,{version:order.version,actions:[action]});
      setOrder(result);clear();setMessage('Delivery and Parcel saved to the native order. This records shipment details; it does not purchase a label or confirm carrier delivery.');
    }catch(e){
      setNeedsReload(true);setPreview(undefined);
      setError(errorMessage(e)+' Refresh to verify the result before reviewing again. The request will not be retried automatically.');
    }finally{saving.current=false;setBusy(false);}
  }
  if(loading&&!order)return <LoadingSpinner/>;
  if(!order)return <><Notice error={error}/><SecondaryButton label="Reload Order" onClick={()=>void reload()}/></>;
  let lines:FulfillmentLine[]=[];let lineError='';
  try{lines=fulfillmentLines(order);}catch(e){lineError=errorMessage(e);}
  const physicalLines=lines.filter(line=>line.classification.type==='physical');
  const cannotDispatch=Boolean(workflowsBusy||lineError||needsReload||order.orderState==='Cancelled'||order.shippingMode==='Multiple'||!order.shippingInfo||lines.some(line=>line.overDelivered)||!physicalLines.some(line=>line.remainingQuantity>0));
  const deliveries=orderDeliveries(order);
  return <Spacings.Stack scale="l">
    <Notice error={error||lineError} message={message}/>
    <Text.Subheadline as="h4">Order {order.orderNumber || order.id}</Text.Subheadline>
    <Text.Detail>Version {order.version} · {order.orderState} · {order.shippingMode || 'Single'} shipping</Text.Detail>
    <Spacings.Inline><SecondaryButton label="Refresh Order / Verify Result" isDisabled={busy||loading||workflowsBusy} onClick={()=>void reload()}/><NativeLink url={nativeUrl} label="Open Native Order"/></Spacings.Inline>
    <OrderInformation order={order}/>
    <OrderOperations key={order.id} order={order} canManage={canManage&&!busy&&!loading} onReload={reload} onBusyChange={setWorkflowsBusy}/>
    <Section title={`OMS · Physical Items（${physicalLines.length}）`}>
      <Text.Body>Only confirmed physical items can be dispatched. Recorded quantities come from native Deliveries, not carrier delivery confirmation. Do not exceed the remaining quantity.</Text.Body>
      {order.shippingMode==='Multiple'&&<ContentNotification type="info">This panel summarizes multiple shipping. Use the native order to create a delivery for a specific shipping key.</ContentNotification>}
      {!order.shippingInfo&&order.shippingMode!=='Multiple'&&<ContentNotification type="warning">The order has no shipping information. Configure it in the native order first.</ContentNotification>}
      {order.orderState==='Cancelled'&&<ContentNotification type="warning">The order is cancelled; new deliveries are not allowed.</ContentNotification>}
      {lines.some(line=>line.overDelivered)&&<ContentNotification type="error">Recorded deliveries exceed the ordered quantity. Review the native order first.</ContentNotification>}
      {physicalLines.length?<DataTable<FulfillmentLine> isCondensed rows={physicalLines} columns={[{key:'name',label:'Product / SKU'},{key:'quantity',label:'Ordered'},{key:'deliveredQuantity',label:'Recorded'},{key:'remainingQuantity',label:'Remaining'},{key:'new',label:'Dispatch Quantity'}]} itemRenderer={(line,column)=>{
        if(column.key==='name')return <span>{line.name}<br/><small>{line.sku || (line.kind==='customLineItem'?'Custom Physical Item':'No SKU')}</small><br/><small>{line.classification.reason}</small></span>;
        if(column.key==='new')return <TextInput name={line.id} value={quantities[line.id] || ''} isDisabled={!canManage||busy||cannotDispatch||line.remainingQuantity===0} onChange={event=>{setQuantities(previous=>({...previous,[line.id]:event.target.value}));setPreview(undefined);}}/>;
        return line[column.key as 'quantity'|'deliveredQuantity'|'remainingQuantity'];
      }}/>:<ContentNotification type="info">There are no confirmed physical items to dispatch.</ContentNotification>}
    </Section>
    {([
      {type:'unknown',title:'Fulfilment Type Required',description:'These items have no valid fulfilment classification. Correct the native order item and refresh before dispatching.'},
      {type:'digital',title:'Digital Items',description:'These items do not require physical shipping. This panel does not send gift cards or execute digital delivery.'},
      {type:'service',title:'Services / Donations',description:'These items do not require physical shipping. Follow the relevant service process.'},
      {type:'fee',title:'Tax / Duties / Packaging Fees',description:'These fee lines are excluded from physical shipment quantities.'},
    ] as const).map(group=>{
      const rows=lines.filter(line=>line.classification.type===group.type);
      if(!rows.length)return null;
      return <Section key={group.type} title={`${group.title}（${rows.length}）`}>
        <ContentNotification type={group.type==='unknown'?'warning':'info'}>{group.description}</ContentNotification>
        <DataTable<FulfillmentLine> isCondensed rows={rows} columns={[{key:'name',label:'Order Item'},{key:'quantity',label:'Ordered Quantity'},{key:'reason',label:'Classification Source'}]} itemRenderer={(line,column)=>{
          if(column.key==='name')return <span>{line.name}{line.sku&&<><br/><small>{line.sku}</small></>}{line.deliveredQuantity>0&&<><br/><small>Existing {line.deliveredQuantity} previously recorded deliveries. Review their classification and processing history.</small></>}</span>;
          if(column.key==='reason')return line.classification.reason;
          return line.quantity;
        }}/>
      </Section>;
    })}
    {lines.some(line=>line.instructions.length>0)&&<Section title="Fulfilment Instructions">
      <Text.Body>Instructions are read from native order items. Missing personalization, packaging or collection information is not inferred.</Text.Body>
      {lines.filter(line=>line.instructions.length>0).map(line=><details key={line.id}><summary>{line.name}{line.sku?` · ${line.sku}`:''}</summary>
        {line.instructions.map(instruction=><Text.Body key={instruction.label}>{instruction.label}：{instruction.value}</Text.Body>)}
      </details>)}
    </Section>}
    {physicalLines.length>0&&<Section title="Record Physical Shipment">
      <TextField title="Carrier" name="carrier" value={carrier} isDisabled={!canManage||busy||cannotDispatch} onChange={event=>{setCarrier(event.target.value);setPreview(undefined);}}/>
      <TextField title="Tracking Number" name="tracking" value={tracking} isDisabled={!canManage||busy||cannotDispatch} onChange={event=>{setTracking(event.target.value);setPreview(undefined);}}/>
      {!preview?<PrimaryButton label="Review Shipment" isDisabled={!canManage||busy||loading||cannotDispatch} onClick={review}/>:<Spacings.Stack scale="m">
        <ContentNotification type="warning">Using order version {order.version} create one Delivery / Parcel for {preview.items.reduce((total,item)=>total+item.quantity,0)} items, carrier {carrier}, tracking number {tracking}. Payment, refund and overall shipment states remain unchanged.</ContentNotification>
        <Text.Detail>Request ID: {preview.deliveryKey}</Text.Detail>
        <Spacings.Inline><PrimaryButton label={busy?'Saving…':'Confirm Shipment'} isDisabled={!canManage||busy||cannotDispatch} onClick={()=>void save()}/><SecondaryButton label="Cancel Review" isDisabled={busy} onClick={()=>setPreview(undefined)}/></Spacings.Inline>
      </Spacings.Stack>}
    </Section>}
    <Section title={`Recorded Deliveries（${deliveries.length}）`}>
      {!deliveries.length&&<Text.Body>There are no deliveries on this order.</Text.Body>}
      {deliveries.map((delivery,index)=><details key={delivery.id || index}><summary>Delivery {delivery.key || delivery.id} · {(delivery.items || []).reduce((count,item)=>count+item.quantity,0)} items</summary>
        {(delivery.parcels || []).map((parcel,pindex)=>{
          const data=parcel.trackingData as {carrier?:string;trackingId?:string}|undefined;
          return <Text.Body key={String(parcel.id || pindex)}>{data?.carrier || 'No carrier'} · {data?.trackingId || 'No tracking number'}</Text.Body>;
        })}
      </details>)}
    </Section>

  </Spacings.Stack>;
}
