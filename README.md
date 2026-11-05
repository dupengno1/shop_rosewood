# Rosewood Merchant Center Connect source package

This generated package hosts the three existing OMS / WMS / PIM Custom Applications and the existing Operations Custom View. It creates no service, credentials, database, PSP or WMS connector. Current user permissions and commercetools data remain authoritative.

Each folder is independent: run `npm ci`, `npm test`, and `npm run typecheck`. To build, provide its non-secret values from `connect-surface.json` and `APPLICATION_URL`; Connect injects APPLICATION_URL during deployment. Then run `npm run build`. Node 22 is required. Do not commit node_modules, public, env files or QA data.

Publish this repository to GitHub with a Git tag, create/preview/install the Connector, then use the returned four deployment URLs to update the existing Merchant Center registrations. No Connect URL is known or claimed by this source package. Keep existing registrations and project installation IDs. Verify actual Menu / Custom View loading and authorized QA writes after the URL switch.

The build invokes official mc-scripts, retains the registered IDs/scopes/locators, preserves the self-hosted font fix in the official HTML template, and runs official compile-html afterward. Connect must serve each customization using its supported routing. This package does not introduce Sites-specific deep path aliases.

Official documentation: https://docs.commercetools.com/merchant-center-customizations/deployment/commercetools-connect
