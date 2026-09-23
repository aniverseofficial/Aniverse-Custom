# Aniverse — Shopify-style Full-Stack Admin + Storefront

Aniverse storefront + MongoDB + Razorpay + a production-oriented back office inspired by the workflows users expect from modern ecommerce admin platforms.

## Admin capabilities

- Home dashboard with sales, orders, customers, low-stock and recent activity
- Global admin search across products, orders and customers
- Products: create/edit, pricing, compare-at pricing, SKU, vendor, weight, tags, media, collections, pre-orders, featured and visibility
- Bulk product actions and CSV export
- Inventory: stock adjustments, low-stock view, inventory value and adjustment history
- Collections: create/edit/delete, multiple product membership and collection images
- Orders: search, date/payment/status filters, complete line items, customer/shipping details, notes/tags, status changes, refunds through Razorpay, shipment creation/tracking
- Draft orders for manual/offline/wholesale sales
- Customers: search, profile editing, order count and total paid spend
- Analytics: sales over time, AOV and top products
- Discounts: percentage/fixed codes, minimum order, usage limits and validity dates
- Storefront discount-code validation and checkout application
- Content & Files: upload/list/delete storefront media
- Shipping: shipping thresholds/rates and Shiprocket operational settings
- Staff & Permissions: admin/staff accounts and permission profiles
- Settings + admin activity log
- CSV exports for products, customers and orders

## Architecture

Browser → Express API → MongoDB

Razorpay Checkout → server-side order creation → signature verification/webhook → MongoDB order/payment state.

Storefront and admin use the same catalogue and inventory source of truth.

## Run

```powershell
npm install
npm start
```

Storefront: http://localhost:4000/
Admin: http://localhost:4000/admin/
Health: http://localhost:4000/api/health

Smoke test:

```powershell
npm run smoke
```

The smoke test starts a local server automatically if the configured base URL is not already reachable. If MongoDB is not configured, the health check will correctly fail rather than hiding the database problem.

## Environment

Keep secrets in `.env`:

- MONGODB_URI
- MONGODB_DB
- JWT_SECRET
- ADMIN_EMAIL
- ADMIN_PASSWORD
- RAZORPAY_KEY_ID
- RAZORPAY_KEY_SECRET
- RAZORPAY_WEBHOOK_SECRET
- optional Shiprocket credentials

Existing MongoDB indexes are preserved. In particular, the server does not replace an existing `users.email_1` index.

## Production notes

- Use HTTPS and Razorpay Live Mode only after Test Mode is verified.
- Configure the Razorpay webhook endpoint at `/api/payments/webhook`.
- Use persistent image/object storage for production rather than ephemeral local `/uploads` storage.
- Keep MongoDB and payment secrets server-side.
- Configure exact CORS origins.
- Back up MongoDB and use least-privilege database credentials.

### Anime Hero Management
The anime hero is controlled from **Admin → Anime Hero**. Hero worlds are backed by storefront collections, and admins can add/remove worlds, replace hero artwork, edit copy, and reorder the hero without changing storefront code.


## Latest storefront category behavior
See `CATEGORY-DIRECTORY-ADMIN.md`: All Categories is now controlled entirely from Admin > Collections; anime worlds are separate.
