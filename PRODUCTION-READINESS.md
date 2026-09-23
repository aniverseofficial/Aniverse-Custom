# Aniverse Production Readiness Checklist

## Storefront
- Responsive sticky navigation with isolated search, cart, wishlist, catalogue, product and checkout layers.
- Product details, related products, multi-category filtering, cart and wishlist use the API catalogue.
- Search results are keyboard accessible and open products directly.
- Cart totals are recalculated client-side for display and server-side again before payment.

## Backend
- MongoDB connection is required at startup.
- Existing MongoDB indexes are preserved; optional admin collections are created safely when first used.
- Razorpay secrets stay server-side.
- Razorpay webhook uses the raw request body and signature verification.
- Checkout validates prices and stock server-side.
- Inventory reservation/release is handled server-side.
- Login attempts are rate-limited in-process.
- Security response headers and JSON size limits are enabled.

## Before live launch
1. Set `NODE_ENV=production`.
2. Use a strong `JWT_SECRET` and a production admin credential.
3. Set `MONGODB_URI` and `MONGODB_DB` explicitly.
4. Set Razorpay Live keys only after completing a Test Mode purchase flow.
5. Configure `RAZORPAY_WEBHOOK_SECRET` and register the webhook endpoint.
6. Set `CORS_ORIGIN` to the exact production storefront origin(s) when using a separate frontend host.
7. Move `/public/uploads` to persistent object/image storage for multi-instance/serverless hosting, or mount a persistent volume.
8. Configure Shiprocket credentials only if shipping integration is enabled.
9. Run `npm run smoke` against the production-like server.
10. Test one complete purchase, one failed payment, one out-of-stock checkout, one refund, one shipment and one admin image upload before launch.
