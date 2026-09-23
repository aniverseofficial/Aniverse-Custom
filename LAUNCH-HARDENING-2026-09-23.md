# Aniverse Custom — v1.3.1 Launch Hardening

This build completes the main admin production-hardening gaps identified in v1.3.0.

## Completed

- Server-side staff permission enforcement for admin routes.
- Permission changes take effect immediately because staff status/permissions are re-read from MongoDB for authenticated admin requests.
- Inactive/blocked staff accounts are denied at login and on subsequent requests.
- Staff-account management is restricted to administrator accounts.
- Added explicit permissions for files, drafts, staff, supplier stock report and other admin modules.
- Added cumulative refund tracking and protection against refunding more than the captured order total.
- Added refund history and partial-refund payment status (`partially_refunded`).
- Added a short refund lock to prevent duplicate concurrent refund requests.
- Draft orders now calculate discount/shipping/total server-side.
- Draft orders can be converted into real Razorpay orders with inventory reservation.
- Cancelled drafts are retained as `cancelled` instead of being hard-deleted.
- Product editor now supports product type, HSN, GST rate, shipping requirement, SEO title and SEO description.
- Admin navigation hides modules the current staff account cannot access.

## Important production checks

Before switching to live traffic, configure production MongoDB, JWT secret, Razorpay live credentials/webhook secret, CORS where cross-origin access is required, and ImageKit/Shiprocket credentials as applicable. Run a live test order, webhook, refund, inventory reservation/release and shipping-label flow.
