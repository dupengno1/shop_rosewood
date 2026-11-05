import React from 'react';
import {useCustomViewContext} from '@commercetools-frontend/application-shell-connectors';
import {computeCustomViewPermissionsKeys} from '@commercetools-frontend/application-config/ssr';
import {useIsAuthorized} from '@commercetools-frontend/permissions';
import {ContentNotification} from '@commercetools-uikit/notifications';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import {parseHostUrl} from './domain';
import ProductPanel from './product-panel';
import OrderPanel from './order-panel';
import InventoryPanel from './inventory-panel';
import {Section} from './shared';

const permissions = computeCustomViewPermissionsKeys();

function supportDiagnosticPath(hostUrl: string): string | null {
  try {
    const url = new URL(hostUrl);
    return url.searchParams.get('opsDebug') === '1' ? url.pathname : null;
  } catch {
    return null;
  }
}

export default function Routes() {
  const {hostUrl, projectKey, customViewConfig} = useCustomViewContext(context => ({
    hostUrl: context.hostUrl,
    projectKey: context.project?.key,
    customViewConfig: context.customViewConfig,
  }));
  const canManage = useIsAuthorized({demandedPermissions:[permissions.Manage]});
  const context = parseHostUrl(hostUrl || '', projectKey || '');
  const diagnosticPath = supportDiagnosticPath(hostUrl || '');
  return <React.Fragment><Spacings.Stack scale="l">
    <Text.Headline as="h2">运营增强 · Rosewood Operations</Text.Headline>
    <Text.Detail>使用当前 Merchant Center 项目和用户权限，直接读取 commercetools。</Text.Detail>
    {diagnosticPath && <Section title="入口诊断 · Support diagnostics">
      <Text.Detail>来源：Merchant Center 宿主通过官方 Custom View context 提供的已注册配置。</Text.Detail>
      <Text.Detail>Custom View ID：{customViewConfig.id}</Text.Detail>
      <Text.Detail>原生页面路径：{diagnosticPath}</Text.Detail>
      <Text.Detail>当前 locator：官方 SDK context 未提供该字段。</Text.Detail>
      <Text.Detail>已注册入口（{customViewConfig.locators.length}）：</Text.Detail>
      <ul>{customViewConfig.locators.map(locator => <li key={locator}><code>{locator}</code></li>)}</ul>
    </Section>}
    {!canManage && <ContentNotification type="info">当前为只读权限。保存需要此 Custom View 的 View and edit 权限。</ContentNotification>}
    {context.kind === 'product' && context.inventoryId ? <Section title="WMS · 当前库存记录"><InventoryPanel key={context.inventoryId} entryId={context.inventoryId} canManage={canManage}/></Section> :
      context.kind === 'product' && context.id ? <ProductPanel key={`${context.id}:${context.variantId || ''}`} id={context.id} variantId={context.variantId} nativeUrl={context.nativeUrl || hostUrl} canManage={canManage}/> :
      context.kind === 'order' && context.id ? <OrderPanel key={context.id} id={context.id} nativeUrl={context.nativeUrl || hostUrl} canManage={canManage}/> :
      <ContentNotification type="info">请从当前商品详情、变体库存或订单详情页面打开此面板。本地开发可设置 MC_HOST_PATH 指向真实实体页面。</ContentNotification>}
  </Spacings.Stack></React.Fragment>;
}
