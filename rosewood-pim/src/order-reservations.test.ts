import test from 'node:test';
import assert from 'node:assert/strict';
import type {Order} from './api';
import {orderReservationRows,reservationTotal,readOrderReservationCart,reservationCartPath,type ReservationCart} from './order-reservations';
const id=(n:number)=>`12345678-1234-1234-1234-${String(n).padStart(12,'0')}`;
const now=Date.parse('2026-11-09T08:00:00Z');
function fixture(){
 const line={id:id(2),key:'line-1',name:{en:'QA physical'},quantity:2,variant:{sku:'QA-SKU'},supplyChannel:{id:id(3)}};
 const order:Order={id:id(1),version:1,cart:{typeId:'cart',id:id(4)},lineItems:[line],customLineItems:[]};
 const cart:ReservationCart={id:id(4),version:2,cartState:'Ordered',lineItems:[{...structuredClone(line),reservation:{id:id(5),typeId:'reservation',obj:{id:id(5),version:1,quantity:2,state:'Created',expiresAt:'2026-11-09T08:15:00Z',owner:{id:id(4),typeId:'cart'},lineItemId:id(2),inventoryEntry:{id:id(6),typeId:'inventory-entry',obj:{id:id(6),sku:'QA-SKU',supplyChannel:{id:id(3),obj:{key:'rw-warehouse-asia'}}}}}}}]};
 return {order,cart};
}
test('native reservation lifecycle distinguishes active holds, expiry processing and consumed inventory',()=>{
 for(const [state,active,committed] of [['Created',2,0],['Updated',2,0],['Released',0,0],['Expired',0,0],['Committed',0,2]] as const){
  const {order,cart}=fixture();cart.lineItems[0].reservation!.obj!.state=state;
  const [row]=orderReservationRows(order,{cart},now);assert.equal(row.state,state);assert.equal(row.active,active);assert.equal(row.committed,committed);assert.equal(row.quantity,2);assert.equal(row.warehouse,'Asia Warehouse');
  assert.equal(reservationTotal([row],'active'),active);
 }
 const {order,cart}=fixture();const [expired]=orderReservationRows(order,{cart},now+15*60*1000);assert.equal(expired.state,'Expiry processing');assert.equal(expired.active,null);assert.equal(expired.quantity,2);assert.match(expired.detail,/not yet confirmed release/);
 cart.lineItems[0].reservation!.obj!.state='Committed';assert.equal(orderReservationRows(order,{cart},now+16*60*1000)[0].active,0);
});
test('legacy, missing and inaccessible reservations remain unknown instead of inferring quantities',async()=>{
 const {order,cart}=fixture();delete order.cart;let calls=0;const noRead=async<T>():Promise<T>=>{calls++;throw Error('must not read');};
 assert.deepEqual(await readOrderReservationCart(noRead,order),{});assert.equal(calls,0);assert.equal(orderReservationRows(order,{},now)[0].state,'Not recorded');
 order.cart={typeId:'cart',id:cart.id};delete cart.lineItems[0].reservation;
 assert.equal(orderReservationRows(order,{cart},now)[0].state,'Not recorded');assert.equal(reservationTotal(orderReservationRows(order,{cart},now),'active'),null);
 const unavailable=await readOrderReservationCart(noRead,order);assert.equal(calls,1);assert.match(unavailable.error!,/could not be read/);assert.equal(orderReservationRows(order,unavailable,now)[0].state,'Unavailable');
 assert.equal(reservationTotal([],'active'),null);
});
test('reservation ownership, line, inventory and unique-key mapping are verified before showing balances',()=>{
 const mutations:Array<(f:ReturnType<typeof fixture>)=>void>=[
  f=>{f.cart.id=id(99);},f=>{f.cart.lineItems[0].quantity=3;},f=>{f.cart.lineItems[0].variant!.sku='OTHER';},f=>{f.cart.lineItems[0].supplyChannel={id:id(99)};},
  f=>{delete f.cart.lineItems[0].reservation!.obj;},f=>{f.cart.lineItems[0].reservation!.obj!.owner.id=id(99);},f=>{f.cart.lineItems[0].reservation!.obj!.owner.typeId='order';},
  f=>{f.cart.lineItems[0].reservation!.obj!.lineItemId=id(99);},f=>{f.cart.lineItems[0].reservation!.obj!.quantity=1;},f=>{f.cart.lineItems[0].reservation!.obj!.inventoryEntry.obj!.sku='OTHER';},
  f=>{f.cart.lineItems[0].reservation!.obj!.inventoryEntry.obj!.supplyChannel!.id=id(99);},f=>{delete f.cart.lineItems[0].reservation!.obj!.inventoryEntry.obj;},
  f=>{f.cart.lineItems[0].reservation!.obj!.expiresAt='bad';},f=>{f.cart.lineItems[0].reservation!.obj!.state='Other';},
 ];
 for(const mutate of mutations){const f=fixture();mutate(f);const [row]=orderReservationRows(f.order,{cart:f.cart},now);assert.equal(row.active,null);assert.equal(row.committed,null);assert.equal(row.state,'Unavailable');}
 const f=fixture();f.order.lineItems[0].id=id(7);const [byKey]=orderReservationRows(f.order,{cart:f.cart},now);assert.equal(byKey.active,2);assert.equal(byKey.cartLineId,id(2));
 f.cart.lineItems.push({...structuredClone(f.cart.lineItems[0]),id:id(8)});assert.equal(orderReservationRows(f.order,{cart:f.cart},now)[0].state,'Unavailable');
 const other=fixture();other.order.lineItems[0].id=id(9);delete other.order.lineItems[0].key;assert.equal(orderReservationRows(other.order,{cart:other.cart},now)[0].active,null,'Matching SKU alone is insufficient');
});
test('Cart reads are bounded to the order reference and unknown values propagate into warehouse totals',async()=>{
 const {order,cart}=fixture();const requests:string[]=[];
 const result=await readOrderReservationCart(async<T>(path:string)=>{requests.push(path);return cart as T;},order);
 assert.deepEqual(requests,[reservationCartPath(cart.id)]);assert.ok(result.observedAt);assert.equal(result.cart,cart);
 const rows=orderReservationRows(order,result,now);assert.equal(reservationTotal([...rows,{...rows[0],id:id(8),active:null}],'active'),null);
 assert.equal(reservationTotal([{...rows[0],active:Number.MAX_SAFE_INTEGER},{...rows[0],active:1}],'active'),null);
 const mismatched=await readOrderReservationCart(async<T>()=>({...cart,id:id(99)}) as T,order);assert.ok(mismatched.error);
 assert.throws(()=>reservationCartPath('../other'));
 const invalid=await readOrderReservationCart(async<T>():Promise<T>=>{throw Error('Must not request');},{cart:{typeId:'customer',id:cart.id}});assert.match(invalid.error!,/invalid source Cart/);
});
test('explicit untracked items are excluded without converting missing tracked reservations to zero',()=>{
 const {order,cart}=fixture();
 const untracked={...structuredClone(order.lineItems[0]),id:id(8),key:'UNTRACKED',inventoryMode:'None'};order.lineItems.push(untracked);cart.lineItems.push(structuredClone(untracked));
 const rows=orderReservationRows(order,{cart},now);assert.equal(rows[1].state,'Not applicable');assert.equal(rows[1].active,null);assert.equal(reservationTotal(rows,'active'),2);assert.equal(reservationTotal([rows[1]],'active'),null);
 delete order.lineItems[1].inventoryMode;
 const unknown=orderReservationRows(order,{cart},now);assert.equal(unknown[1].state,'Not recorded');assert.equal(reservationTotal(unknown,'active'),null);
 order.inventoryMode='None';assert.equal(reservationTotal(orderReservationRows(order,{cart},now),'active'),2,'An observed reservation is still verified even when the saved mode differs.');
});
