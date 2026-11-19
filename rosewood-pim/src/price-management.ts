import type {EmbeddedPrice,PriceReference,Product} from './api';

export function priceReferenceLabel(ref:PriceReference|undefined,fallback:string){
 const name=ref?.obj?.name;
 return (typeof name==='string'?name:name?.en||Object.values(name||{}).find(Boolean))||ref?.obj?.key||ref?.id||fallback;
}
export function priceAmount(price:EmbeddedPrice):string{
 const {centAmount,currencyCode,fractionDigits}=price.value||{};
 if(price.value?.type==='highPrecision'||!Number.isSafeInteger(centAmount)||!currencyCode||!Number.isInteger(fractionDigits))return 'Not available';
 const value=BigInt(centAmount!),digits=fractionDigits!;
 if(digits<0||digits>6)return 'Not available';
 const absolute=(value<0n?-value:value).toString().padStart(digits+1,'0');
 return (value<0n?'-':'')+(digits?absolute.slice(0,-digits)+'.'+absolute.slice(-digits):absolute);
}
export function priceEditIssue(price:EmbeddedPrice):string|undefined{
 if(!price.id||price.value?.type!=='centPrecision'||priceAmount(price)==='Not available'||Number(price.value.centAmount)<0)return 'Use native pricing for incomplete or high-precision prices.';
 if(Object.keys(price).some(key=>!['id','key','value','country','channel','customerGroup','validFrom','validUntil'].includes(key)))return 'Use native pricing for discounts, tiers, custom fields or additional price dimensions.';
 if(price.country!==undefined&&!/^[A-Z]{2}$/.test(price.country)||!price.value?.currencyCode||!/^[A-Z]{3}$/.test(price.value.currencyCode))return 'This price scope is incomplete.';
 for(const ref of [price.channel,price.customerGroup])if(ref&&!ref.id)return 'This price reference is incomplete.';
 return undefined;
}
export function productPriceRows(product:Product){
 return [product.masterData.staged.masterVariant,...product.masterData.staged.variants].flatMap(variant=>
  (variant.prices||[]).map((price,index)=>({id:`${variant.id}:${price.id||index}`,variantId:variant.id,sku:variant.sku||`Variant ${variant.id}`,price,
   amount:priceAmount(price),currency:price.value?.currencyCode||'Unknown',country:price.country||'All countries',
   channel:priceReferenceLabel(price.channel,'All channels'),group:priceReferenceLabel(price.customerGroup,'All customer groups'),
   validity:[price.validFrom||'No start',price.validUntil||'No end'].join(' → '),issue:priceEditIssue(price)})));
}
export function planPriceChange(product:Product,variantId:number,priceId:string,amount:string){
 if(product.priceMode&&product.priceMode!=='Embedded')throw Error('Use native Standalone Prices for this product.');
 if(!Number.isSafeInteger(product.version)||product.version<1)throw Error('Refresh this product before changing its price.');
 const candidates=productPriceRows(product).filter(row=>row.variantId===variantId&&row.price.id===priceId);
 if(candidates.length!==1)throw Error('This price has changed. Refresh and review again.');
 const row=candidates[0],issue=priceEditIssue(row.price);
 if(issue)throw Error(issue);
 const digits=row.price.value!.fractionDigits!;
 const pattern=digits?new RegExp(`^(0|[1-9][0-9]*)(?:\\.[0-9]{1,${digits}})?$`):/^(0|[1-9][0-9]*)$/;
 if(typeof amount!=='string'||amount.length>30||!pattern.test(amount))throw Error(`Enter a non-negative amount with at most ${digits} decimal places.`);
 const [whole,fraction='']=amount.split('.'),minor=BigInt(whole)*10n**BigInt(digits)+BigInt(fraction.padEnd(digits,'0')||'0');
 if(minor>BigInt(Number.MAX_SAFE_INTEGER))throw Error('This price is too large.');
 if(Number(minor)===row.price.value!.centAmount)throw Error('Enter a different price.');
 const {key,country,channel,customerGroup,validFrom,validUntil}=row.price;
 const price={value:{type:'centPrecision',currencyCode:row.currency,centAmount:Number(minor)},
  ...(key!==undefined&&{key}),...(country!==undefined&&{country}),
  ...(channel&&{channel:{typeId:'channel',id:channel.id}}),...(customerGroup&&{customerGroup:{typeId:'customer-group',id:customerGroup.id}}),
  ...(validFrom!==undefined&&{validFrom}),...(validUntil!==undefined&&{validUntil})};
 return {productId:product.id,version:product.version,row,newAmount:priceAmount({...row.price,value:{...row.price.value,centAmount:Number(minor)}}),
  payload:{version:product.version,actions:[{action:'changePrice',priceId,price,staged:true}]}};
}
