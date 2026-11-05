import React from 'react';
import type {ApplicationWindow} from '@commercetools-frontend/constants';
import {
  ApplicationShell,
  CustomViewShell,
  setupGlobalErrorListener,
} from '@commercetools-frontend/application-shell';
import loadMessages from '../../load-messages';

declare let window: ApplicationWindow;

// Here we split up the main (app) bundle with the actual application business logic.
// Splitting by route is usually recommended and you can potentially have a splitting
// point for each route. More info at https://reactjs.org/docs/code-splitting.html
const AsyncCustomViewRoutes = React.lazy(
  () => import('../../routes' /* webpackChunkName: "routes" */)
);
const AsyncApplicationRoutes = React.lazy(
  () => import('../../application-routes' /* webpackChunkName: "application-routes" */)
);

// Ensure to setup the global error listener before any React component renders
// in order to catch possible errors on rendering/mounting.
setupGlobalErrorListener();

const EntryPoint = () => window.app.customViewId ? (
  <CustomViewShell applicationMessages={loadMessages}>
    <AsyncCustomViewRoutes />
  </CustomViewShell>
) : (
  <ApplicationShell environment={window.app} applicationMessages={loadMessages}>
    <AsyncApplicationRoutes />
  </ApplicationShell>
);

EntryPoint.displayName = 'EntryPoint';

export default EntryPoint;
