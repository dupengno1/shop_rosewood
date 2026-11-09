import test from 'node:test';
import assert from 'node:assert/strict';
import type {Order,Inventory,Product} from './api';
import {inventorySummary,warehouseName,orderConsignments,sourceStore,productOperationalData,orderPaymentMethods,orderDeliveryMethods} from './operations-data';
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
