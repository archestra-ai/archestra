# Docs screenshots

Run `pnpm docs:screenshots` from `platform/` against a seeded local stack. See [the screenshot workflow](../../.agents/skills/archestra-docs-writer/references/site-mechanics.md#screenshots) for setup and adding scenes.

The exact `DOCS_SCREENSHOTS_ONLY=automated_screenshots/llm-proxy_model-router-key` selection seeds only the persona and real provider mappings needed by that dialog. Full captures retain the complete demo seed, including Kubernetes environments and knowledge data.

Use an isolated fixture instance: the guardrails overview enables real enforcement through the API and verifies that it is active before capturing. It does not simulate deployment status in the browser.

Keep scene choices explicit: pick a named agent, sort tied lists by name, and wait for the final UI state. The harness waits for the app's accessible loading status to clear; the approval scene also waits for setup-command generation. Usage scenes use `FIXTURE_TIME` with the usage SQL dataset and an exact statistics range, so request buckets and labels do not move with the calendar. Browser timers still run normally. Locale, timezone, fonts, reduced motion, and disabled screenshot animations are handled by the capture harness.

After the real API and UI steps finish, the capture normalizes displayed fixture UUIDs and generated token text. Equal tokens retain their relationship, distinct tokens stay distinct, and token length, casing, and masking regressions remain visible. The approval scene also uses an example terminal code. These changes affect text/input display only; they do not change product responses, records, links, or security behavior. No UI actions follow normalization. Keep normalization limited to incidental identifiers. Never mask whole panels, change the image comparison tolerance to hide churn, or stub new product data to stabilize a screenshot.

## Check reproducibility

`pnpm --filter @archestra/docs-screenshots exec playwright test --project=determinism` checks that independent identifiers render identically and that real copy changes still affect the image. CI runs this check before the full capture.

For a capture change, run the same manifest twice against independently seeded, fresh ephemeral databases in the same browser/build environment. Keep each run's raw PNGs and WebPs in separate directories:

```bash
DOCS_SCREENSHOTS_RAW_OUTPUT=/tmp/docs-first/raw DOCS_SCREENSHOTS_OUTPUT=/tmp/docs-first/webp pnpm docs:screenshots
# Start a fresh instance/database, then run the same command with docs-second.
DOCS_SCREENSHOTS_RAW_OUTPUT=/tmp/docs-second/raw DOCS_SCREENSHOTS_OUTPUT=/tmp/docs-second/webp pnpm docs:screenshots
node tools/docs-screenshots/scripts/compare-captures.mjs /tmp/docs-first/raw /tmp/docs-second/raw
```

`DOCS_SCREENSHOTS_ONLY` can select the same subset in both runs. The comparison fails for missing images or any changed decoded pixel, before the existing lossy WebP tolerance can hide a difference. Inspect every changed scene. Ordinary captures still validate the complete manifest in the merge queue; publication rules are unchanged.

Other scenes can still depend on live timestamps, background jobs, and the target instance's state. Exact reproducibility is scoped to the same browser, fonts, OS, device scale, and application build. Chromium, font, chart, or WebP encoder upgrades can require a reviewed baseline refresh. A capture against an existing nonempty instance can also include unrelated records; fresh databases give the strongest check.
