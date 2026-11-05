export default {
  "name": "Rosewood Operations · OMS / PIM / WMS",
  "description": "Order fulfilment, product quality and SKU inventory management within Merchant Center, using live project data and current user permissions.",
  "labelAllLocales": [
    {
      "locale": "en",
      "value": "Operations · OMS / PIM / WMS"
    }
  ],
  "cloudIdentifier": "${env:CLOUD_IDENTIFIER}",
  "env": {
    "development": {
      "initialProjectKey": "rosewood-shop-demorosewood-shop-demo"
    },
    "production": {
      "customViewId": "${env:CUSTOM_VIEW_ID}",
      "url": "${env:APPLICATION_URL}"
    }
  },
  "oAuthScopes": {
    "view": [
      "view_products",
      "view_orders"
    ],
    "manage": [
      "manage_products",
      "manage_orders"
    ]
  },
  "type": "CustomPanel",
  "typeSettings": {
    "size": "LARGE"
  },
  "locators": [
    "products.product_details.general",
    "products.product_details.variants",
    "products.product_variant_details.inventory",
    "products.product_variant_details.inventory.details",
    "orders.order_details.general",
    "orders.order_details.shipping_and_delivery",
    "products.variant_details.prices.edit_price"
  ]
};
