import type {Localized} from './api';

type ReadApi=<T>(path:string)=>Promise<T>;
export type Selection={id:string;key?:string;name?:Localized;mode?:'Individual'|'IndividualExclusion'};
export type Assignment={productSelection:{id:string;obj?:Selection};variantSelection?:{type?:string;skus?:string[]};variantExclusion?:{skus?:string[]}};
export type Membership={id:string;label:string;detail:string};
export const selectionLabel=(selection:Assignment['productSelection'])=>selection.obj?.name?.en||Object.values(selection.obj?.name||{}).find(Boolean)||selection.obj?.key||selection.id;
function membership(selection:Selection,variant?:Assignment['variantSelection'],exclusion?:Assignment['variantExclusion']):Membership{
 const label=selectionLabel({id:selection.id,obj:selection});
 const effect=selection.mode==='IndividualExclusion'?'Exclusion selection':selection.mode==='Individual'?'Inclusion selection':'Selection';
 const variantScope=selection.mode==='IndividualExclusion'?(exclusion?`excluded SKUs: ${(exclusion.skus||[]).join(', ')}`:'all variants excluded'):!variant?'all variants':variant.type==='includeOnly'?`only SKUs: ${(variant.skus||[]).join(', ')}`:variant.type==='includeAllExcept'?`all except SKUs: ${(variant.skus||[]).join(', ')}`:'variant restriction';
 return {id:selection.id,label,detail:`${label} (${effect}; ${variantScope})`};
}

// Reads native assignments only. Membership is not proof of effective Store
// availability: a Store may disable a selection or apply exclusion selections.
export async function readProductMemberships(api:ReadApi,productId:string):Promise<Membership[]>{
 const result:Membership[]=[],seen=new Set<string>();
 for(let offset=0;offset<=10000;offset+=100){
  const page=await api<{results:Assignment[]}>(`products/${encodeURIComponent(productId)}/product-selections?limit=100&offset=${offset}&expand=productSelection`);
  if(!Array.isArray(page.results)||page.results.length>100)throw Error('Catalog assignments could not be read.');
  for(const row of page.results){if(!row.productSelection?.id||seen.has(row.productSelection.id))throw Error('Catalog assignments changed while reading. Refresh to review.');seen.add(row.productSelection.id);result.push(membership({...row.productSelection.obj,id:row.productSelection.id},row.variantSelection,row.variantExclusion));}
  if(page.results.length<100)return result;
 }
 throw Error('Catalog assignment limit reached; use native Product Selections to review.');
}

export async function readCatalogMemberships(api:ReadApi){
 const selections:Selection[]=[],seen=new Set<string>();let last='';
 for(;;){
  const query=new URLSearchParams({limit:'100',sort:'id asc',withTotal:'false',...(last?{where:`id > ${JSON.stringify(last)}`}:{})});
  const page=await api<{results:Selection[]}>(`product-selections?${query}`);
  if(!Array.isArray(page.results)||page.results.length>100)throw Error('Product Selections could not be read.');
  for(const row of page.results){if(!row.id||seen.has(row.id))throw Error('Product Selection scan did not advance.');seen.add(row.id);selections.push(row);}
  if(page.results.length<100)break;
  if(selections.length>=500)throw Error('The Product Selection workbench limit was reached. Use native Product Selections to narrow the review.');
  last=page.results.at(-1)!.id;
 }
 const memberships=new Map<string,Membership[]>();
 for(const selection of selections){
  const productsSeen=new Set<string>();
  for(let offset=0;offset<=10000;offset+=500){
   const page=await api<{results:Array<{product:{id:string};variantSelection?:Assignment['variantSelection'];variantExclusion?:Assignment['variantExclusion']}>}>(`product-selections/${encodeURIComponent(selection.id)}/products?limit=500&offset=${offset}&withTotal=false`);
   if(!Array.isArray(page.results)||page.results.length>500)throw Error('Product Selection assignments could not be read.');
   for(const row of page.results){if(!row.product?.id||productsSeen.has(row.product.id))throw Error('Product Selection assignments changed while reading.');productsSeen.add(row.product.id);memberships.set(row.product.id,[...(memberships.get(row.product.id)||[]),membership(selection,row.variantSelection,row.variantExclusion)]);}
   if(page.results.length<500)break;
   if(offset===10000)throw Error('Product Selection assignment limit reached. Use native Product Selections to review.');
  }
 }
 return {selections:selections.map(selection=>({value:selection.id,label:selectionLabel({id:selection.id,obj:selection})+(selection.mode==='IndividualExclusion'?' (exclusion)':'')})),memberships};
}
