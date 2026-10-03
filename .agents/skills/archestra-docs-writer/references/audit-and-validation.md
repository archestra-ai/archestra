# Audit and Validation

Adapted and shortened for Archestra from Gemini CLI's docs-auditing guide (Apache-2.0; see [attribution](attribution.md)).

## Evidence

Audit in both directions within the requested scope: verify documented claims against current UI/code, then inspect affected routes, schemas, configuration, and feature changes for missing user-facing documentation. For each finding, keep its page, supporting code/UI evidence, and a concrete correction. Record accepted or deferred changes in the task outcome; do not broaden the rewrite automatically.

Preserve commands, identifiers, configuration keys, quoted UI labels, and literal error messages during prose edits. Verify command examples against their implementation and state whether they were executed. Edit generated API documentation through its source schema and generator, not the generated output. Inspect the relevant repository generator before running it; documentation work does not authorize database migrations or production changes.

## Source Gates

From the Archestra repository root:

```sh
python3 .github/scripts/check-docs-navigation.py
python3 -m unittest discover -s .github/scripts -p 'test_docs_navigation.py'
python3 .github/scripts/check-docs-links.py
python3 .github/scripts/check-docs-image-policy.py
```

Navigation validation covers manifest shape, duplicate/unknown slugs, and omitted pages. Link validation covers internal page/asset targets and product docs-map entries. It skips anchor fragments, reference-style links, external URLs, and other website routes; inspect changed instances separately. Image validation enforces WebP size/format and permitted SVG assets, not screenshot accuracy or theme.

## Renderer Gates

When navigation, Markdown rendering, or docs layout changes, use the adjacent website checkout and read its AGENTS instructions. From `website/app`:

```sh
pnpm docs:validate
pnpm exec vitest run app/docs
pnpm check:ci
```

Use the installed Node version required by the dependency engines. `check:ci` includes source loading, formatting, Biome, Knip, all tests, typecheck, production build, and catalog validation. Confirm which local or pinned remote docs snapshot the loader uses. Missing docs and invalid manifests must fail; do not hide them behind empty results or skip checks to obtain a pass.

Inspect representative pages in the browser at desktop and mobile widths: navigation disclosure/active state, search and keyboard selection, heading anchors, code copying, tables/images, and Swagger without live requests. Restore temporary viewport/theme overrides and preserve active previews. Browser inspection is manual evidence; no screenshot-diff or automated accessibility gate is implied.
