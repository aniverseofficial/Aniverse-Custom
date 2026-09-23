# Aniverse Product Loading Fix

Fixed the storefront initialization/API failure that prevented products from rendering.

## Root causes fixed

1. `heroTimer` was used by `startHeroAutoplay()` without being declared. That threw a `ReferenceError` during `init()`, which stopped execution before `loadProducts()` ran.
2. Local development with the storefront on `:4000` and API on `:5000` could accept a successful HTML SPA fallback from the storefront as if it were a successful API response. The API connector now prefers `:5000` locally and rejects non-JSON responses for API calls.

## Product behavior

- Public `/api/products` reads the same `products` collection used by the admin inventory.
- Products are visible unless `active === false`.
- Storefront requests up to 2,000 products.
- `/uploads/...` product media resolves against the active API server.

Keep the existing production `.env` and database configuration.
