import React,{useEffect,useRef,useState} from 'react';
import DataTable from '@commercetools-uikit/data-table';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import TextField from '@commercetools-uikit/text-field';
import SelectField from '@commercetools-uikit/select-field';
import PrimaryButton from '@commercetools-uikit/primary-button';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import {ContentNotification} from '@commercetools-uikit/notifications';
import {useCommerceApi,type Product} from './api';
import {errorMessage} from './domain';
import {Notice,Section,NativeLink} from './shared';
import {planPriceChange,productPriceRows} from './price-management';

export default function PricePanel({product,canManage,nativeUrl,disabled=false,onChanged,onBusyChange}:{product:Product;canManage:boolean;nativeUrl:string;disabled?:boolean;onChanged:(product:Product)=>void;onBusyChange:(busy:boolean)=>void}){
 const api=useCommerceApi(),[currency,setCurrency]=useState('all'),[selected,setSelected]=useState(''),[amount,setAmount]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState(''),[preview,setPreview]=useState<ReturnType<typeof planPriceChange>>(),[busy,setBusy]=useState(false),[needsReload,setNeedsReload]=useState(false),saving=useRef(false);
 useEffect(()=>{setSelected('');setAmount('');setPreview(undefined);setNeedsReload(false);},[product.id,product.version]);
 const rows=productPriceRows(product),chosen=rows.find(row=>row.id===selected),standalone=product.priceMode==='Standalone';
 async function reload(){setBusy(true);onBusyChange(true);setError('');try{const fresh=await api<Product>(`products/${product.id}`);onChanged(fresh);setNeedsReload(false);setPreview(undefined);setMessage('Price data refreshed. Review the current staged amount before another change.');}catch(e){setError(errorMessage(e));}finally{setBusy(false);onBusyChange(false);}}
 function review(){setError('');setMessage('');try{if(!canManage||disabled||needsReload||!chosen?.price.id)return;setPreview(planPriceChange(product,chosen.variantId,chosen.price.id,amount));}catch(e){setError(errorMessage(e));}}
 async function save(){
  if(!canManage||disabled||saving.current||needsReload||!preview)return;
  saving.current=true;setBusy(true);onBusyChange(true);setError('');setMessage('');
  try{
   const fresh=await api<Product>(`products/${product.id}`);
   if(fresh.version!==preview.version||fresh.id!==preview.productId)throw Error('This product changed after your review. Refresh and review again.');
   const verified=planPriceChange(fresh,preview.row.variantId,preview.row.price.id!,amount);
   if(JSON.stringify(verified.payload)!==JSON.stringify(preview.payload))throw Error('This price changed after your review. Refresh and review again.');
   const result=await api<Product>(`products/${product.id}`,verified.payload);
   if(result.id!==product.id||result.version<=preview.version)throw Error('The save response could not be verified. Refresh to check the result.');
   const saved=productPriceRows(result).find(row=>row.variantId===preview.row.variantId&&row.price.id===preview.row.price.id);
   if(saved?.amount!==preview.newAmount||saved.currency!==preview.row.currency)throw Error('The saved amount could not be verified. Refresh to check the result.');
   onChanged(result);setPreview(undefined);setSelected('');setMessage('Price saved to staged product data. Review all product changes before publishing.');
  }catch(e){setError(errorMessage(e));setNeedsReload(true);setPreview(undefined);}
  finally{saving.current=false;setBusy(false);onBusyChange(false);}
 }
 return <Section title="Price Management">
  <Text.Body>Prices belong to the shared Project product. Review currency, country, distribution channel, customer group and validity before changing an amount.</Text.Body>
  <NativeLink label={standalone?'Open native Standalone Prices':'Open native product pricing'} url={nativeUrl}/>
  <Notice error={error} message={message}/>
  {standalone?<ContentNotification type="info">This product uses Standalone Prices. Review and manage its SKU prices in the native price area; embedded prices below are not the selling price source.</ContentNotification>:<Text.Detail>Editing here saves staged prices only. Adding or removing scopes, tiered, discounted, custom and high-precision prices uses native pricing.</Text.Detail>}
  {!canManage&&<Text.Detail>Read-only access. Product Manage permission is required to save a price.</Text.Detail>}
  <Spacings.Inline><SelectField title="Currency" name="price-currency" value={currency} options={[{value:'all',label:'All currencies'},...[...new Set(rows.map(row=>row.currency))].map(value=>({value,label:value}))]} onChange={event=>setCurrency(String(event.target.value))}/><SecondaryButton label="Refresh prices / Verify result" isDisabled={busy||disabled} onClick={()=>void reload()}/></Spacings.Inline>
  {rows.length?<div style={{overflowX:'auto'}}><DataTable isCondensed rows={rows.filter(row=>currency==='all'||row.currency===currency)} columns={[{key:'sku',label:'SKU'},{key:'amount',label:'Staged amount'},{key:'currency',label:'Currency'},{key:'country',label:'Country'},{key:'channel',label:'Distribution channel'},{key:'group',label:'Customer group'},{key:'validity',label:'Validity'},{key:'edit',label:'Action'}]} itemRenderer={(row,column)=>column.key==='edit'?<SecondaryButton label="Edit amount" isDisabled={standalone||!canManage||busy||disabled||needsReload||Boolean(row.issue)} onClick={()=>{setSelected(row.id);setAmount(row.amount);setPreview(undefined);setError('');setMessage('');}}/>:String(row[column.key as 'sku'|'amount'|'currency'|'country'|'channel'|'group'|'validity'])}/></div>:<Text.Detail>No embedded prices are present in the staged product.</Text.Detail>}
  {chosen&&!standalone&&<Spacings.Stack scale="m"><Text.Body>{chosen.sku} · {chosen.currency} · {chosen.country} · {chosen.channel} · {chosen.group} · {chosen.validity}</Text.Body><TextField name="price-amount" title={`New amount (${chosen.currency})`} value={amount} isDisabled={busy||disabled||Boolean(preview)} onChange={event=>{setAmount(event.target.value);setPreview(undefined);}}/>
   {preview?<React.Fragment><ContentNotification type="warning">Save {preview.row.amount} → {preview.newAmount} {preview.row.currency} to staged product version {preview.version}. The scope and validity above are preserved. Publication is a separate step and includes all staged product changes.</ContentNotification><Spacings.Inline><PrimaryButton label="Confirm staged price" isDisabled={!canManage||busy||disabled||needsReload} onClick={()=>void save()}/><SecondaryButton label="Cancel price review" isDisabled={busy} onClick={()=>setPreview(undefined)}/></Spacings.Inline></React.Fragment>:<PrimaryButton label="Review price change" isDisabled={!canManage||busy||disabled||needsReload} onClick={review}/>}
  </Spacings.Stack>}
  {needsReload&&<ContentNotification type="warning">The write was not confirmed or the version changed. Refresh to verify the current price before another attempt; no automatic retry is performed.</ContentNotification>}
 </Section>;
}
