export default {
  "name": "Rosewood OMS",
  "description": "OMS operations inside Merchant Center using native commerce resources.",
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
      "view_orders",
      "view_products",
      "view_payments"
    ],
    "manage": [
      "manage_orders"
    ]
  },
  "icon": "${path:@commercetools-frontend/assets/application-icons/truck.svg}",
  "mainMenuLink": {
    "defaultLabel": "OMS",
    "labelAllLocales": [
      {
        "locale": "en",
        "value": "OMS"
      }
    ],
    "permissions": [
      "ViewRosewoodOms"
    ]
  },
  "submenuLinks": []
};
