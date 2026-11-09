export default {
  "name": "Rosewood WMS",
  "description": "WMS operations inside Merchant Center using native commerce resources.",
  "entryPointUriPath": "${env:ENTRY_POINT_URI_PATH}",
  "cloudIdentifier": "${env:CLOUD_IDENTIFIER}",
  "env": {
    "development": {
      "initialProjectKey": "rosewood-shop-demorosewood-shop-demo"
    },
    "production": {
      "applicationId": "${env:CUSTOM_APPLICATION_ID}",
      "url": "${env:APPLICATION_URL}"
    }
  },
  "oAuthScopes": {
    "view": [
      "view_products",
      "view_product_selections"
    ],
    "manage": [
      "manage_products"
    ]
  },
  "icon": "${path:@commercetools-frontend/assets/application-icons/box.svg}",
  "mainMenuLink": {
    "defaultLabel": "WMS",
    "labelAllLocales": [
      {
        "locale": "en",
        "value": "WMS"
      }
    ],
    "permissions": [
      "ViewRosewoodWms"
    ]
  },
  "submenuLinks": []
};
