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
import {ProductOperationsDetail} from './product-operations';

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
      setProduct(result);setPreview(false);setConfirmed(false);setMessage('The reviewed version has been published. Refresh the native page to see it.');
    } catch(e){setError(errorMessage(e));setNeedsReload(true);setPreview(false);}
    finally {saving.current=false;setBusy(false);}
  }
  if(loading&&!product)return <LoadingSpinner/>;
  if(!product || !quality)return <><Notice error={error}/><SecondaryButton label="Reload Product" onClick={()=>void reload()}/></>;
  const staged=product.masterData.staged;
  const variants=[staged.masterVariant,...staged.variants];
  const current=variants.find(v=>String(v.id)===selected) || variants[0];
  const nativeProductUrl=new URL(nativeUrl);nativeProductUrl.pathname=nativeProductUrl.pathname.split('/').slice(0,4).join('/');nativeProductUrl.search='';
  return <Spacings.Stack scale="l">
    <Notice error={error} message={message}/>
    <Text.Subheadline as="h4">{localized(staged.name)}</Text.Subheadline>
    <Text.Detail>Version {product.version} · {product.masterData.published?'Published':'Unpublished'} · {product.masterData.hasStagedChanges?'Staged Changes':'No Staged Changes'}</Text.Detail>
    <Spacings.Inline><SecondaryButton label="Refresh Data" isDisabled={busy||loading} onClick={()=>void reload()}/><NativeLink url={nativeProductUrl.href} label="Open Native Product"/></Spacings.Inline>
    <ProductOperationsDetail product={product}/>
    <Section title="Product Quality & Publishing">
      <Text.Body>Review staged names, descriptions, images, SKUs and prices for this product before publishing.</Text.Body>
      {quality.issues.length ? quality.issues.map((issue,i)=><ContentNotification key={issue.code+i} type={issue.severity}>{issue.message}</ContentNotification>) : <ContentNotification type="success">All current checks passed.</ContentNotification>}
      <Text.Subheadline as="h4">Published / Staged Differences（{quality.diffs.length}）</Text.Subheadline>
      {quality.diffs.length ? quality.diffs.map(diff=><details key={diff.field}><summary>{diff.field}</summary><Text.Detail>Published</Text.Detail><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{diff.current}</pre><Text.Detail>Staged</Text.Detail><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{diff.staged}</pre></details>) : <Text.Body>No content differences detected.</Text.Body>}
      {!preview ? <PrimaryButton label="Review Publication" isDisabled={!canManage||busy||loading||needsReload||!quality.readyToPublish||(!product.masterData.hasStagedChanges&&product.masterData.published)} onClick={()=>{setPreview(true);setConfirmed(false);}}/> : <Spacings.Stack scale="m">
        <ContentNotification type="warning">Publish version {product.version} with all staged changes, including the {quality.diffs.length} differences above. This affects storefront product content.</ContentNotification>
        <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> I have reviewed all changes and warnings and confirm publication.</label>
        <Spacings.Inline><PrimaryButton label={busy?'Publishing…':'Confirm Publication'} isDisabled={!canManage||busy||!confirmed} onClick={()=>void publish()}/><SecondaryButton label="Cancel" isDisabled={busy} onClick={()=>setPreview(false)}/></Spacings.Inline>
      </Spacings.Stack>}
    </Section>
    {mode==='all'&&<Section title="WMS · SKU Warehouse Inventory">
      <Text.Body>View Supply Channel inventory and correct on-stock quantities. Receiving, bins, batches and picking remain warehouse operations.</Text.Body>
      <SelectField title="Current Variant" name="variant" value={String(current?.id || '')} options={variants.map(v=>({value:String(v.id),label:v.sku || `Variant ${v.id} · No SKU`}))} onChange={event=>setSelected(typeof event.target.value==='string'?event.target.value:'')}/>
      {current?.sku ? <InventoryPanel key={current.sku} sku={current.sku} canManage={canManage}/> : <ContentNotification type="warning">This variant has no SKU; inventory cannot be queried.</ContentNotification>}
    </Section>}
  </Spacings.Stack>;
}
