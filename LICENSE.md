# License Router

This repository is dual-licensed. The first matching rule below determines the license for a given file or region.

Read about pricing model here: https://archestra.ai/docs/platform-pricing-model

| File | Identifier | Scope |
| --- | --- | --- |
| [`LICENSE_AGPL`](./LICENSE_AGPL) | `AGPL-3.0-only` | Default. |
| [`LICENSE_ENTERPRISE`](./LICENSE_ENTERPRISE) | `LicenseRef-Archestra-Enterprise` | Files, directories, or regions marked Enterprise. |

## Rules (first match wins)

1. **SPDX header** at the top of the file is authoritative — e.g. `// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise`.
2. **In-file regions** wrapped in REUSE snippet syntax are Enterprise; everything else in the file stays AGPL:
   ```
   // SPDX-SnippetBegin
   // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
   // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
   <enterprise code>
   // SPDX-SnippetEnd
   ```
   Use the file's native comment style (`#` for Python/YAML/shell, `<!-- ... -->` for Markdown/HTML, `--` for SQL).
3. **Path convention** — files named `*.ee.{ts,tsx,js,jsx,py,rs,sql,json,yaml,yml,md}` or under any `ee/` directory are Enterprise.
4. **Default** — AGPL-3.0-only.
