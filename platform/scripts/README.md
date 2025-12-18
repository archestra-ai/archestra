# License Compliance

Scans dependencies for GPL/AGPL licenses incompatible with proprietary software.

## Usage

```bash
node scripts/check-licenses.js           # Full report
node scripts/check-licenses.js --ci      # CI mode (fails on GPL/AGPL)
node scripts/check-licenses.js lookup react  # Check specific package
```

## Adding Verified Licenses

Edit `scripts/license-resolution.json` for packages with missing metadata:

```json
"package-name": {
  "license": "Apache-2.0",
  "source": "https://github.com/org/repo/blob/main/LICENSE",
  "verifiedBy": "manual inspection",
  "verifiedDate": "2025-12-18"
}
```

## CI

Runs automatically on PRs. **Blocks:** GPL, AGPL, Unknown. **Allows:** MIT, Apache, BSD, ISC, LGPL, MPL.
