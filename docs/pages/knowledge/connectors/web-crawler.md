---
title: Web Crawler
description: Connect Web Crawler documents to Knowledge and configure source access
order: 15
lastUpdated: 2026-10-05
---

Let agents answer from public websites, such as your product docs or a vendor's status page. The crawler fetches HTML pages. Static fetching is the default.

**Indexed:** HTML pages discovered from the configured seed URLs and allowed origins. The crawler extracts page text, removes common navigation and layout elements, and stores each page with its canonical URL when one is present.

**Authentication:** none. The crawler only fetches pages reachable over HTTP(S).

Private and internal network addresses are blocked by default. To crawl an internal site reachable from the workers, enable **Allow internal network addresses** when creating the connector.

If the start URL is the site root, such as `https://example.com/`, and no include path prefixes are configured, the crawler can discover any page on that origin within the configured depth and page limits.

## Connecting Web Crawler

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Web Crawler** and name the connector.
2. Enter the start URL and crawl limits below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. Web Crawler does not support auto-sync permissions.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field                 | Description                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Start URL             | First page to crawl. Its origin is automatically allowed.                                                    |
| Include Path Prefixes | Comma-separated paths to crawl, such as `/docs/` or `/guides/`. Defaults to the start URL path.          |
| Exclude Path Patterns | Comma-separated regular expressions matched against path and query, such as `/search` or `/archive/.*`. |
| Content Selector      | CSS selector for the page content root. Leave blank to use default document selectors.                   |
| Exclude Selectors     | Comma-separated CSS selectors to remove before extracting text, such as `.sidebar` or `.toc`.           |
| Max Pages             | Maximum pages to crawl in one sync (default: `250`).                                                     |
| Max Depth             | Maximum link depth from the start URL (default: `3`).                                                    |

Additional start URLs are fetched even when no other page links to them. Their origins are automatically allowed. Additional allowed origins are followed only through discovered links. Redirects obey the configured origin and path restrictions.

Without explicit path prefixes, each seed limits crawling to its containing directory. Relative prefixes apply to every origin; absolute prefix URLs apply only to their own origin. Page limits apply to the whole connector.

## JavaScript Pages

Enable **Render JavaScript** when page content loads in the browser. The server needs Chromium; see [Knowledge configuration](/docs/reference/configuration#knowledge-base). Set **Content Selector** to the page's main content and **Render Wait** when asynchronous content needs extra time.

Rendering does not click buttons or scroll. Hash-only navigation links are not crawled. If a first sync indexes no text, check whether the chosen selector exists and the page content appears within the render wait.
