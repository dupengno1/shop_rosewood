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
import type {QualityScan} from './quality-scan';
import {NativeLink, Notice, Section} from './shared';
import {
  applicationModule, normalizeSearch, pageFromQuery, buildListQuery, skuProductQuery,
  orderListRow, productListRow, inventoryListRow, nativeEntityUrl, verifiedInventoryLinks,
  isResourceId, readHashState, listHashState, hashLocation, PAGE_SIZE, MAX_PAGE,
  WORK_QUEUES,workQueue,wmsViewHashState,
  type ApplicationModule, type OrderListRow, type ProductListRow, type VerifiedInventoryLink,
} from './list-queries';

const titles = {oms: 'OMS · 订单履约管理', wms: 'WMS · 多仓库存管理', pim: 'PIM · 商品信息管理'};
const searches = {oms: '订单号或订单 ID（精确匹配）', wms: 'SKU（精确匹配）', pim: '商品 key、ID 或 SKU（精确匹配）'};
type ListRow = OrderListRow | ProductListRow | Inventory;

function orderAmount(price?: OrderListRow['totalPrice']): string {
  if (!price || !Number.isFinite(price.centAmount)) return '—';
  const digits = price.fractionDigits ?? 2;
  try {
    return new Intl.NumberFormat('zh-CN', {style: 'currency', currency: price.currencyCode,
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
        if (!Array.isArray(result.results)) throw new Error('平台未返回有效列表，请重新读取。');
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
    {key: 'order', label: '订单'}, {key: 'created', label: '创建日期'}, {key: 'state', label: '订单 / 发运状态'},
    {key: 'amount', label: '原生订单总额'}, {key: 'open', label: '操作'},
  ] : module === 'pim' ? [
    {key: 'product', label: '商品'}, {key: 'sku', label: 'SKU / 变体'}, {key: 'published', label: '发布状态'},
    {key: 'quality', label: '当前检查'}, {key: 'open', label: '操作'},
  ] : [
    {key: 'sku', label: 'SKU'}, {key: 'channel', label: 'Supply Channel'}, {key: 'stock', label: '在库量'},
    {key: 'available', label: '可用量'}, {key: 'open', label: '操作'},
  ];
  return <React.Fragment><Spacings.Stack scale="l">
    <form onSubmit={event => { event.preventDefault(); updateSearch(); }}>
      <Spacings.Stack scale="m">
        <SelectField name="work-queue" title="运营队列" value={filter} options={WORK_QUEUES[module]} onChange={event=>{
          const next=listHashState(location,module);next.delete('page');
          const value=workQueue(module,String(event.target.value));
          if(value==='all')next.delete('filter');else next.set('filter',value);
          history.push(hashLocation(location.pathname,next));
        }}/>
        <TextField name="resource-search" title={searches[module]} value={draft} onChange={event => setDraft(event.target.value)}/>
        <Spacings.Inline>
          <PrimaryButton type="submit" label="搜索" isDisabled={loading}/>
          <SecondaryButton label="清除搜索" isDisabled={loading || !search && !draft} onClick={() => {
            const next=listHashState(location,module);next.delete('q');next.delete('page');
            setDraft(''); setFormError(''); history.push(hashLocation(location.pathname, next));
            if (!search && page === 0) setReload(value => value + 1);
          }}/>
          <SecondaryButton label="刷新列表" isDisabled={loading} onClick={() => setReload(value => value + 1)}/>
        </Spacings.Inline>
      </Spacings.Stack>
    </form>
    <Notice error={formError || error}/>
    <Text.Detail>按创建时间倒序读取 commercetools 原生数据，每页最多 {PAGE_SIZE} 条。{module === 'pim' ? '质量提示仅针对当前页商品；选择商品后可核对完整差异。' : module === 'oms' ? '列表不展示买家姓名、邮箱或收货地址。发运队列依据平台 shipmentState，实际待发数量请进入订单核对。' : '一行对应一个 SKU / Supply Channel 库存记录。'}</Text.Detail>
    {loading ? <LoadingSpinner/> : error ? <ContentNotification type="warning">列表读取失败，当前结果未知。请点击“刷新列表”重试。</ContentNotification> : rows.length ?
      <DataTable<ListRow> isCondensed rows={rows} columns={columns} itemRenderer={(row, column) => {
        if (module === 'oms') {
          const order = row as OrderListRow;
          if (column.key === 'order') return <span>{order.orderNumber || '未设置订单号'}<br/><small>{order.id}</small></span>;
          if (column.key === 'created') return order.createdAt?.slice(0, 10) || '—';
          if (column.key === 'state') return `${order.orderState || '—'} / ${order.shipmentState || '—'}`;
          if (column.key === 'amount') return orderAmount(order.totalPrice);
          return <SecondaryButton label="查看履约" onClick={() => onSelect(order.id)}/>;
        }
        if (module === 'pim') {
          const product = row as ProductListRow;
          if (column.key === 'product') return <span>{product.name}<br/><small>{product.key || product.id}</small></span>;
          if (column.key === 'sku') return <span>{product.skus.slice(0, 3).join(' · ') || '无 SKU'}{product.skus.length > 3 ? ' …' : ''}<br/><small>{product.variantCount} 个变体</small></span>;
          if (column.key === 'published') return `${product.published ? '已发布' : '未发布'}${product.hasStagedChanges ? ' · 有待发布修改' : ''}`;
          if (column.key === 'quality') return product.errorCount || product.warningCount ? `${product.errorCount} 项阻断 · ${product.warningCount} 项提醒` : '检查通过';
          return <SecondaryButton label="质量与发布" onClick={() => onSelect(product.id)}/>;
        }
        const entry = row as Inventory;
        if (column.key === 'sku') return entry.sku;
        if (column.key === 'channel') return entry.supplyChannel?.obj?.key || (entry.supplyChannel?.obj?.name ? localized(entry.supplyChannel.obj.name) : entry.supplyChannel?.id) || '无 Supply Channel';
        if (column.key === 'stock') return entry.quantityOnStock;
        if (column.key === 'available') return entry.availableQuantity;
        return <SecondaryButton label="管理此 SKU" onClick={() => onSelect(entry.sku)}/>;
      }}/> : <ContentNotification type="info">{page > 0 ? '此页没有记录。可返回上一页或重新搜索。' : search ? '没有精确匹配的记录。请核对输入的标识及运营队列。' : filter!=='all' ? '当前运营队列无匹配记录。' : '当前项目尚无此类记录。'}</ContentNotification>}
    <Spacings.Inline>
      <SecondaryButton label="上一页" isDisabled={loading || page === 0} onClick={() => changePage(page - 1)}/>
      <Text.Body>第 {page + 1} 页{!loading && !error ? ` · ${rows.length} 条` : ''}</Text.Body>
      <SecondaryButton label="下一页" isDisabled={loading || Boolean(error) || !hasNext || page >= MAX_PAGE} onClick={() => changePage(page + 1)}/>
    </Spacings.Inline>
    {page >= MAX_PAGE && <ContentNotification type="info">已达到平台 offset 分页上限，请输入精确标识继续查找。</ContentNotification>}
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
        if (!Array.isArray(result.results)) throw new Error('商品定位返回了无效结果。');
        const found = verifiedInventoryLinks(result.results, sku, project, window.location.origin);
        if (active) setLinks(found);
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [api, sku, project, retry]);
  return <React.Fragment>{loading ? <Text.Detail>正在核对 SKU 对应的原生商品与变体…</Text.Detail> : error ?
    <Spacings.Stack scale="s"><Notice error={`原生商品定位失败：${error}`}/><SecondaryButton label="重试商品定位" onClick={() => setRetry(value => value + 1)}/></Spacings.Stack> :
    links.length ? <Spacings.Stack scale="s">{links.map(link => <NativeLink key={link.id} url={link.url} label={link.label}/>)}</Spacings.Stack> :
    <Text.Detail>未找到此 SKU 对应的原生商品变体。库存记录可独立于商品存在，因此不生成推测的商品链接。</Text.Detail>}</React.Fragment>;
}

function ApplicationWorkspace({module, project, canManage}: {module: ApplicationModule; project: string; canManage: boolean}) {
  const location = useLocation(), history = useHistory();
  const [qualitySnapshot,setQualitySnapshot]=useState<QualityScan>({checked:0,rows:[],complete:false,limited:false});
  const query = readHashState(location);
  const selected = query.get(module === 'wms' ? 'sku' : 'record') || '';
  const wmsView=query.get('view')==='transfer'?'transfer':query.get('view')==='count'?'count':'inventory';
  const wmsTabs=module==='wms'?<Spacings.Inline>{([
    ['inventory','库存查看与更正'],['transfer','库存调拨'],['count','销售库存盘点'],
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
  if(module==='wms'&&wmsView!=='inventory')return <Spacings.Stack scale="l">{wmsTabs}<WmsWorkflows key={wmsView} canManage={canManage} mode={wmsView}/></Spacings.Stack>;
  if (!selected) return <Spacings.Stack scale="l">{wmsTabs}{module==='pim'&&<Spacings.Inline>
    <SecondaryButton label="商品列表" isDisabled={query.get('view')!=='quality'} onClick={()=>{const next=listHashState(location,module);next.delete('view');history.push(hashLocation(location.pathname,next));}}/>
    <SecondaryButton label="目录质量工作台" isDisabled={query.get('view')==='quality'} onClick={()=>{const next=listHashState(location,module);next.set('view','quality');next.delete('page');history.push(hashLocation(location.pathname,next));}}/>
  </Spacings.Inline>}{module==='pim'&&query.get('view')==='quality'?<QualityWorkbench canManage={canManage} onSelect={select} snapshot={qualitySnapshot} onSnapshot={setQualitySnapshot}/>:<ResourceList module={module} onSelect={select}/>}</Spacings.Stack>;
  let valid = true;
  try { valid = module === 'wms' ? normalizeSearch(selected) === selected : isResourceId(selected); }
  catch { valid = false; }
  return <React.Fragment><Spacings.Stack scale="l">
    {wmsTabs}
    <Spacings.Inline><SecondaryButton label="返回列表" onClick={back}/></Spacings.Inline>
    {!valid ? <ContentNotification type="error">所选资源标识无效，请返回列表重新选择。</ContentNotification> : module === 'oms' ?
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
  return <React.Fragment><InfoMainPage title={module ? titles[module] : '运营管理'}
    subtitle={project ? `项目：${project} · 直接读取 commercetools，沿用当前 Merchant Center 用户权限。` : undefined}>
    <Spacings.Stack scale="l">
      {!module || !project ? <ContentNotification type="error">应用入口或项目上下文不可用，请从 Merchant Center 左侧的 OMS、WMS 或 PIM 入口重新打开。</ContentNotification> :
        !canView ? <ContentNotification type="error">当前团队没有此应用的 View 权限，请联系 Merchant Center 管理员。</ContentNotification> : <React.Fragment>
          {!canManage && <ContentNotification type="info">当前为只读权限。保存需要此应用的 View and edit 权限。</ContentNotification>}
          <ApplicationWorkspace key={`${project}/${entryPoint}`} module={module} project={project} canManage={canManage}/>
        </React.Fragment>}
    </Spacings.Stack>
  </InfoMainPage></React.Fragment>;
}
