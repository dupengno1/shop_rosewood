import DataTable from '@commercetools-uikit/data-table';
import Text from '@commercetools-uikit/text';
import type {Order} from './api';
import {sourceStore,orderPaymentMethods,orderDeliveryMethods} from './operations-data';
import {Section} from './shared';
import {formatOmsMoney} from './oms-money';
export function OrderInformation({order}:{order:Order}){
 const address=order.shippingAddress||order.billingAddress;
 const rows=[['Order Number',order.orderNumber||order.id],['Source Store',sourceStore(order)],['Customer Name',[address?.firstName,address?.lastName].filter(Boolean).join(' ')||'Not recorded'],['Customer Email',order.customerEmail||'Not recorded'],['Customer Type',order.customerId?'Registered':'Guest'],['Payment Method',orderPaymentMethods(order).join(' / ')||'Not recorded'],['Payment Status',order.paymentState||'Not recorded'],['Order Total',order.totalPrice?formatOmsMoney(order.totalPrice.centAmount,order.totalPrice.currencyCode,order.totalPrice.fractionDigits??2):'Not recorded'],['Delivery Method',orderDeliveryMethods(order).join(' / ')||'Not recorded']].map(([id,value])=>({id,value}));
 return <Section title="Order Information"><DataTable isCondensed rows={rows} columns={[{key:'id',label:'Field'},{key:'value',label:'Value'}]} itemRenderer={(row,column)=>row[column.key as 'id'|'value']}/><Text.Detail>These details reflect the information recorded on this order.</Text.Detail></Section>;
}
