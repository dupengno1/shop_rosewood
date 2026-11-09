import type {Order} from './api';
import {warehouseName} from './operations-data';

type Ref={typeId?:string;id:string};
type Reservation={id:string;version:number;quantity:number;state:string;expiresAt:string;owner:Ref;lineItemId:string;
 inventoryEntry:Ref&{obj?:{id:string;sku:string;supplyChannel?:{id:string;obj?:{key?:string;name?:Record<string,string>}}}}};
export type ReservationCart={id:string;version:number;cartState?:string;lineItems:Array<Order['lineItems'][number]&{reservation?:Ref&{obj?:Reservation}}>};
export type ReservationObservation={cart?:ReservationCart;observedAt?:string;error?:string};
export type ReservationRow={id:string;sku:string;warehouse:string;warehouseId:string;ordered:number;cartLineId?:string;reservationId?:string;
 state:string;quantity:number|null;active:number|null;committed:number|null;expiresAt?:string;detail:string;includedInTotals:boolean};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
export function reservationCartPath(cartId:string):string{
 if(!uuid.test(cartId))throw new Error('The source Cart identifier is invalid.');
 return `carts/${cartId}?expand=lineItems[*].reservation.inventoryEntry.supplyChannel`;
}
export async function readOrderReservationCart(api:<T>(path:string)=>Promise<T>,order:Pick<Order,'cart'>):Promise<ReservationObservation>{
 if(!order.cart)return {};
 if(order.cart.typeId!=='cart')return {error:'The order has an invalid source Cart reference.'};
 try{
  const cart=await api<ReservationCart>(reservationCartPath(order.cart.id));
  if(cart.id!==order.cart.id||!Number.isSafeInteger(cart.version)||cart.version<1||!Array.isArray(cart.lineItems))throw new Error('The returned source Cart is invalid or does not match this order.');
  return {cart,observedAt:new Date().toISOString()};
 }catch{return {error:'The source Cart or expanded reservations could not be read. Check access and refresh; unavailable data is not zero.'};}
}
// This is a current source-Cart observation, not an inferred or immutable
// order ledger. Unknown values deliberately propagate into warehouse totals.
export function orderReservationRows(order:Pick<Order,'cart'|'lineItems'|'inventoryMode'>,observation:ReservationObservation,now=Date.now()):ReservationRow[]{
 const cart=observation.cart;
 const seen=new Set<string>();
 return (order.lineItems||[]).map(line=>{
  const row:ReservationRow={id:line.id,sku:line.variant?.sku||'Not recorded',warehouse:warehouseName(line.supplyChannel),warehouseId:line.supplyChannel?.id||'unassigned',ordered:line.quantity,state:'Not recorded',quantity:null,active:null,committed:null,detail:'No native reservation is recorded for this order item.',includedInTotals:true};
  const noReservation=()=>((line.inventoryMode||order.inventoryMode)==='None'?{...row,state:'Not applicable',includedInTotals:false,detail:'Inventory Mode is explicitly None and no native reservation is recorded. This untracked item is excluded from reservation totals.'}:row);
  const invalid=(detail:string)=>({...row,state:'Unavailable',detail});
  if(observation.error)return invalid(observation.error);
  if(!order.cart)return noReservation();
  if(!cart||cart.id!==order.cart.id)return invalid('The source Cart has not been read.');
  const byId=cart.lineItems.filter(item=>item.id===line.id);
  // Stable keys survive native Cart -> Order conversion. Never match on SKU
  // alone: the same SKU may occur in more than one fulfilment line.
  const matches=byId.length?byId:line.key&&order.lineItems.filter(item=>item.key===line.key).length===1?cart.lineItems.filter(item=>item.key===line.key):[];
  if(matches.length!==1)return invalid('The source Cart line cannot be matched unambiguously by ID or unique key.');
  const source=matches[0];row.cartLineId=source.id;
  if(source.quantity!==line.quantity||!line.variant?.sku||source.variant?.sku!==line.variant.sku||(source.supplyChannel?.id||'')!==(line.supplyChannel?.id||''))return invalid('The source Cart item quantity, SKU or warehouse differs from the order snapshot.');
  const ref=source.reservation;
  if(!ref)return noReservation();
  row.reservationId=ref.id;
  const reservation=ref.obj,inventory=reservation?.inventoryEntry?.obj;
  if(ref.typeId!=='reservation'||!reservation||reservation.id!==ref.id||seen.has(ref.id))return invalid('The native reservation is missing, duplicated or not expanded.');
  seen.add(ref.id);
  if(!integer(reservation.version)||reservation.version<1||!integer(reservation.quantity)||reservation.quantity<1||reservation.quantity!==source.quantity||reservation.owner?.typeId!=='cart'||reservation.owner.id!==cart.id||reservation.lineItemId!==source.id)return invalid('Reservation ownership, line identity or quantity could not be verified.');
  if(reservation.inventoryEntry?.typeId!=='inventory-entry'||!inventory||inventory.id!==reservation.inventoryEntry.id||inventory.sku!==line.variant.sku||(inventory.supplyChannel?.id||'')!==(line.supplyChannel?.id||''))return invalid('The expanded Inventory Entry does not match the item SKU and warehouse.');
  if(!['Created','Updated','Released','Expired','Committed'].includes(reservation.state)||!Number.isFinite(Date.parse(reservation.expiresAt))||!Number.isFinite(now))return invalid('The reservation state or expiry timestamp is invalid.');
  row.warehouse=warehouseName(inventory.supplyChannel);row.state=reservation.state;row.quantity=reservation.quantity;row.expiresAt=reservation.expiresAt;
  if(reservation.state==='Created'||reservation.state==='Updated'){
   row.committed=0;
   if(Date.parse(reservation.expiresAt)<=now){row.state='Expiry processing';row.detail='Expiry time passed. The platform has not yet confirmed release; active quantity is unknown.';}
   else{row.active=reservation.quantity;row.detail='Native active reservation observed. Available quantity is reserved; on-stock quantity is unchanged.';}
  }else{
   row.active=0;row.committed=reservation.state==='Committed'?reservation.quantity:0;
   row.detail=reservation.state==='Committed'?'Committed at order creation: stock was deducted then. This is not an active hold or the current balance after later cancellation or restocking.':'The native platform reports the reservation released; this is not an active hold.';
  }
  return row;
 });
}
export function reservationTotal(rows:ReservationRow[],field:'active'|'committed'):number|null{
 const included=rows.filter(row=>row.includedInTotals);
 if(!included.length||included.some(row=>row[field]===null))return null;
 const total=included.reduce((sum,row)=>sum+row[field]!,0);return integer(total)?total:null;
}
