# Aniverse Deployment Test Suite

The project includes an automated deployment test runner:

```bash
npm run test:deploy
```

It tests:

- Server availability and `/api/health`
- Storefront and legal/static pages
- Products, categories, hero and store-settings APIs
- Admin authentication and protected API access
- Admin dashboard, products, orders, customers, inventory, analytics, discounts, drafts, settings, activity and staff APIs
- Product/category create-update-delete lifecycle using temporary test records
- Inventory adjustment and history
- Discount creation and validation
- Draft-order creation/cancellation cleanup
- CSV exports
- JWT/protected-write security checks
- ImageKit configuration
- Production secret sanity checks
- Optional Razorpay/Shiprocket checks
- Optional Playwright browser/UI checks

The runner writes `DEPLOYMENT-TEST-REPORT.md` with a 0–10 rating per category and an overall deployment gate.

## Recommended launch test

Run with the server stopped so the script can start it automatically:

```bash
npm run test:deploy
```

For the fullest test:

```bash
set TEST_EXTERNAL=1
set TEST_BROWSER=1
set NODE_ENV=production
npm run test:deploy
```

Install Playwright first if browser testing is desired:

```bash
npm i -D playwright
npx playwright install chromium
```

Use Razorpay test credentials for the first external run. Do not run destructive/live payment or shipping tests against production data without a backup and a dedicated test order.

## Useful options

```text
TEST_BASE_URL=http://localhost:4000
TEST_ADMIN_EMAIL=admin@example.com
TEST_ADMIN_PASSWORD=...
TEST_EXTERNAL=1
TEST_BROWSER=1
TEST_MUTATIONS=1
TEST_NO_START=1
```

The mutation suite creates uniquely named temporary records and deletes them at the end. It does not delete existing Aniverse products, orders, categories or discounts.

## Important limitation

No automated test can prove a physical delivery, a real bank settlement, DNS/TLS configuration, visual merchandising quality, or every possible browser interaction. The report explicitly marks checks that were skipped or require external credentials.


## Automated credential loading

The deployment test runner automatically loads `.env` before reading test settings. No credentials need to be placed in the test script.

Recommended `.env` values for a complete local test:

```env
ADMIN_EMAIL=admin@aniverse.com
ADMIN_PASSWORD=<your-admin-password>
TEST_BROWSER=1
TEST_EXTERNAL=0
TEST_MUTATIONS=1
```

Run:

```bash
npm run test:deploy
```

For browser tests, install Playwright once:

```bash
npm i -D playwright
npx playwright install chromium
```
