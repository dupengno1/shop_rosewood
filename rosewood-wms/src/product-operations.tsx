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
import {inventorySummary,productOperationalData,warehouseName,supplyChannelGroups} from './operations-data';
import {errorMessage} from './domain';
import {Section,Notice,NativeLink} from './shared';
import {readInventoryRows} from './inventory-data';
import {readCatalogMemberships,readProductMemberships,type Membership} from './catalog-memberships';

export function ProductOperationsDetail({product}:{product:Product}){
 const api=useCommerceApi(),[rows,setRows]=useState<Inventory[]>([]),[catalogs,setCatalogs]=useState<string[]>(),[error,setError]=useState(''),[catalogError,setCatalogError]=useState(''),[loading,setLoading]=useState(true),[attempt,setAttempt]=useState(0);
 useEffect(()=>{let active=true;setLoading(true);setRows([]);setError('');setCatalogs(undefined);setCatalogError('');
  const skus=[...new Set([product.masterData.staged.masterVariant,...product.masterData.staged.variants].map(v=>v.sku).filter((s):s is string=>Boolean(s)))];
  (async()=>{const inventory:Inventory[]=[];try{for(let i=0;i<skus.length;i+=5){const batch=await Promise.all(skus.slice(i,i+5).map(sku=>readInventoryRows(api,{kind:'sku',sku})));inventory.push(...batch.flat());}if(active)setRows(inventory);}catch(e){if(active)setError(errorMessage(e));}finally{if(active)setLoading(false);}})();
  readProductMemberships(api,product.id).then(value=>{if(active)setCatalogs(value.map(row=>row.detail));}).catch(e=>{if(active)setCatalogError(errorMessage(e));});
  return()=>{active=false;};
 },[api,product.id,product.version,attempt]);
 const data=productOperationalData(product,rows,!loading&&!error),channels=supplyChannelGroups(rows);
 const variants=data.variants.map(variant=>({id:String(variant.id),sku:variant.sku||'No SKU',rows:rows.filter(row=>row.sku===variant.sku)}));
 return <Spacings.Stack scale="l">
  <Section title="Fulfilment Information">
   <Spacings.Stack scale="xs"><Text.Detail tone="secondary">Primary Fulfilment Warehouse</Text.Detail><Text.Subheadline as="h4">{data.primaryWarehouse}</Text.Subheadline></Spacings.Stack>
   <Text.Body>Fulfilment Strategy: {data.strategy} · Fallback Warehouse: {data.fallbackWarehouse}</Text.Body>
   {data.primaryWarehouseMismatch&&<ContentNotification type="warning">The native Primary Fulfilment Warehouse attribute shows {data.nativePrimaryWarehouse}, but storefront allocation uses {data.primaryWarehouse}. Align the native attribute before relying on it.</ContentNotification>}
   <Text.Detail>Orders reserve and ship physical items from this warehouse. Digital products are delivered by email and hold no physical stock.</Text.Detail>
  </Section>
  <Section title="Store Information">
   <Text.Body>Catalog Assignment: {catalogs?catalogs.join(' / ')||'Not assigned':'Not available'}</Text.Body>
   <Text.Detail>One Project product can belong to shared, hotel and B2B selections. Selection membership alone does not confirm Store availability; active Store assignments and exclusions also apply.</Text.Detail>
   {catalogError&&<ContentNotification type="warning">Catalog assignments are unavailable. Product Selection read access is required. {catalogError}</ContentNotification>}
  </Section>
  <Section title="Inventory Summary">
   <SecondaryButton label="Refresh operational information" isDisabled={loading} onClick={()=>setAttempt(n=>n+1)}/><Notice error={error}/>
   {loading?<LoadingSpinner/>:data.digital?<React.Fragment><Text.Body>Digital Delivery — physical inventory does not apply. Availability depends on the product's published status and selling configuration.</Text.Body>
   <DataTable isCondensed rows={variants} columns={[{key:'sku',label:'SKU'},{key:'fulfilment',label:'Fulfilment Warehouse'}]} itemRenderer={(row,col)=>col.key==='sku'?row.sku:data.primaryWarehouse}/></React.Fragment>:<React.Fragment>
   <DataTable isCondensed rows={channels.map(channel=>({id:channel.id,channel:channel.label,...inventorySummary(channel.rows,!error)}))} columns={[{key:'channel',label:'Supply channel'},{key:'available',label:'Available'},{key:'reserved',label:'Reserved Inventory'}]} itemRenderer={(row,col)=>row[col.key as keyof typeof row]??'Unknown'}/>
   <Text.Body>Total Available Inventory: {data.summary.available??'Unknown'} · Inventory Status: {data.summary.status}</Text.Body>
   <Text.Detail>Reserved Inventory is the observed quantityOnStock minus availableQuantity for each SKU and supply channel. Order and reservation updates may take up to 10 seconds to appear. This aggregate is not the quantity reserved by a particular order. Missing or inconsistent inventory records remain Unknown.</Text.Detail>
   <div style={{overflowX:'auto'}}><DataTable isCondensed rows={variants} columns={[{key:'sku',label:'SKU'},{key:'fulfilment',label:'Fulfilment Warehouse'},...channels.map(channel=>({key:'channel:'+channel.id,label:channel.label})),{key:'total',label:'Total Available'},{key:'reserved',label:'Reserved Inventory'},{key:'status',label:'Inventory Status'}]} itemRenderer={(row,col)=>{
    const summary=inventorySummary(row.rows,!error);
    if(col.key==='sku')return row.sku;if(col.key==='fulfilment')return data.primaryWarehouse;if(col.key==='total')return summary.available??'Unknown';if(col.key==='reserved')return summary.reserved??'Unknown';if(col.key==='status')return summary.status;
    return inventorySummary(row.rows.filter(entry=>'channel:'+(entry.supplyChannel?.id||'unscoped')===col.key),!error).available??'—';
   }}/></div></React.Fragment>}
  </Section>
 </Spacings.Stack>;
}
type WorkbenchRow=ReturnType<typeof productOperationalData>&{catalogs:Membership[]|null;warehouseRows:Inventory[]};
export default function ProductOperationsWorkbench({project}:{project:string}){
 const api=useCommerceApi(),[rows,setRows]=useState<WorkbenchRow[]>([]),[selected,setSelected]=useState<Product>(),[products,setProducts]=useState<Product[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[warning,setWarning]=useState(''),[attempt,setAttempt]=useState(0),[progress,setProgress]=useState(0),[catalogOptions,setCatalogOptions]=useState<Array<{value:string;label:string}>>([]);
 const [search,setSearch]=useState(''),[catalog,setCatalog]=useState('all'),[warehouse,setWarehouse]=useState('all'),[status,setStatus]=useState('all'),[published,setPublished]=useState('all'),[page,setPage]=useState(0);
 useEffect(()=>{let active=true;setLoading(true);setError('');setWarning('');setRows([]);setProducts([]);setProgress(0);setCatalogOptions([]);
  (async()=>{try{
   const all:Product[]=[];let last='';const seen=new Set<string>();
   for(;;){const params=new URLSearchParams({limit:'500',sort:'id asc',withTotal:'false',...(last?{where:`id > ${JSON.stringify(last)}`}:{})});const result=await api<{results:Product[]}>(`products?${params}`);if(!active)return;
    if(!Array.isArray(result.results)||result.results.some(row=>seen.has(row.id)))throw Error('Product scan did not advance. Refresh before using these results.');
    result.results.forEach(row=>seen.add(row.id));all.push(...result.results);setProgress(all.length);
    if(result.results.length<500)break;if(all.length>=3000)throw Error('The catalog reaches the 3,000-product workbench limit. Use native Products to narrow the selection.');last=all.at(-1)!.id;
   }
   const inventory:Inventory[]=[];last='';const inventorySeen=new Set<string>();
   let inventoryComplete=true;try{for(;;){const q=new URLSearchParams({limit:'500',sort:'id asc',withTotal:'false',expand:'supplyChannel',...(last?{where:`id > ${JSON.stringify(last)}`}:{})});const result=await api<{results:Inventory[]}>(`inventory?${q}`);if(!active)return;if(!Array.isArray(result.results)||result.results.some(row=>inventorySeen.has(row.id)))throw Error('Inventory scan did not advance.');result.results.forEach(row=>inventorySeen.add(row.id));inventory.push(...result.results);if(result.results.length<500)break;if(inventory.length>=10000)throw Error('Inventory scan limit reached.');last=inventory.at(-1)!.id;}}catch{inventoryComplete=false;if(active)setWarning('Inventory could not be read completely. Availability is shown as Unknown.');}
   let memberships=new Map<string,Membership[]>(),catalogsComplete=true;
   try{const catalogData=await readCatalogMemberships(api);memberships=catalogData.memberships;if(active)setCatalogOptions(catalogData.selections);}
   catch{catalogsComplete=false;if(active)setWarning(previous=>[previous,'Product Selection assignments could not be read completely. Check read access or use native Product Selections; membership is shown as unavailable.'].filter(Boolean).join(' '));}
   if(!active)return;setProducts(all);setRows(all.map(product=>{const skus=new Set([product.masterData.staged.masterVariant,...product.masterData.staged.variants].map(v=>v.sku));const warehouseRows=inventory.filter(row=>skus.has(row.sku));return {...productOperationalData(product,warehouseRows,inventoryComplete),catalogs:catalogsComplete?memberships.get(product.id)||[]:null,warehouseRows};}));
  }catch(e){if(active)setError(errorMessage(e));}finally{if(active)setLoading(false);}})();return()=>{active=false;};
 },[api,attempt]);
 useEffect(()=>setPage(0),[search,catalog,warehouse,status,published]);
 const matches=rows.filter(row=>(!search||`${row.name} ${row.key} ${row.variants.map(v=>v.sku).join(' ')}`.toLowerCase().includes(search.toLowerCase()))&&(catalog==='all'||row.catalogs?.some(value=>value.id===catalog))&&(warehouse==='all'||row.primaryWarehouse===warehouse||row.warehouseRows.some(entry=>warehouseName(entry.supplyChannel)===warehouse))&&(status==='all'||(row.digital?'Digital':row.summary.status)===status)&&(published==='all'||row.published===(published==='published')));
 if(selected)return <Spacings.Stack scale="l"><SecondaryButton label="Back to product operations" onClick={()=>setSelected(undefined)}/><Text.Subheadline as="h4">{productOperationalData(selected,[]).name}</Text.Subheadline><NativeLink label="Open native product" url={`${window.location.origin}/${project}/products/${selected.id}`}/><ProductOperationsDetail product={selected}/></Spacings.Stack>;
 return <Section title="Product Operations">
  <Text.Detail>Review shared, hotel and B2B product selections and available inventory by supply channel. Selection assignment does not by itself establish Store availability.</Text.Detail>
  <TextField name="product-query" title="Product name, key or SKU" value={search} onChange={e=>setSearch(e.target.value)}/>
  <Spacings.Inline><SelectField name="catalog" title="Catalog" value={catalog} options={[{value:'all',label:'All product selections'},...catalogOptions]} onChange={e=>setCatalog(String(e.target.value))}/>
   <SelectField name="warehouse" title="Warehouse" value={warehouse} options={['all',...new Set(rows.flatMap(row=>[row.primaryWarehouse,...row.warehouseRows.map(entry=>warehouseName(entry.supplyChannel))]))].map(value=>({value,label:value==='all'?'All warehouses':value}))} onChange={e=>setWarehouse(String(e.target.value))}/>
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
    {key:'primaryWarehouse',label:'Primary Fulfilment Warehouse',width:'210px'},
    {key:'available',label:'Available Inventory',width:'180px'},
    {key:'status',label:'Inventory Status',width:'164px'},
    {key:'published',label:'Published Status',width:'160px'},
    {key:'open',label:'Action',width:'190px'},
   ]} itemRenderer={(row,col)=>{
    if(col.key==='image')return row.image?<img src={row.image} alt={row.name} style={{width:64,height:64,minWidth:64,flexShrink:0,objectFit:'contain'}}/>:'No image';if(col.key==='catalogs')return row.catalogs?.map(value=>value.detail).join(' / ')|| (row.catalogs?'Not assigned':'Not available');if(col.key==='available')return row.digital?'Not applicable':row.summary.available??'Unknown';if(col.key==='status')return row.digital?(row.published?'Active digital product':'Unpublished digital product'):row.summary.status;if(col.key==='published')return row.published?'Published':'Unpublished';if(col.key==='open')return <SecondaryButton label="View operations" onClick={()=>setSelected(products.find(p=>p.id===row.id))}/>;return String(row[col.key as 'name'|'key'|'primaryWarehouse']);
   }}/>
  </div><Spacings.Inline><SecondaryButton label="Previous" isDisabled={page===0} onClick={()=>setPage(p=>p-1)}/><Text.Body>Page {page+1}</Text.Body><SecondaryButton label="Next" isDisabled={(page+1)*20>=matches.length} onClick={()=>setPage(p=>p+1)}/></Spacings.Inline></React.Fragment>}
 </Section>;
}
