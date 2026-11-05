import type {Product} from './api';
import {productListRow,type ProductListRow,isResourceId} from './list-queries';

export type QualityScan={checked:number;rows:ProductListRow[];complete:boolean;limited:boolean};
export const MAX_QUALITY_SCAN=3000;
export async function scanProductQuality(
  api:<T>(path:string)=>Promise<T>,
  onProgress:(result:QualityScan)=>void,
  isCancelled:()=>boolean=()=>false,
  max=MAX_QUALITY_SCAN,
):Promise<QualityScan>{
  if(!Number.isSafeInteger(max)||max<1||max>MAX_QUALITY_SCAN)throw new Error('目录检查数量超出范围。');
  const result:QualityScan={checked:0,rows:[],complete:false,limited:false};
  const seen=new Set<string>();
  let cursor='';
  while(!isCancelled()){
    const limit=Math.min(100,max-result.checked);
    const params=new URLSearchParams({limit:String(limit),sort:'id asc',withTotal:'false'});
    if(cursor)params.set('where',`id > ${JSON.stringify(cursor)}`);
    const page=await api<{results:Product[]}>(`products?${params}`);
    if(isCancelled())return result;
    if(!Array.isArray(page.results)||page.results.length>limit)throw new Error('目录检查返回了无效页面。');
    for(const product of page.results){
      if(!product||typeof product.id!=='string'||!isResourceId(product.id)||seen.has(product.id.toLowerCase())){
        throw new Error('目录检查返回了无效或重复的商品标识，请重新检查。');
      }
      seen.add(product.id.toLowerCase());result.rows.push(productListRow(product));result.checked++;
    }
    // The API owns ID ordering. UUID string comparison in JavaScript does not
    // reproduce the platform's cursor order; use the last returned ID as-is.
    if(page.results.length)cursor=page.results[page.results.length-1].id;
    result.complete=page.results.length<limit;
    if(result.checked===max&&!result.complete){
      // A read-only one-record probe distinguishes an exact-size catalog from a capped scan.
      const probe=await api<{results:Product[]}>(`products?${new URLSearchParams({limit:'1',sort:'id asc',withTotal:'false',where:`id > ${JSON.stringify(cursor)}`})}`);
      if(isCancelled())return result;
      if(!Array.isArray(probe.results)||probe.results.length>1)throw new Error('目录检查范围无法确认。');
      const next=probe.results[0];
      if(probe.results.length&&(!next||typeof next.id!=='string'||!isResourceId(next.id)||seen.has(next.id.toLowerCase()))){
        throw new Error('目录检查范围返回了无效或重复的商品标识，请重新检查。');
      }
      result.complete=probe.results.length===0;result.limited=!result.complete;
    }
    onProgress({...result,rows:[...result.rows]});
    if(result.complete||result.limited)return result;
  }
  return result;
}
