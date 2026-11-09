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
    <Text.Headline as="h2">Rosewood Operations</Text.Headline>
    <Text.Detail>Operational information for the current Merchant Center project.</Text.Detail>
    {diagnosticPath && <Section title="Support diagnostics">
      <Text.Detail>Source: registered configuration supplied by the Merchant Center Custom View context.</Text.Detail>
      <Text.Detail>Custom View ID：{customViewConfig.id}</Text.Detail>
      <Text.Detail>Native page path: {diagnosticPath}</Text.Detail>
      <Text.Detail>Current locator: not supplied by the official SDK context.</Text.Detail>
      <Text.Detail>Registered entry points ({customViewConfig.locators.length}):</Text.Detail>
      <ul>{customViewConfig.locators.map(locator => <li key={locator}><code>{locator}</code></li>)}</ul>
    </Section>}
    {!canManage && <ContentNotification type="info">Read-only access. Saving requires View and edit permission for this Custom View.</ContentNotification>}
    {context.kind === 'product' && context.inventoryId ? <Section title="WMS · Inventory Record"><InventoryPanel key={context.inventoryId} entryId={context.inventoryId} canManage={canManage}/></Section> :
      context.kind === 'product' && context.id ? <ProductPanel key={`${context.id}:${context.variantId || ''}`} id={context.id} variantId={context.variantId} nativeUrl={context.nativeUrl || hostUrl} canManage={canManage}/> :
      context.kind === 'order' && context.id ? <OrderPanel key={context.id} id={context.id} nativeUrl={context.nativeUrl || hostUrl} canManage={canManage}/> :
      <ContentNotification type="info">Open this panel from a product, variant inventory or order details page.</ContentNotification>}
  </Spacings.Stack></React.Fragment>;
}
