import {localized} from './domain';

type Attribute={name:string;value?:unknown};
type Channel={id?:string;key?:string;obj?:{key?:string;name?:Record<string,string>}};

export const PRIMARY_WAREHOUSE_ATTRIBUTE='primaryFulfilmentWarehouse';
export const DIGITAL_DELIVERY='Digital Delivery';
// Supply Channel keys (rw-*) and the storefront's warehouse keys share these names.
export const warehouseNames:Record<string,string>={
  'rw-warehouse-asia':'Asia Warehouse','warehouse-asia':'Asia Warehouse',
  'rw-warehouse-eu':'EMEA Warehouse','warehouse-eu':'EMEA Warehouse',
  'rw-warehouse-us':'Americas Warehouse','warehouse-us':'Americas Warehouse',
  'rw-warehouse-hk':'Hong Kong Warehouse','warehouse-hk':'Hong Kong Warehouse',
};
export const warehouseName=(channel?:Channel):string=>{
  if(!channel)return 'Unassigned warehouse';
  const key=channel.obj?.key||channel.key;
  return (key&&warehouseNames[key])||localized(channel.obj?.name)||key||channel.id||'Unassigned warehouse';
};
export const fulfilmentWarehouseLabel=(key:string):string=>key==='digital'?DIGITAL_DELIVERY:warehouseNames[key]||key;

export function productInfo(attributes?:Attribute[]):Record<string,unknown>{
  const value=attributes?.find(attribute=>attribute.name==='rwProductInfo')?.value;
  if(typeof value!=='string')return {};
  try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}
}

export type PrimaryWarehouse={key:string|null;label:string};
// rwProductInfo is the storefront's allocation contract; it decides where stock is reserved.
export function configuredPrimaryWarehouse(attributes?:Attribute[]):PrimaryWarehouse{
  const info=productInfo(attributes);
  if(info.kind==='digital')return {key:'digital',label:DIGITAL_DELIVERY};
  const fulfillment=info.fulfillment&&typeof info.fulfillment==='object'?info.fulfillment as Record<string,unknown>:{};
  const key=typeof fulfillment.primaryWarehouse==='string'&&fulfillment.primaryWarehouse?fulfillment.primaryWarehouse:null;
  return key?{key,label:fulfilmentWarehouseLabel(key)}:{key:null,label:'Not configured'};
}
// The native Product-level enum attribute shown on the Merchant Center product page.
export function nativePrimaryWarehouse(attributes?:Attribute[]):PrimaryWarehouse|null{
  const value=attributes?.find(attribute=>attribute.name===PRIMARY_WAREHOUSE_ATTRIBUTE)?.value;
  const key=typeof value==='string'?value:value&&typeof value==='object'&&typeof (value as {key?:unknown}).key==='string'?(value as {key:string}).key:null;
  return key?{key,label:fulfilmentWarehouseLabel(key)}:null;
}

// An order item ships from its allocated Supply Channel. Without one, the
// primary warehouse saved with the checkout snapshot is shown as configured only.
export function lineFulfilmentWarehouse(line:{supplyChannel?:Channel;variant?:{attributes?:Attribute[]}},digital:boolean):string{
  if(digital)return DIGITAL_DELIVERY;
  if(line.supplyChannel)return warehouseName(line.supplyChannel);
  const configured=configuredPrimaryWarehouse(line.variant?.attributes);
  return configured.key?`${configured.label} (configured; not allocated)`:'Unassigned warehouse';
}
