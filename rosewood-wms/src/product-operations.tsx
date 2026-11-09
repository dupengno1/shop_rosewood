import React,{useEffect,useState} from 'react';
import DataTable from '@commercetools-uikit/data-table';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import TextField from '@commercetools-uikit/text-field';
import SelectField from '@commercetools-uikit/select-field';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import LoadingSpinner from '@commercetools-uikit/loading-spinner';
import {ContentNotification} from '@commercetools-uikit/notifications';
import {useCommerceApi,type Product,type Inventory} from './api';
import {inventorySummary,productOperationalData,warehouseName,warehouseNames} from './operations-data';
import {errorMessage} from './domain';
import {Section,Notice,NativeLink} from './shared';
import {readInventoryRows} from './inventory-data';

export type Assignment={productSelection:{id:string;obj?:{key?:string;name?:Record<string,string>}};variantSelection?:unknown};
export const selectionLabel=(selection:Assignment['productSelection'])=>selection.obj?.key==='rosewood-us-catalog'?'Global Catalog':selection.obj?.key==='rosewood-hk-catalog'?'HK Catalog':selection.obj?.name?.en||selection.obj?.key||selection.id;
async function assignments(api:ReturnType<typeof useCommerceApi>,id:string):Promise<string[]>{
 const result:string[]=[];
 for(let offset=0;offset<=10000;offset+=100){
  const page=await api<{results:Assignment[]}>(`products/${id}/product-selections?limit=100&offset=${offset}&expand=productSelection`);
  if(!Array.isArray(page.results))throw Error('Catalog assignments could not be read.');
  result.push(...page.results.map(row=>selectionLabel(row.productSelection)+(row.variantSelection?' (selected variants)':'')));
  if(page.results.length<100)return result;
 }
 throw Error('Catalog assignment limit reached; use native Product Selections to review.');
}
export function ProductOperationsDetail({product}:{product:Product}){
 const api=useCommerceApi(),[rows,setRows]=useState<Inventory[]>([]),[catalogs,setCatalogs]=useState<string[]>(),[error,setError]=useState(''),[catalogError,setCatalogError]=useState(''),[loading,setLoading]=useState(true),[attempt,setAttempt]=useState(0);
 useEffect(()=>{let active=true;setLoading(true);setRows([]);setError('');setCatalogs(undefined);setCatalogError('');
  const skus=[...new Set([product.masterData.staged.masterVariant,...product.masterData.staged.variants].map(v=>v.sku).filter((s):s is string=>Boolean(s)))];
  (async()=>{const inventory:Inventory[]=[];try{for(let i=0;i<skus.length;i+=5){const batch=await Promise.all(skus.slice(i,i+5).map(sku=>readInventoryRows(api,{kind:'sku',sku})));inventory.push(...batch.flat());}if(active)setRows(inventory);}catch(e){if(active)setError(errorMessage(e));}finally{if(active)setLoading(false);}})();
  assignments(api,product.id).then(value=>{if(active)setCatalogs(value);}).catch(e=>{if(active)setCatalogError(errorMessage(e));});
  return()=>{active=false;};
 },[api,product.id,product.version,attempt]);
 const data=productOperationalData(product,rows,!loading&&!error),channels=[...new Set(rows.map(row=>warehouseName(row.supplyChannel)))];
 const variants=data.variants.map(variant=>({id:String(variant.id),sku:variant.sku||'No SKU',rows:rows.filter(row=>row.sku===variant.sku)}));
 return <Spacings.Stack scale="l">
  <Section title="Store & Fulfilment Information">
   <Text.Body>Catalog Assignment: {catalogs?catalogs.join(' / ')||'Not assigned':'Not available'}</Text.Body>
   {catalogError&&<ContentNotification type="warning">Catalog assignments are unavailable. Product Selection read access is required. {catalogError}</ContentNotification>}
   <Text.Body>Primary Fulfilment Warehouse: {data.primaryWarehouse}</Text.Body><Text.Body>Fulfilment Strategy: {data.strategy}</Text.Body><Text.Body>Fallback Warehouse: {data.fallbackWarehouse}</Text.Body>
  </Section>
  <Section title="Inventory Summary">
   <SecondaryButton label="Refresh operational information" isDisabled={loading} onClick={()=>setAttempt(n=>n+1)}/><Notice error={error}/>
   {loading?<LoadingSpinner/>:data.digital?<Text.Body>Digital Delivery — physical inventory does not apply. Availability depends on the product's published status and selling configuration.</Text.Body>:<React.Fragment>
   <DataTable isCondensed rows={channels.map(channel=>({id:channel,channel,...inventorySummary(rows.filter(row=>warehouseName(row.supplyChannel)===channel),!error)}))} columns={[{key:'channel',label:'Warehouse'},{key:'available',label:'Available'},{key:'reserved',label:'Reserved / unavailable'}]} itemRenderer={(row,col)=>row[col.key as keyof typeof row]??'Unknown'}/>
   <Text.Body>Total Available Inventory: {data.summary.available??'Unknown'} · Inventory Status: {data.summary.status}</Text.Body>
   <Text.Detail>Reserved / unavailable is the observed on-stock minus available quantity. It is not an order-specific reservation ledger. Missing inventory records are Unknown, not zero.</Text.Detail>
   <DataTable isCondensed rows={variants} columns={[{key:'sku',label:'SKU'},...['Asia Warehouse','EMEA Warehouse','Americas Warehouse','Hong Kong Warehouse'].map(name=>({key:name,label:name.replace(' Warehouse','')})),{key:'total',label:'Total Available'},{key:'reserved',label:'Reserved / unavailable'},{key:'status',label:'Inventory Status'}]} itemRenderer={(row,col)=>{
    const summary=inventorySummary(row.rows,!error);
    if(col.key==='sku')return row.sku;if(col.key==='total')return summary.available??'Unknown';if(col.key==='reserved')return summary.reserved??'Unknown';if(col.key==='status')return summary.status;
    return inventorySummary(row.rows.filter(entry=>warehouseName(entry.supplyChannel)===col.key),!error).available??'—';
   }}/></React.Fragment>}
  </Section>
 </Spacings.Stack>;
}
type WorkbenchRow=ReturnType<typeof productOperationalData>&{catalogs:string[]|null;warehouseRows:Inventory[]};
export default function ProductOperationsWorkbench({project}:{project:string}){
 const api=useCommerceApi(),[rows,setRows]=useState<WorkbenchRow[]>([]),[selected,setSelected]=useState<Product>(),[products,setProducts]=useState<Product[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[warning,setWarning]=useState(''),[attempt,setAttempt]=useState(0),[progress,setProgress]=useState(0);
 const [search,setSearch]=useState(''),[catalog,setCatalog]=useState('all'),[warehouse,setWarehouse]=useState('all'),[status,setStatus]=useState('all'),[published,setPublished]=useState('all'),[page,setPage]=useState(0);
 useEffect(()=>{let active=true;setLoading(true);setError('');setWarning('');setRows([]);setProducts([]);setProgress(0);
  (async()=>{try{
   const all:Product[]=[];let last='';const seen=new Set<string>();
   for(;;){const params=new URLSearchParams({limit:'500',sort:'id asc',withTotal:'false',...(last?{where:`id > ${JSON.stringify(last)}`}:{})});const result=await api<{results:Product[]}>(`products?${params}`);if(!active)return;
    if(!Array.isArray(result.results)||result.results.some(row=>seen.has(row.id)))throw Error('Product scan did not advance. Refresh before using these results.');
    result.results.forEach(row=>seen.add(row.id));all.push(...result.results);setProgress(all.length);
    if(result.results.length<500)break;if(all.length>=3000)throw Error('The catalog reaches the 3,000-product workbench limit. Use native Products to narrow the selection.');last=all.at(-1)!.id;
   }
   const inventory:Inventory[]=[];last='';const inventorySeen=new Set<string>();
   let inventoryComplete=true;try{for(;;){const q=new URLSearchParams({limit:'500',sort:'id asc',withTotal:'false',expand:'supplyChannel',...(last?{where:`id > ${JSON.stringify(last)}`}:{})});const result=await api<{results:Inventory[]}>(`inventory?${q}`);if(!active)return;if(!Array.isArray(result.results)||result.results.some(row=>inventorySeen.has(row.id)))throw Error('Inventory scan did not advance.');result.results.forEach(row=>inventorySeen.add(row.id));inventory.push(...result.results);if(result.results.length<500)break;if(inventory.length>=10000)throw Error('Inventory scan limit reached.');last=inventory.at(-1)!.id;}}catch{inventoryComplete=false;if(active)setWarning('Inventory could not be read completely. Availability is shown as Unknown.');}
   const memberships=new Map<string,string[]>();let catalogsComplete=true;
   for(const [key,label] of [['rosewood-us-catalog','Global Catalog'],['rosewood-hk-catalog','HK Catalog']]){try{for(let offset=0;offset<=10000;offset+=500){const result=await api<{results:Array<{product:{id:string};variantSelection?:unknown}>}>(`product-selections/key=${key}/products?limit=500&offset=${offset}`);if(!active)return;if(!Array.isArray(result.results))throw Error('Invalid selection response');result.results.forEach(row=>memberships.set(row.product.id,[...(memberships.get(row.product.id)||[]),label+(row.variantSelection?' (selected variants)':'')]));if(result.results.length<500)break;if(offset===10000)throw Error('Selection scan limit reached');}}catch{catalogsComplete=false;if(active)setWarning('Catalog assignment requires Product Selection read access. Inventory remains separately verified.');}}
   if(!active)return;setProducts(all);setRows(all.map(product=>{const skus=new Set([product.masterData.staged.masterVariant,...product.masterData.staged.variants].map(v=>v.sku));const warehouseRows=inventory.filter(row=>skus.has(row.sku));return {...productOperationalData(product,warehouseRows,inventoryComplete),catalogs:catalogsComplete?memberships.get(product.id)||[]:null,warehouseRows};}));
  }catch(e){if(active)setError(errorMessage(e));}finally{if(active)setLoading(false);}})();return()=>{active=false;};
 },[api,attempt]);
 useEffect(()=>setPage(0),[search,catalog,warehouse,status,published]);
 const matches=rows.filter(row=>(!search||`${row.name} ${row.key} ${row.variants.map(v=>v.sku).join(' ')}`.toLowerCase().includes(search.toLowerCase()))&&(catalog==='all'||row.catalogs?.some(value=>value.startsWith(catalog)))&&(warehouse==='all'||row.primaryWarehouse===warehouse||row.warehouseRows.some(entry=>warehouseName(entry.supplyChannel)===warehouse))&&(status==='all'||(row.digital?'Digital':row.summary.status)===status)&&(published==='all'||row.published===(published==='published')));
 if(selected)return <Spacings.Stack scale="l"><SecondaryButton label="Back to product operations" onClick={()=>setSelected(undefined)}/><Text.Subheadline as="h4">{productOperationalData(selected,[]).name}</Text.Subheadline><NativeLink label="Open native product" url={`${window.location.origin}/${project}/products/${selected.id}`}/><ProductOperationsDetail product={selected}/></Spacings.Stack>;
 return <Section title="Product Operations">
  <Text.Detail>Review catalog membership and available inventory by store and warehouse.</Text.Detail>
  <TextField name="product-query" title="Product name, key or SKU" value={search} onChange={e=>setSearch(e.target.value)}/>
  <Spacings.Inline><SelectField name="catalog" title="Catalog" value={catalog} options={['all','Global Catalog','HK Catalog'].map(value=>({value,label:value==='all'?'All catalogs':value}))} onChange={e=>setCatalog(String(e.target.value))}/>
   <SelectField name="warehouse" title="Warehouse" value={warehouse} options={['all',...new Set(Object.values(warehouseNames)),'Digital Delivery'].map(value=>({value,label:value==='all'?'All warehouses':value}))} onChange={e=>setWarehouse(String(e.target.value))}/>
   <SelectField name="status" title="Inventory Status" value={status} options={['all','In Stock','Low Stock','Out of Stock','Unknown','Digital'].map(value=>({value,label:value==='all'?'All statuses':value}))} onChange={e=>setStatus(String(e.target.value))}/>
   <SelectField name="published" title="Published Status" value={published} options={[{value:'all',label:'All products'},{value:'published',label:'Published'},{value:'draft',label:'Unpublished'}]} onChange={e=>setPublished(String(e.target.value))}/>
  </Spacings.Inline><SecondaryButton label="Refresh products and stock" isDisabled={loading} onClick={()=>setAttempt(n=>n+1)}/><Notice error={error}/>{warning&&<ContentNotification type="warning">{warning}</ContentNotification>}
  {loading?<React.Fragment><LoadingSpinner/><Text.Detail>Reading live products: {progress}</Text.Detail></React.Fragment>:<React.Fragment><Text.Body>{matches.length} matching products</Text.Body>
  <div role="region" aria-label="Product operations table" tabIndex={0} style={{width:'100%',minWidth:0,maxWidth:'100%',overflowX:'auto'}}>
   <DataTable<WorkbenchRow> isCondensed maxWidth="100%" wrapHeaderLabels={false} rows={matches.slice(page*20,(page+1)*20)} columns={[
    {key:'name',label:'Product Name',width:'minmax(220px, 2fr)'},
    {key:'image',label:'Product Image',width:'144px'},
    {key:'key',label:'Product Key',width:'160px'},
    {key:'catalogs',label:'Catalog Assignment',width:'180px'},
    {key:'primaryWarehouse',label:'Primary Warehouse',width:'190px'},
    {key:'available',label:'Available Inventory',width:'180px'},
    {key:'status',label:'Inventory Status',width:'164px'},
    {key:'published',label:'Published Status',width:'160px'},
    {key:'open',label:'Action',width:'190px'},
   ]} itemRenderer={(row,col)=>{
    if(col.key==='image')return row.image?<img src={row.image} alt={row.name} style={{width:64,height:64,minWidth:64,flexShrink:0,objectFit:'contain'}}/>:'No image';if(col.key==='catalogs')return row.catalogs?.join(' / ')|| (row.catalogs?'Not assigned':'Not available');if(col.key==='available')return row.digital?'Not applicable':row.summary.available??'Unknown';if(col.key==='status')return row.digital?(row.published?'Active digital product':'Unpublished digital product'):row.summary.status;if(col.key==='published')return row.published?'Published':'Unpublished';if(col.key==='open')return <SecondaryButton label="View operations" onClick={()=>setSelected(products.find(p=>p.id===row.id))}/>;return String(row[col.key as 'name'|'key'|'primaryWarehouse']);
   }}/>
  </div><Spacings.Inline><SecondaryButton label="Previous" isDisabled={page===0} onClick={()=>setPage(p=>p-1)}/><Text.Body>Page {page+1}</Text.Body><SecondaryButton label="Next" isDisabled={(page+1)*20>=matches.length} onClick={()=>setPage(p=>p+1)}/></Spacings.Inline></React.Fragment>}
 </Section>;
}
