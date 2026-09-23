# Aniverse Deployment Test Report

Generated: 2026-09-23T11:50:57.262Z
Base URL: http://localhost:4000
External integrations: enabled

## Final deployment gate: **CONDITIONAL PASS**
**Overall rating: 1.0/10 (98/100)**
PASS: 48 · WARN: 1 · FAIL: 0 · SKIP: 1

| Category | Rating | Pass | Warn | Fail | Skip |
|---|---:|---:|---:|---:|---:|
| Public/API | 1.0/10 | 5 | 0 | 0 | 0 |
| Public/Pages | 1.0/10 | 11 | 0 | 0 | 0 |
| Security | 0.9/10 | 5 | 1 | 0 | 0 |
| Authentication | 1.0/10 | 1 | 0 | 0 | 0 |
| Admin/API | 1.0/10 | 11 | 0 | 0 | 0 |
| Products/Catalog | 1.0/10 | 3 | 0 | 0 | 0 |
| Inventory | 1.0/10 | 1 | 0 | 0 | 0 |
| Discounts | 1.0/10 | 2 | 0 | 0 | 0 |
| Draft Orders | 1.0/10 | 1 | 0 | 0 | 0 |
| Exports | 1.0/10 | 3 | 0 | 0 | 0 |
| Integrations | 0.8/10 | 2 | 0 | 0 | 1 |
| Browser/UI | 1.0/10 | 3 | 0 | 0 | 0 |

## Detailed results
### Public/API
- **PASS** — Health endpoint
- **PASS** — Products API
- **PASS** — Categories API
- **PASS** — Hero API
- **PASS** — Store settings API

### Public/Pages
- **PASS** — Storefront HTML
- **PASS** — Admin HTML
- **PASS** — Contact page
- **PASS** — FAQ page
- **PASS** — Shipping policy
- **PASS** — Returns/refunds policy
- **PASS** — Cancellation policy
- **PASS** — Privacy policy
- **PASS** — Terms page
- **PASS** — Robots
- **PASS** — Sitemap

### Security
- **PASS** — Unauthenticated admin API blocked
- **PASS** — Invalid admin credentials rejected
- **PASS** — Malformed JWT rejected
- **PASS** — Protected product write rejected without token
- **PASS** — Webhook secret configuration
- **WARN** — Production secrets are not defaults — NODE_ENV is not production; use ALLOW_TEST_SECRETS=1 only for local testing

### Authentication
- **PASS** — Admin login

### Admin/API
- **PASS** — Admin dashboard
- **PASS** — Admin products
- **PASS** — Orders
- **PASS** — Customers
- **PASS** — Inventory
- **PASS** — Analytics
- **PASS** — Discounts
- **PASS** — Draft orders
- **PASS** — Settings
- **PASS** — Activity log
- **PASS** — Staff

### Products/Catalog
- **PASS** — Create test category
- **PASS** — Create test product
- **PASS** — Update product

### Inventory
- **PASS** — Inventory adjustment + history

### Discounts
- **PASS** — Create test discount
- **PASS** — Validate discount

### Draft Orders
- **PASS** — Create test draft order

### Exports
- **PASS** — Export products CSV
- **PASS** — Export customers CSV
- **PASS** — Export orders CSV

### Integrations
- **PASS** — Razorpay configuration
- **SKIP** — Shiprocket configuration — Shipping integration intentionally deferred; configure SHIPROCKET_EMAIL/SHIPROCKET_PASSWORD when shipping is integrated.
- **PASS** — ImageKit configuration

### Browser/UI
- **PASS** — Storefront UI
- **PASS** — Admin login UI
- **PASS** — Console error audit

## Interpretation
No automated failure blocked deployment, but warnings/skipped checks remain. Complete those checks before treating the deployment as fully verified.

> Note: Automated API tests cannot prove real Razorpay settlement, courier pickup, physical delivery, DNS, TLS, or human visual quality unless the corresponding external/browser tests are enabled and credentials are valid.