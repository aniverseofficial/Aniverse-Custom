# Aniverse Custom — Deployment Test Fix 1.3.4

- Deployment test runner now loads the project's `.env` automatically before reading test credentials and flags.
- Browser tests can be enabled through `TEST_BROWSER=1` or `TEST_RUN_ALL=1`.
- Browser admin test now exercises the login form when present and verifies authenticated admin content.
- Supplier restore no longer attempts to increment a missing supplier source when a restored product has no `supplierKey`.
- No admin password is embedded in the project or test script.
