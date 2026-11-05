# Rosewood Merchant Center Connect source package

This generated package hosts the three existing OMS / WMS / PIM Custom Applications and the existing Operations Custom View. It creates no service, credentials, database, PSP or WMS connector. Current user permissions and commercetools data remain authoritative.

Each folder is independent: run `npm ci`, `npm test`, and `npm run typecheck`. To build, provide its non-secret values from `connect-surface.json` and `APPLICATION_URL`; Connect injects APPLICATION_URL during deployment. Then run `npm run build`. Node 22 is required. Do not commit node_modules, public, env files or QA data.

Publish this repository to GitHub with a Git tag, create/preview/install the Connector, then use the returned four deployment URLs to update the existing Merchant Center registrations. No Connect URL is known or claimed by this source package. Keep existing registrations and project installation IDs. Verify actual Menu / Custom View loading and authorized QA writes after the URL switch.

Connect runs mc-scripts build directly and compile-html at startup. Each application includes the officially supported root webpack.config.prod.cjs extension, which emits local font assets and updates the official HTML template while preserving every official script byte. This also works independently of the optional npm build wrapper. The production extension limits Babel, JavaScript minification and CSS minification worker concurrency to one per pool, avoiding CPU-count-based worker expansion in build containers. This is a local resource safeguard; successful cloud publishing and deployment still require verification. Registered IDs, scopes and locators are retained. Connect must serve each customization using its supported routing. This package does not introduce Sites-specific deep path aliases.

Official documentation: https://docs.commercetools.com/merchant-center-customizations/deployment/commercetools-connect
