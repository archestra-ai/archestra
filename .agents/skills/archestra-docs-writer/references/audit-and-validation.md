# Audit and Validation

## Checking Claims

Check a page in two directions. First, test what the page says against the running product and the code. Second, look at the code and UI for the feature, and find what the page leaves out that a reader needs.

Copy commands, configuration keys, UI labels, and error messages exactly. Say whether you ran each command example. Generated pages, such as the API reference and the Archestra MCP Server reference, come from a generator — edit the generator and re-run it, never the output. Docs work never authorizes database changes, migrations, or production changes.

## Docs Checks

From the repository root:

```sh
python3 .github/scripts/check-docs-navigation.py
python3 .github/scripts/check-docs-links.py
python3 .github/scripts/check-docs-mcp-tool-links.py   # add --fix to link unlinked tool mentions
python3 .github/scripts/check-docs-env-var-links.py    # add --fix to link unlinked env var mentions
python3 .github/scripts/check-docs-metric-links.py     # add --fix to anchor metric rows and link metric mentions
python3 -m unittest discover -s .github/scripts -p 'test_docs_*.py'
python3 .github/scripts/check-docs-image-policy.py
```

- **Navigation:** the folder tree, an `index.md` per folder, required frontmatter, unique sibling `order`, and redirects.
- **Links:** every internal page, asset, and `#anchor`, plus the slugs in `platform/shared/docs.ts`. Relative page links fail.
- **Tool and env var links:** every built-in MCP tool and environment variable mention links to its reference entry.
- **Images:** WebP format and size. It does not check that a screenshot is current.

## Site Checks

When a change touches rendering, navigation, or the docs layout, run these in the website repository, from `website/app`:

```sh
pnpm docs:validate
pnpm exec vitest run app/docs
pnpm check:ci
```

Then open the changed pages in a browser, in light and dark mode, at desktop and phone widths. A failing check is a real failure. Never skip a check to get a pass.
