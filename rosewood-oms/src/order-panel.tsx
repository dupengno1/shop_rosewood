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
      const result=await api<Order>(`orders/${id}`);setOrder(result);setNeedsReload(false);
      if(attempt.pending && orderDeliveries(result).some(delivery=>delivery.key===attempt.key)) {
        clear();setMessage('已在原生订单中确认上次发运记录。没有重复创建。');
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
      const result=await api<Order>(`orders/${id}`,{version:order.version,actions:[action]});
      setOrder(result);clear();setMessage('Delivery 和 Parcel 已保存到原生订单。此操作登记发运信息，不会购买面单或自动更新承运商签收状态。');
    }catch(e){
      setNeedsReload(true);setPreview(undefined);
      setError(errorMessage(e)+' 请先刷新核对结果，再重新预览。系统不会自动重发。');
    }finally{saving.current=false;setBusy(false);}
  }
  if(loading&&!order)return <LoadingSpinner/>;
  if(!order)return <><Notice error={error}/><SecondaryButton label="重新读取订单" onClick={()=>void reload()}/></>;
  let lines:FulfillmentLine[]=[];let lineError='';
  try{lines=fulfillmentLines(order);}catch(e){lineError=errorMessage(e);}
  const physicalLines=lines.filter(line=>line.classification.type==='physical');
  const cannotDispatch=Boolean(workflowsBusy||lineError||needsReload||order.orderState==='Cancelled'||order.shippingMode==='Multiple'||!order.shippingInfo||lines.some(line=>line.overDelivered)||!physicalLines.some(line=>line.remainingQuantity>0));
  const deliveries=orderDeliveries(order);
  return <Spacings.Stack scale="l">
    <Notice error={error||lineError} message={message}/>
    <Text.Subheadline as="h4">订单 {order.orderNumber || order.id}</Text.Subheadline>
    <Text.Detail>版本 {order.version} · {order.orderState} · {order.shippingMode || 'Single'} shipping</Text.Detail>
    <Spacings.Inline><SecondaryButton label="刷新订单 / 核对上次结果" isDisabled={busy||loading||workflowsBusy} onClick={()=>void reload()}/><NativeLink url={nativeUrl} label="打开原生订单"/></Spacings.Inline>
    <Section title={`OMS · 已确认实物（${physicalLines.length}）`}>
      <Text.Body>仅已明确分类的实物可登记发运。已登记量来自原生 Delivery，不代表承运商已签收；本次登记不能超过该实物行剩余数量。</Text.Body>
      {order.shippingMode==='Multiple'&&<ContentNotification type="info">本面板展示 Multiple shipping 汇总；新增发运请在原生订单中选定 shipping key 后操作。</ContentNotification>}
      {!order.shippingInfo&&order.shippingMode!=='Multiple'&&<ContentNotification type="warning">订单尚无 ShippingInfo。请先在原生订单中设置配送信息。</ContentNotification>}
      {order.orderState==='Cancelled'&&<ContentNotification type="warning">订单已取消，不能新增发运。</ContentNotification>}
      {lines.some(line=>line.overDelivered)&&<ContentNotification type="error">现有 Delivery 数量超过订单数量，请先在原生订单中核对。</ContentNotification>}
      {physicalLines.length?<DataTable<FulfillmentLine> isCondensed rows={physicalLines} columns={[{key:'name',label:'商品 / SKU'},{key:'quantity',label:'订购'},{key:'deliveredQuantity',label:'已登记'},{key:'remainingQuantity',label:'剩余'},{key:'new',label:'本次登记'}]} itemRenderer={(line,column)=>{
        if(column.key==='name')return <span>{line.name}<br/><small>{line.sku || (line.kind==='customLineItem'?'自定义实物行':'无 SKU')}</small><br/><small>{line.classification.reason}</small></span>;
        if(column.key==='new')return <TextInput name={line.id} value={quantities[line.id] || ''} isDisabled={!canManage||busy||cannotDispatch||line.remainingQuantity===0} onChange={event=>{setQuantities(previous=>({...previous,[line.id]:event.target.value}));setPreview(undefined);}}/>;
        return line[column.key as 'quantity'|'deliveredQuantity'|'remainingQuantity'];
      }}/>:<ContentNotification type="info">此订单目前没有可确认的实物行，不能创建实物发运。</ContentNotification>}
    </Section>
    {([
      {type:'unknown',title:'需确认履约类型',description:'这些行尚无有效的履约类型，不能登记实物发运。请在原生订单行补齐或修正履约类型后刷新。'},
      {type:'digital',title:'数字商品',description:'这些行不进入实物发运。本面板不会发送电子礼卡或完成数字交付。'},
      {type:'service',title:'服务 / 捐款',description:'这些行不进入实物发运。请按实际服务流程处理。'},
      {type:'fee',title:'税费 / 关税 / 包装费用',description:'这些金额行不代表待寄送的商品，不计入实物剩余数量。'},
    ] as const).map(group=>{
      const rows=lines.filter(line=>line.classification.type===group.type);
      if(!rows.length)return null;
      return <Section key={group.type} title={`${group.title}（${rows.length}）`}>
        <ContentNotification type={group.type==='unknown'?'warning':'info'}>{group.description}</ContentNotification>
        <DataTable<FulfillmentLine> isCondensed rows={rows} columns={[{key:'name',label:'订单行'},{key:'quantity',label:'订购数量'},{key:'reason',label:'分类依据'}]} itemRenderer={(line,column)=>{
          if(column.key==='name')return <span>{line.name}{line.sku&&<><br/><small>{line.sku}</small></>}{line.deliveredQuantity>0&&<><br/><small>已有 {line.deliveredQuantity} 件历史 Delivery 记录，请核对分类与历史处理。</small></>}</span>;
          if(column.key==='reason')return line.classification.reason;
          return line.quantity;
        }}/>
      </Section>;
    })}
    {lines.some(line=>line.instructions.length>0)&&<Section title="已保存的履约说明">
      <Text.Body>以下内容来自原生订单行。没有保存到订单的定制、包装或领取信息不会自动补全。</Text.Body>
      {lines.filter(line=>line.instructions.length>0).map(line=><details key={line.id}><summary>{line.name}{line.sku?` · ${line.sku}`:''}</summary>
        {line.instructions.map(instruction=><Text.Body key={instruction.label}>{instruction.label}：{instruction.value}</Text.Body>)}
      </details>)}
    </Section>}
    {physicalLines.length>0&&<Section title="新增实物发运 · Delivery + Parcel">
      <TextField title="承运商" name="carrier" value={carrier} isDisabled={!canManage||busy||cannotDispatch} onChange={event=>{setCarrier(event.target.value);setPreview(undefined);}}/>
      <TextField title="物流单号" name="tracking" value={tracking} isDisabled={!canManage||busy||cannotDispatch} onChange={event=>{setTracking(event.target.value);setPreview(undefined);}}/>
      {!preview?<PrimaryButton label="预览本次发运" isDisabled={!canManage||busy||loading||cannotDispatch} onClick={review}/>:<Spacings.Stack scale="m">
        <ContentNotification type="warning">将以订单版本 {order.version} 创建 1 个 Delivery / 1 个 Parcel，合计 {preview.items.reduce((total,item)=>total+item.quantity,0)} 件，承运商 {carrier}，物流单号 {tracking}。不会更改付款、退款或整单发运状态。</ContentNotification>
        <Text.Detail>请求标识：{preview.deliveryKey}</Text.Detail>
        <Spacings.Inline><PrimaryButton label={busy?'正在保存…':'确认登记原生发运'} isDisabled={!canManage||busy||cannotDispatch} onClick={()=>void save()}/><SecondaryButton label="取消预览" isDisabled={busy} onClick={()=>setPreview(undefined)}/></Spacings.Inline>
      </Spacings.Stack>}
    </Section>}
    <Section title={`现有物流记录（${deliveries.length}）`}>
      {!deliveries.length&&<Text.Body>当前订单没有 Delivery 记录。</Text.Body>}
      {deliveries.map((delivery,index)=><details key={delivery.id || index}><summary>Delivery {delivery.key || delivery.id} · {(delivery.items || []).reduce((count,item)=>count+item.quantity,0)} 件</summary>
        {(delivery.parcels || []).map((parcel,pindex)=>{
          const data=parcel.trackingData as {carrier?:string;trackingId?:string}|undefined;
          return <Text.Body key={String(parcel.id || pindex)}>{data?.carrier || '未指定承运商'} · {data?.trackingId || '无物流单号'}</Text.Body>;
        })}
      </details>)}
    </Section>
    <OrderOperations key={order.id} order={order} canManage={canManage&&!busy&&!loading} onReload={reload} onBusyChange={setWorkflowsBusy}/>
  </Spacings.Stack>;
}
