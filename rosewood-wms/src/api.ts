import {useCallback} from 'react';
import {useAsyncDispatch, actions} from '@commercetools-frontend/sdk';
import {MC_API_PROXY_TARGETS} from '@commercetools-frontend/constants';
import {useApplicationContext} from '@commercetools-frontend/application-shell-connectors';
import {validateCommerceRequest} from './api-policy';

export function useCommerceApi() {
  const dispatch = useAsyncDispatch();
  const projectKey = useApplicationContext(context => context.project?.key);
  return useCallback(async <T,>(path: string, payload?: unknown): Promise<T> => {
    if (!projectKey) throw new Error('Merchant Center project context is unavailable. Reopen this page.');
    validateCommerceRequest(path,payload);
    const request = {mcApiProxyTarget: MC_API_PROXY_TARGETS.COMMERCETOOLS_PLATFORM,
      uri: `/${encodeURIComponent(projectKey)}/${path}`};
    return await dispatch(payload === undefined ? actions.get(request) : actions.post({...request, payload})) as T;
  }, [dispatch, projectKey]);
}

export type Localized = Record<string, string>;
export type Variant = {id:number;sku?:string;images?:{url:string}[];prices?:{value?:{centAmount?:number;currencyCode?:string}}[];attributes?:{name:string;value:unknown}[]};
export type ProductData = {name?:Localized;description?:Localized;masterVariant:Variant;variants:Variant[];[key:string]:unknown};
export type Product = {id:string;version:number;priceMode?:string;masterData:{current:ProductData;staged:ProductData;hasStagedChanges:boolean;published:boolean}};
export type Parcel = {id:string;trackingData?:{trackingId?:string;carrier?:string};items?:{id:string;quantity:number}[]};
export type Delivery = {id:string;key?:string;createdAt?:string;items:{id:string;quantity:number}[];parcels:Parcel[]};
export type Order = {id:string;version:number;orderNumber?:string;orderState?:string;shippingMode?:string;inventoryMode?:string;
  totalPrice?:{centAmount:number;currencyCode:string;fractionDigits?:number};
  returnInfo?:{items:{id?:string;key?:string;lineItemId?:string;customLineItemId?:string;quantity:number;shipmentState?:string;paymentState?:string}[]}[];
  lineItems:{id:string;key?:string;name:Localized;quantity:number;inventoryMode?:string;supplyChannel?:{id:string};distributionChannel?:{id:string};variant?:{sku?:string;attributes?:{name:string;value:unknown}[]};custom?:{type:{id:string};fields:Record<string,unknown>}}[];
  customLineItems:{id:string;key?:string;name:Localized;quantity:number;custom?:{type:{id:string};fields:Record<string,unknown>}}[];
  shippingInfo?:{deliveries:Delivery[]};shipping?:{shippingKey:string;shippingInfo?:{deliveries:Delivery[]}}[]};
export type Inventory = {id:string;version:number;sku:string;quantityOnStock:number;availableQuantity:number;
  custom?:{type:{id:string};fields:Record<string,unknown>};
  supplyChannel?:{id:string;obj?:{key?:string;name?:Localized}}};
export const localized = (value?:Localized) => value?.['zh-CN'] || value?.en || Object.values(value || {})[0] || '—';
