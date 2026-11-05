import React, {useCallback,useEffect,useRef,useState} from 'react';
import LoadingSpinner from '@commercetools-uikit/loading-spinner';
import {ContentNotification} from '@commercetools-uikit/notifications';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import PrimaryButton from '@commercetools-uikit/primary-button';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import SelectField from '@commercetools-uikit/select-field';
import {useCommerceApi,localized,type Product} from './api';
import {productQuality,errorMessage} from './domain';
import {Notice,Section,NativeLink} from './shared';
import InventoryPanel from './inventory-panel';

export default function ProductPanel({id,variantId,nativeUrl,canManage,mode='all'}:{id:string;variantId?:number;nativeUrl:string;canManage:boolean;mode?:'all'|'pim'}) {
  const api=useCommerceApi();
  const [product,setProduct]=React.useState<Product>();
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [preview,setPreview]=useState(false),[confirmed,setConfirmed]=useState(false),[needsReload,setNeedsReload]=useState(false);
  const [selected,setSelected]=useState(variantId ? String(variantId) : '');
  const saving=useRef(false);
  const reload=useCallback(async()=>{
    setLoading(true);setError('');setPreview(false);setConfirmed(false);
    try {setProduct(await api<Product>(`products/${id}`));setNeedsReload(false);} catch(e){setError(errorMessage(e));}
    finally {setLoading(false);}
  },[api,id]);
  useEffect(()=>{void reload();},[reload]);
  const quality=product ? productQuality(product) : null;
  async function publish() {
    if(!canManage || saving.current || !product || !quality?.readyToPublish || !preview || !confirmed || needsReload)return;
    saving.current=true;setBusy(true);setError('');setMessage('');
    try {
      const result=await api<Product>(`products/${id}`,{version:product.version,actions:[{action:'publish'}]});
      setProduct(result);setPreview(false);setConfirmed(false);setMessage('已发布当前审核版本。原生页面刷新后可见最新内容。');
    } catch(e){setError(errorMessage(e));setNeedsReload(true);setPreview(false);}
    finally {saving.current=false;setBusy(false);}
  }
  if(loading&&!product)return <LoadingSpinner/>;
  if(!product || !quality)return <><Notice error={error}/><SecondaryButton label="重新读取商品" onClick={()=>void reload()}/></>;
  const staged=product.masterData.staged;
  const variants=[staged.masterVariant,...staged.variants];
  const current=variants.find(v=>String(v.id)===selected) || variants[0];
  const nativeProductUrl=new URL(nativeUrl);nativeProductUrl.pathname=nativeProductUrl.pathname.split('/').slice(0,4).join('/');nativeProductUrl.search='';
  return <Spacings.Stack scale="l">
    <Notice error={error} message={message}/>
    <Text.Subheadline as="h4">{localized(staged.name)}</Text.Subheadline>
    <Text.Detail>版本 {product.version} · {product.masterData.published?'已发布':'未发布'} · {product.masterData.hasStagedChanges?'存在待发布修改':'无待发布修改'}</Text.Detail>
    <Spacings.Inline><SecondaryButton label="刷新数据" isDisabled={busy||loading} onClick={()=>void reload()}/><NativeLink url={nativeProductUrl.href} label="打开原生商品编辑"/></Spacings.Inline>
    <Section title="PIM · 当前商品发布检查">
      <Text.Body>检查待发布版本的名称、描述、图片、SKU 和价格。范围是当前商品，不替代完整的企业 PIM 审核流程。</Text.Body>
      {quality.issues.length ? quality.issues.map((issue,i)=><ContentNotification key={issue.code+i} type={issue.severity}>{issue.message}</ContentNotification>) : <ContentNotification type="success">当前检查项均通过。</ContentNotification>}
      <Text.Subheadline as="h4">已发布 / 待发布差异（{quality.diffs.length}）</Text.Subheadline>
      {quality.diffs.length ? quality.diffs.map(diff=><details key={diff.field}><summary>{diff.field}</summary><Text.Detail>已发布</Text.Detail><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{diff.current}</pre><Text.Detail>待发布</Text.Detail><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{diff.staged}</pre></details>) : <Text.Body>没有检测到内容差异。</Text.Body>}
      {!preview ? <PrimaryButton label="检查并预览发布" isDisabled={!canManage||busy||loading||needsReload||!quality.readyToPublish||(!product.masterData.hasStagedChanges&&product.masterData.published)} onClick={()=>{setPreview(true);setConfirmed(false);}}/> : <Spacings.Stack scale="m">
        <ContentNotification type="warning">将发布版本 {product.version} 的全部待发布内容，包括上面列出的 {quality.diffs.length} 项差异。此操作会影响店面的商品展示。</ContentNotification>
        <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> 我已审核全部差异及提醒，并确认发布。</label>
        <Spacings.Inline><PrimaryButton label={busy?'正在发布…':'确认发布到 commercetools'} isDisabled={!canManage||busy||!confirmed} onClick={()=>void publish()}/><SecondaryButton label="取消" isDisabled={busy} onClick={()=>setPreview(false)}/></Spacings.Inline>
      </Spacings.Stack>}
    </Section>
    {mode==='all'&&<Section title="WMS · SKU 分仓库存">
      <Text.Body>查看 Supply Channel 库存并更正在库量。仓库收货、库位、批次和拣货作业仍由实际 WMS 负责。</Text.Body>
      <SelectField title="当前变体" name="variant" value={String(current?.id || '')} options={variants.map(v=>({value:String(v.id),label:v.sku || `Variant ${v.id} · 无 SKU`}))} onChange={event=>setSelected(typeof event.target.value==='string'?event.target.value:'')}/>
      {current?.sku ? <InventoryPanel key={current.sku} sku={current.sku} canManage={canManage}/> : <ContentNotification type="warning">当前变体没有 SKU，无法查询库存。</ContentNotification>}
    </Section>}
  </Spacings.Stack>;
}
