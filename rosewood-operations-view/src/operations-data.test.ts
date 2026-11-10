import test from 'node:test';
import assert from 'node:assert/strict';
import type {Order,Inventory,Product} from './api';
import {inventorySummary,warehouseName,orderConsignments,sourceStore,productOperationalData,orderPaymentMethods,orderDeliveryMethods,isSimulatedPaymentSelection,lineFulfilmentWarehouse,DIGITAL_DELIVERY,PRIMARY_WAREHOUSE_ATTRIBUTE} from './operations-data';
const entry=(stock:number,available:number,key='rw-warehouse-asia'):Inventory=>({id:key,version:1,sku:'SKU',quantityOnStock:stock,availableQuantity:available,supplyChannel:{id:key,obj:{key}}});
test('warehouse inventory distinguishes absent and incomplete observations from zero and negative availability',()=>{
 assert.equal(inventorySummary([]).status,'Unknown');assert.equal(inventorySummary([entry(10,5)],false).available,null);
 assert.deepEqual(inventorySummary([entry(10,5),entry(20,17)]),{available:22,reserved:8,onStock:30,status:'In Stock'});
 assert.equal(inventorySummary([entry(0,0)]).status,'Out of Stock');assert.equal(inventorySummary([entry(2,2)]).status,'Low Stock');
 assert.equal(inventorySummary([entry(0,-2)]).available,-2);assert.equal(inventorySummary([entry(1,2)]).reserved,null);
 assert.equal(inventorySummary([entry(Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),entry(10,10)]).status,'Unknown');
});
test('configured metadata identifies primary warehouse without inventing stock or catalog membership',()=>{
 const data={name:{en:'', 'zh-TW':'已核實商品'},masterVariant:{id:1,sku:'SKU',attributes:[{name:'rwProductInfo',value:JSON.stringify({kind:'physical',fulfillment:{primaryWarehouse:'warehouse-eu',fallbackWarehouse:'warehouse-asia',strategy:'Nearest Available Warehouse'}})}]},variants:[]};
 const product:Product={id:'product',key:'KEY',version:1,masterData:{current:data,staged:data,published:true,hasStagedChanges:false}};
 const row=productOperationalData(product,[]);assert.equal(row.name,'已核實商品');assert.equal(row.primaryWarehouse,'EMEA Warehouse');assert.equal(row.summary.status,'Unknown');assert.equal(row.summary.available,null);
 assert.equal(warehouseName({id:'uuid-without-expanded-name'}),'uuid-without-expanded-name');
 const partial={...product,masterData:{...product.masterData,staged:{...data,variants:[{id:2,sku:'MISSING'}]}}};
 assert.equal(productOperationalData(partial,[entry(10,7)]).summary.available,null);
 assert.equal(productOperationalData(product,[entry(10,7)]).summary.available,7);
});
test('order presentation uses saved shop and channels and never assumes order-specific reservations',()=>{
 const order:Order={id:'ORDER',version:1,store:{key:'rosewood-hk'},inventoryMode:'ReserveOnOrder',lineItems:[{id:'one',name:{en:'Robe'},quantity:2,supplyChannel:{id:'us',obj:{key:'rw-warehouse-us'}},variant:{sku:'ROBE'},custom:{type:{id:'type'},fields:{rwFulfillmentType:'physical'}}},{id:'two',name:{en:'Gift Card'},quantity:1,variant:{sku:'GIFT'},custom:{type:{id:'type'},fields:{rwFulfillmentType:'digital'}}}],customLineItems:[],paymentInfo:{payments:[{id:'pay',obj:{paymentMethodInfo:{method:'wechat'}}}]},shippingInfo:{shippingMethodName:'collection',deliveries:[]}};
 assert.equal(sourceStore(order),'HK Store');assert.equal(sourceStore({}),'Not assigned');
 const groups=orderConsignments(order);assert.equal(groups.length,2);assert.equal(groups[0].warehouse,'Americas Warehouse');assert.equal(groups[0].nativeReserved,null);assert.equal(groups[1].warehouse,'Digital Delivery');
 assert.deepEqual(orderPaymentMethods(order),['WeChat Pay']);assert.deepEqual(orderDeliveryMethods(order),['Hotel Collection']);
 assert.equal(orderConsignments({...order,lineItems:[{...order.lineItems[0],quantity:NaN}]}).length,0);
});
test('native checkout simulation metadata labels the selected method without replacing native payment state or inventing a method',()=>{
 const order:Order={id:'order',version:1,lineItems:[],customLineItems:[],paymentState:'Pending',custom:{fields:{rwPaymentMethod:'unionpay',rwPaymentStatus:'simulated-approved'}}};
 assert.deepEqual(orderPaymentMethods(order),['UnionPay (simulated selection)']);
 assert.equal(isSimulatedPaymentSelection(order),true);assert.equal(order.paymentState,'Pending');
 assert.deepEqual(orderPaymentMethods({...order,custom:{fields:{rwPaymentStatus:'simulated-approved'}}}),[]);
 assert.deepEqual(orderPaymentMethods({...order,custom:{fields:{rwPaymentMethod:'wechat'}}}),['WeChat Pay']);
 assert.deepEqual(orderPaymentMethods({...order,paymentState:'Paid',paymentInfo:{payments:[{id:'native-payment',obj:{paymentMethodInfo:{method:'card'}}}]}}),['Credit Card','UnionPay (simulated selection)']);
});
test('all-digital saved order snapshots supply an explicitly classified delivery category when no native method exists',()=>{
 const order:Order={id:'digital-order',version:1,lineItems:[{id:'gift',name:{en:'Gift'},quantity:1,variant:{sku:'GIFT',attributes:[{name:'rwProductInfo',value:JSON.stringify({kind:'digital'})}]}}],customLineItems:[]};
 assert.deepEqual(orderDeliveryMethods(order),['Digital Delivery (item classification)']);
 assert.deepEqual(orderDeliveryMethods({...order,custom:{fields:{rwDeliveryMethod:' '}}}),['Digital Delivery (item classification)']);
 assert.deepEqual(orderDeliveryMethods({...order,lineItems:[],customLineItems:[{id:'custom-gift',name:{en:'Gift'},quantity:1,custom:{type:{id:'type'},fields:{rwFulfillmentType:'digital'}}}]}),['Digital Delivery (item classification)']);
});
test('recorded delivery methods take precedence and incomplete or mixed orders never imply digital delivery',()=>{
 const digital={id:'digital',name:{en:'Gift'},quantity:1,variant:{sku:'DIGITAL-NAME-IS-NOT-EVIDENCE'},custom:{type:{id:'type'},fields:{rwFulfillmentType:'digital'}}};
 const order:Order={id:'order',version:1,lineItems:[digital],customLineItems:[]};
 assert.deepEqual(orderDeliveryMethods({...order,shippingInfo:{shippingMethodName:'Hotel Collection',deliveries:[]}}),['Hotel Collection']);
 assert.deepEqual(orderDeliveryMethods({...order,custom:{fields:{rwDeliveryMethod:'email'}}}),['Digital Delivery']);
 assert.deepEqual(orderDeliveryMethods({...order,lineItems:[]}),[]);
 for(const type of ['physical','service','unexpected'])assert.deepEqual(orderDeliveryMethods({...order,lineItems:[digital,{...digital,id:'other',custom:{type:{id:'type'},fields:{rwFulfillmentType:type}}}]}),[]);
 assert.deepEqual(orderDeliveryMethods({...order,lineItems:[{...digital,custom:undefined}],inventoryMode:'None'}),[]);
 assert.deepEqual(orderDeliveryMethods({...order,lineItems:[{...digital,quantity:0}]}),[]);
 for(const value of [{kind:'digital'},JSON.stringify({kind:{key:'digital',label:'Digital'}}),'not-json'])assert.deepEqual(orderDeliveryMethods({...order,lineItems:[{...digital,custom:undefined,variant:{attributes:[{name:'rwProductInfo',value}]}}]}),[]);
 assert.deepEqual(orderDeliveryMethods({...order,lineItems:[{...digital,custom:{type:{id:'type'},fields:{rwFulfillmentType:{key:'digital',label:'Digital'}}}}]}),[]);
 assert.deepEqual(orderDeliveryMethods({...order,customLineItems:[{id:'unknown-custom',name:{en:'Unclassified'},quantity:1}]}),[]);
});

test('fulfilment warehouse labels the configured primary, native mirror, digital delivery and each order item consistently',()=>{
 const info=(value:Record<string,unknown>)=>[{name:'rwProductInfo',value:JSON.stringify(value)}];
 const data=(attributes:{name:string;value:unknown}[],productAttributes?:{name:string;value:unknown}[])=>({name:{en:'QA'},masterVariant:{id:1,sku:'SKU',attributes},variants:[{id:2,sku:'SKU-2'}],...(productAttributes&&{attributes:productAttributes})});
 const product=(staged:ReturnType<typeof data>):Product=>({id:'p',key:'p',version:1,masterData:{current:staged,staged,published:true,hasStagedChanges:false}});
 for(const [key,label] of [['warehouse-asia','Asia Warehouse'],['warehouse-eu','EMEA Warehouse'],['warehouse-us','Americas Warehouse'],['warehouse-hk','Hong Kong Warehouse']]){
  const row=productOperationalData(product(data(info({kind:'physical',fulfillment:{primaryWarehouse:key,strategy:'primary-only',fallbackWarehouse:null}}),[{name:PRIMARY_WAREHOUSE_ATTRIBUTE,value:{key,label}}])),[]);
  assert.equal(row.primaryWarehouse,label);assert.equal(row.nativePrimaryWarehouse,label);assert.equal(row.primaryWarehouseMismatch,false);assert.equal(row.strategy,'Primary warehouse only');assert.equal(row.fallbackWarehouse,'Not configured');
 }
 const digital=productOperationalData(product(data(info({kind:'digital',fulfillment:{primaryWarehouse:null,strategy:'digital'}}))),[]);
 assert.deepEqual([digital.primaryWarehouse,digital.strategy,digital.fallbackWarehouse,digital.nativePrimaryWarehouse],[DIGITAL_DELIVERY,'Digital delivery','Not applicable',null]);
 const drift=productOperationalData(product(data(info({kind:'physical',fulfillment:{primaryWarehouse:'warehouse-eu'}}),[{name:PRIMARY_WAREHOUSE_ATTRIBUTE,value:{key:'warehouse-us',label:'Americas Warehouse'}}])),[]);
 assert.equal(drift.primaryWarehouse,'EMEA Warehouse','storefront allocation config stays authoritative');assert.equal(drift.primaryWarehouseMismatch,true);
 assert.equal(productOperationalData(product(data([])),[]).primaryWarehouse,'Not configured');
 const snapshot=info({kind:'physical',fulfillment:{primaryWarehouse:'warehouse-us'}});
 assert.equal(lineFulfilmentWarehouse({supplyChannel:{id:'c',obj:{key:'rw-warehouse-hk'}},variant:{attributes:snapshot}},false),'Hong Kong Warehouse');
 assert.equal(lineFulfilmentWarehouse({variant:{attributes:snapshot}},false),'Americas Warehouse (configured; not allocated)');
 assert.equal(lineFulfilmentWarehouse({},false),'Unassigned warehouse');assert.equal(lineFulfilmentWarehouse({supplyChannel:{id:'c'}},true),DIGITAL_DELIVERY);
 const order:Order={id:'O',version:1,lineItems:[{id:'robe',name:{en:'RW Robe'},quantity:1,supplyChannel:{id:'us',obj:{key:'rw-warehouse-us'}},variant:{sku:'R',attributes:snapshot}},{id:'card',name:{en:'E-Gift Card'},quantity:1,variant:{sku:'G',attributes:info({kind:'digital'})}}],customLineItems:[]};
 assert.deepEqual(orderConsignments(order).map(group=>[group.warehouse,group.lines.map(line=>line.fulfilmentWarehouse)]),[['Americas Warehouse',['Americas Warehouse']],[DIGITAL_DELIVERY,[DIGITAL_DELIVERY]]]);
});

