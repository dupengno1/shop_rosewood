import test from 'node:test';
import assert from 'node:assert/strict';
import type {Product,EmbeddedPrice} from './api';
import {planPriceChange,priceAmount,priceEditIssue,productPriceRows} from './price-management';
const price:EmbeddedPrice={id:'price-hk',key:'retail-hk',value:{type:'centPrecision',currencyCode:'HKD',centAmount:1001,fractionDigits:2},country:'HK',channel:{id:'hk-channel',obj:{key:'rw-dist-hk'}},customerGroup:{id:'b2b-group'},validFrom:'2026-01-01T00:00:00Z',validUntil:'2027-01-01T00:00:00Z'};
const data={name:{en:'Shared product'},masterVariant:{id:1,sku:'SHARED',prices:[price]},variants:[]};
const product:Product={id:'product',version:9,priceMode:'Embedded',masterData:{current:data,staged:data,published:true,hasStagedChanges:true}};
test('staged price change preserves every supported scope and uses exact decimal-to-minor conversion',()=>{
 const plan=planPriceChange(product,1,'price-hk','19.99');
 assert.equal(plan.version,9);assert.equal(plan.newAmount,'19.99');assert.deepEqual(plan.payload,{version:9,actions:[{action:'changePrice',priceId:'price-hk',staged:true,price:{key:'retail-hk',value:{type:'centPrecision',currencyCode:'HKD',centAmount:1999},country:'HK',channel:{typeId:'channel',id:'hk-channel'},customerGroup:{typeId:'customer-group',id:'b2b-group'},validFrom:price.validFrom,validUntil:price.validUntil}}]});
 assert.equal(price.value!.centAmount,1001);assert.equal(plan.payload.actions.length,1);assert.equal(productPriceRows(product)[0].channel,'rw-dist-hk');
});
test('prices reject invalid precision, unsafe amounts, no-op updates, wrong source and unsupported dimensions',()=>{
 for(const value of ['1.999','-1','1e3',' 1','01','900719925474099.12','10.01'])assert.throws(()=>planPriceChange(product,1,'price-hk',value));
 assert.throws(()=>planPriceChange({...product,priceMode:'Standalone'},1,'price-hk','1'),/Standalone/);
 assert.throws(()=>planPriceChange(product,2,'price-hk','1'),/changed/);
 for(const complex of [{custom:{fields:{x:true}}},{tiers:[]},{recurrencePolicy:{id:'recurrence'}},{discounted:{value:{centAmount:10}}},{newFutureScope:'preserve-me'}])assert.ok(priceEditIssue({...price,...complex}));
 assert.ok(priceEditIssue({...price,value:{...price.value,type:'highPrecision'}}));
});
test('zero- and three-decimal currency prices are handled without two-decimal assumptions',()=>{
 const withMoney=(currencyCode:string,fractionDigits:number,centAmount:number):Product=>({...product,masterData:{...product.masterData,staged:{...data,masterVariant:{...data.masterVariant,prices:[{...price,value:{type:'centPrecision',currencyCode,fractionDigits,centAmount}}]}}}});
 assert.equal(planPriceChange(withMoney('JPY',0,5),1,'price-hk','19').payload.actions[0].price.value.centAmount,19);
 assert.throws(()=>planPriceChange(withMoney('JPY',0,5),1,'price-hk','19.1'));
 assert.equal(planPriceChange(withMoney('KWD',3,1234),1,'price-hk','0.001').payload.actions[0].price.value.centAmount,1);
 assert.equal(priceAmount({value:{type:'centPrecision',currencyCode:'KWD',fractionDigits:3,centAmount:1}}),'0.001');
});
