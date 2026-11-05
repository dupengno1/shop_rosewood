export default {
  "name": "Rosewood PIM",
  "description": "PIM operations inside Merchant Center using native commerce resources.",
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
      "view_products"
    ],
    "manage": [
      "manage_products"
    ]
  },
  "icon": "${path:@commercetools-frontend/assets/application-icons/files.svg}",
  "mainMenuLink": {
    "defaultLabel": "PIM",
    "labelAllLocales": [
      {
        "locale": "en",
        "value": "PIM"
      }
    ],
    "permissions": [
      "ViewRosewoodPim"
    ]
  },
  "submenuLinks": []
};
