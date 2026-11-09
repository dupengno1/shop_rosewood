import React, {useEffect, useState} from 'react';
import {useHistory, useLocation} from 'react-router-dom';
import {useApplicationContext} from '@commercetools-frontend/application-shell-connectors';
import {entryPointUriPathToPermissionKeys} from '@commercetools-frontend/application-config/ssr';
import {useIsAuthorized} from '@commercetools-frontend/permissions';
import {InfoMainPage} from '@commercetools-frontend/application-components';
import {ContentNotification} from '@commercetools-uikit/notifications';
import DataTable from '@commercetools-uikit/data-table';
import LoadingSpinner from '@commercetools-uikit/loading-spinner';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import TextField from '@commercetools-uikit/text-field';
import SelectField from '@commercetools-uikit/select-field';
import PrimaryButton from '@commercetools-uikit/primary-button';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import {useCommerceApi, localized, type Product, type Inventory} from './api';
import {errorMessage} from './domain';
import ProductPanel from './product-panel';
import OrderPanel from './order-panel';
import InventoryPanel from './inventory-panel';
import QualityWorkbench from './quality-workbench';
import WmsWorkflows from './wms-workflows';
import ProductOperationsWorkbench from './product-operations';
import type {QualityScan} from './quality-scan';
import {NativeLink, Notice, Section} from './shared';
import {
  applicationModule, normalizeSearch, pageFromQuery, buildListQuery, skuProductQuery,
  orderListRow, productListRow, inventoryListRow, nativeEntityUrl, verifiedInventoryLinks,
  isResourceId, readHashState, listHashState, hashLocation, PAGE_SIZE, MAX_PAGE,
  WORK_QUEUES,workQueue,wmsViewHashState,
  type ApplicationModule, type OrderListRow, type ProductListRow, type VerifiedInventoryLink,
} from './list-queries';

const titles = {oms: 'OMS · Order Fulfilment Management', wms: 'WMS · Warehouse & Inventory Management', pim: 'PIM · Product Information Management'};
const searches = {oms: 'Order number or ID (exact match)', wms: 'SKU (exact match)', pim: 'Product key, ID or SKU (exact match)'};
type ListRow = OrderListRow | ProductListRow | Inventory;

function orderAmount(price?: OrderListRow['totalPrice']): string {
  if (!price || !Number.isFinite(price.centAmount)) return '—';
  const digits = price.fractionDigits ?? 2;
  try {
    return new Intl.NumberFormat('en', {style: 'currency', currency: price.currencyCode,
      minimumFractionDigits: digits, maximumFractionDigits: digits}).format(price.centAmount / 10 ** digits);
  } catch { return '—'; }
}

function ResourceList({module, onSelect}: {module: ApplicationModule; onSelect: (value: string) => void}) {
  const api = useCommerceApi(), location = useLocation(), history = useHistory();
  const query = readHashState(location), search = query.get('q') || '', page = pageFromQuery(query.get('page'));
  const filter=workQueue(module,query.get('filter'));
  const [draft, setDraft] = React.useState(search);
  const [rows, setRows] = useState<ListRow[]>([]), [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [formError, setFormError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => { setDraft(search); setFormError(''); }, [search]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setRows([]); setHasNext(false);
    (async () => {
      try {
        const result = await api<{results: Array<Product & {key?: string}> | Inventory[] | OrderListRow[]}>(buildListQuery(module, search, page,filter));
        if (!Array.isArray(result.results)) throw new Error('The platform returned an invalid list. Refresh to retry.');
        const selected = result.results.slice(0, PAGE_SIZE);
        const mapped: ListRow[] = module === 'oms' ? (selected as OrderListRow[]).map(orderListRow) :
          module === 'pim' ? (selected as Array<Product & {key?: string}>).map(productListRow) : (selected as Inventory[]).map(inventoryListRow);
        if (active) { setRows(mapped); setHasNext(result.results.length > PAGE_SIZE); }
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [api, module, search, page, filter,reload]);

  function updateSearch() {
    try {
      const next = new URLSearchParams(), term = normalizeSearch(draft);
      if(filter!=='all')next.set('filter',filter);
      if (term) next.set('q', term);
      setFormError('');
      history.push(hashLocation(location.pathname, next));
      if (term === search && page === 0) setReload(value => value + 1);
    } catch (cause) { setFormError(errorMessage(cause)); }
  }
  function changePage(nextPage: number) {
    const next = listHashState(location,module);
    if (nextPage) next.set('page', String(nextPage)); else next.delete('page');
    history.push(hashLocation(location.pathname, next));
  }
  const columns = module === 'oms' ? [
    {key: 'order', label: 'Order No'}, {key:'store',label:'Source Store'}, {key:'customerType',label:'Customer Type'},
    {key:'warehouse',label:'Warehouse'}, {key:'delivery',label:'Delivery Method'}, {key:'payment',label:'Payment Status'},
    {key: 'state', label: 'Order / Shipment Status'},
    {key: 'amount', label: 'Order Total'}, {key: 'open', label: 'Action'},
  ] : module === 'pim' ? [
    {key: 'product', label: 'Product'}, {key: 'sku', label: 'SKU / Variants'}, {key: 'published', label: 'Published Status'},
    {key: 'quality', label: 'Quality Checks'}, {key: 'open', label: 'Action'},
  ] : [
    {key: 'sku', label: 'SKU'}, {key: 'channel', label: 'Supply Channel'}, {key: 'stock', label: 'On-stock'},
    {key: 'available', label: 'Available'}, {key: 'open', label: 'Action'},
  ];
  return <React.Fragment><Spacings.Stack scale="l">
    <form onSubmit={event => { event.preventDefault(); updateSearch(); }}>
      <Spacings.Stack scale="m">
        <SelectField name="work-queue" title="Work Queue" value={filter} options={WORK_QUEUES[module]} onChange={event=>{
          const next=listHashState(location,module);next.delete('page');
          const value=workQueue(module,String(event.target.value));
          if(value==='all')next.delete('filter');else next.set('filter',value);
          history.push(hashLocation(location.pathname,next));
        }}/>
        <TextField name="resource-search" title={searches[module]} value={draft} onChange={event => setDraft(event.target.value)}/>
        <Spacings.Inline>
          <PrimaryButton type="submit" label="Search" isDisabled={loading}/>
          <SecondaryButton label="Clear Search" isDisabled={loading || !search && !draft} onClick={() => {
            const next=listHashState(location,module);next.delete('q');next.delete('page');
            setDraft(''); setFormError(''); history.push(hashLocation(location.pathname, next));
            if (!search && page === 0) setReload(value => value + 1);
          }}/>
          <SecondaryButton label="Refresh List" isDisabled={loading} onClick={() => setReload(value => value + 1)}/>
        </Spacings.Inline>
      </Spacings.Stack>
    </form>
    <Notice error={formError || error}/>
    <Text.Detail>Native records, newest first; up to {PAGE_SIZE} records per page. {module === 'pim' ? 'Quality checks apply to this page. Open a product to review all changes.' : module === 'oms' ? 'Customer type, source store and fulfilment details come from the native order. Open an order to review customer information.' : 'Each row is one SKU / Supply Channel inventory entry.'}</Text.Detail>
    {loading ? <LoadingSpinner/> : error ? <ContentNotification type="warning">The list could not be read. Refresh to retry; current results are unknown.</ContentNotification> : rows.length ?
      <DataTable<ListRow> isCondensed rows={rows} columns={columns} itemRenderer={(row, column) => {
        if (module === 'oms') {
          const order = row as OrderListRow;
          if (column.key === 'order') return <span>{order.orderNumber || 'No order number'}<br/><small>{order.id}</small></span>;
          if (column.key === 'created') return order.createdAt?.slice(0, 10) || '—';
          if (column.key === 'store') return order.sourceStore||'Not assigned';
          if (column.key === 'customerType') return order.customerType||'Guest';
          if (column.key === 'warehouse') return order.warehouses||'Not recorded';
          if (column.key === 'delivery') return order.deliveryMethods||'Not recorded';
          if (column.key === 'payment') return order.paymentState||'Not recorded';
          if (column.key === 'state') return `${order.orderState || '—'} / ${order.shipmentState || '—'}`;
          if (column.key === 'amount') return orderAmount(order.totalPrice);
          return <SecondaryButton label="View Fulfilment" onClick={() => onSelect(order.id)}/>;
        }
        if (module === 'pim') {
          const product = row as ProductListRow;
          if (column.key === 'product') return <span>{product.name}<br/><small>{product.key || product.id}</small></span>;
          if (column.key === 'sku') return <span>{product.skus.slice(0, 3).join(' · ') || 'No SKU'}{product.skus.length > 3 ? ' …' : ''}<br/><small>{product.variantCount} variants</small></span>;
          if (column.key === 'published') return `${product.published ? 'Published' : 'Unpublished'}${product.hasStagedChanges ? ' · Staged changes' : ''}`;
          if (column.key === 'quality') return product.errorCount || product.warningCount ? `${product.errorCount} blocking issues · ${product.warningCount} warnings` : 'Checks passed';
          return <SecondaryButton label="Quality & Publishing" onClick={() => onSelect(product.id)}/>;
        }
        const entry = row as Inventory;
        if (column.key === 'sku') return entry.sku;
        if (column.key === 'channel') return entry.supplyChannel?.obj?.key || (entry.supplyChannel?.obj?.name ? localized(entry.supplyChannel.obj.name) : entry.supplyChannel?.id) || 'No Supply Channel';
        if (column.key === 'stock') return entry.quantityOnStock;
        if (column.key === 'available') return entry.availableQuantity;
        return <SecondaryButton label="Manage SKU" onClick={() => onSelect(entry.sku)}/>;
      }}/> : <ContentNotification type="info">{page > 0 ? 'No records on this page. Return to the previous page or search again.' : search ? 'No exact match. Check the identifier and selected work queue.' : filter!=='all' ? 'No matching records in this queue.' : 'There are no records of this type in the project.'}</ContentNotification>}
    <Spacings.Inline>
      <SecondaryButton label="Previous" isDisabled={loading || page === 0} onClick={() => changePage(page - 1)}/>
      <Text.Body>Page {page + 1}{!loading && !error ? ` · ${rows.length} records` : ''}</Text.Body>
      <SecondaryButton label="Next" isDisabled={loading || Boolean(error) || !hasNext || page >= MAX_PAGE} onClick={() => changePage(page + 1)}/>
    </Spacings.Inline>
    {page >= MAX_PAGE && <ContentNotification type="info">The platform page limit has been reached. Use an exact identifier to narrow the search.</ContentNotification>}
  </Spacings.Stack></React.Fragment>;
}

function VerifiedProductInventoryLinks({sku, project}: {sku: string; project: string}) {
  const api = useCommerceApi();
  const [links, setLinks] = React.useState<VerifiedInventoryLink[]>([]), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setLinks([]);
    (async () => {
      try {
        const result = await api<{results: Product[]}>(skuProductQuery(sku));
        if (!Array.isArray(result.results)) throw new Error('The product lookup returned an invalid response.');
        const found = verifiedInventoryLinks(result.results, sku, project, window.location.origin);
        if (active) setLinks(found);
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [api, sku, project, retry]);
  return <React.Fragment>{loading ? <Text.Detail>Checking the native product and variant for this SKU…</Text.Detail> : error ?
    <Spacings.Stack scale="s"><Notice error={`Product lookup failed: ${error}`}/><SecondaryButton label="Retry product lookup" onClick={() => setRetry(value => value + 1)}/></Spacings.Stack> :
    links.length ? <Spacings.Stack scale="s">{links.map(link => <NativeLink key={link.id} url={link.url} label={link.label}/>)}</Spacings.Stack> :
    <Text.Detail>No native product variant was found for this SKU. Inventory can exist independently of a product.</Text.Detail>}</React.Fragment>;
}

function ApplicationWorkspace({module, project, canManage}: {module: ApplicationModule; project: string; canManage: boolean}) {
  const location = useLocation(), history = useHistory();
  const [qualitySnapshot,setQualitySnapshot]=useState<QualityScan>({checked:0,rows:[],complete:false,limited:false});
  const query = readHashState(location);
  const selected = query.get(module === 'wms' ? 'sku' : 'record') || '';
  const wmsView=query.get('view')==='products'?'products':query.get('view')==='transfer'?'transfer':query.get('view')==='count'?'count':'inventory';
  const wmsTabs=module==='wms'?<Spacings.Inline>{([
    ['products','Product Operations'],['inventory','Inventory'],['transfer','Stock Transfers'],['count','Stock Counts'],
  ] as const).map(([view,label])=><SecondaryButton key={view} label={label} isDisabled={wmsView===view} onClick={()=>{
    const next=wmsViewHashState(location,view);
    history.push(hashLocation(location.pathname,next));
  }}/>)}</Spacings.Inline>:null;
  function back() { history.push(hashLocation(location.pathname, listHashState(location,module))); }
  function select(value: string) {
    const next = listHashState(location,module);
    next.set(module === 'wms' ? 'sku' : 'record', value);
    history.push(hashLocation(location.pathname, next));
  }
  if(module==='wms'&&wmsView==='products')return <Spacings.Stack scale="l">{wmsTabs}<ProductOperationsWorkbench project={project}/></Spacings.Stack>;
  if(module==='wms'&&(wmsView==='transfer'||wmsView==='count'))return <Spacings.Stack scale="l">{wmsTabs}<WmsWorkflows key={wmsView} canManage={canManage} mode={wmsView}/></Spacings.Stack>;
  if (!selected) return <Spacings.Stack scale="l">{wmsTabs}{module==='pim'&&<Spacings.Inline>
    <SecondaryButton label="Product List" isDisabled={query.get('view')!=='quality'} onClick={()=>{const next=listHashState(location,module);next.delete('view');history.push(hashLocation(location.pathname,next));}}/>
    <SecondaryButton label="Catalog Quality" isDisabled={query.get('view')==='quality'} onClick={()=>{const next=listHashState(location,module);next.set('view','quality');next.delete('page');history.push(hashLocation(location.pathname,next));}}/>
  </Spacings.Inline>}{module==='pim'&&query.get('view')==='quality'?<QualityWorkbench canManage={canManage} onSelect={select} snapshot={qualitySnapshot} onSnapshot={setQualitySnapshot}/>:<ResourceList module={module} onSelect={select}/>}</Spacings.Stack>;
  let valid = true;
  try { valid = module === 'wms' ? normalizeSearch(selected) === selected : isResourceId(selected); }
  catch { valid = false; }
  return <React.Fragment><Spacings.Stack scale="l">
    {wmsTabs}
    <Spacings.Inline><SecondaryButton label="Back to List" onClick={back}/></Spacings.Inline>
    {!valid ? <ContentNotification type="error">The resource identifier is invalid. Return to the list and select it again.</ContentNotification> : module === 'oms' ?
      <OrderPanel key={selected} id={selected} canManage={canManage} nativeUrl={nativeEntityUrl(project, 'orders', selected, window.location.origin)}/> : module === 'pim' ?
      <ProductPanel key={selected} id={selected} canManage={canManage} nativeUrl={nativeEntityUrl(project, 'products', selected, window.location.origin)} mode="pim"/> :
      <Section title={`SKU · ${selected}`}>
        <VerifiedProductInventoryLinks sku={selected} project={project}/>
        <InventoryPanel key={selected} sku={selected} canManage={canManage}/>
      </Section>}
  </Spacings.Stack></React.Fragment>;
}

export default function ApplicationRoutes() {
  const {project, entryPoint} = useApplicationContext(context => ({
    project: context.project?.key,
    entryPoint: context.environment.entryPointUriPath || '',
  }));
  const permissions = entryPointUriPathToPermissionKeys(entryPoint || 'unknown-application');
  const canView = useIsAuthorized({demandedPermissions: [permissions.View]});
  const canManage = useIsAuthorized({demandedPermissions: [permissions.Manage]});
  const module = applicationModule(entryPoint);
  return <React.Fragment><InfoMainPage title={module ? titles[module] : 'Operations'}
    subtitle={project ? `Project: ${project} · Live commercetools data, using your Merchant Center permissions.` : undefined}>
    <Spacings.Stack scale="l">
      {!module || !project ? <ContentNotification type="error">The application or project context is unavailable. Reopen OMS or WMS from the Merchant Center menu.</ContentNotification> :
        !canView ? <ContentNotification type="error">Your team does not have View permission for this application. Contact your Merchant Center administrator.</ContentNotification> : <React.Fragment>
          {!canManage && <ContentNotification type="info">Read-only access. Saving requires View and edit permission for this application.</ContentNotification>}
          <ApplicationWorkspace key={`${project}/${entryPoint}`} module={module} project={project} canManage={canManage}/>
        </React.Fragment>}
    </Spacings.Stack>
  </InfoMainPage></React.Fragment>;
}
