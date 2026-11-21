---
title: Adoption
description: See who has connected agents and client apps, and how much each one is used
order: 2
lastUpdated: 2026-11-21
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Adoption shows who has connected agents and client apps through the **Connect** page, and how much each one is used. Open **Insights → Adoption**.

- **Usage** groups calls with **Show** and **by**. Select a bar or row to drill down, and click **Back** to step out.
- **Coverage** lists every user, including those with no calls. **Export CSV** saves the filtered list.

The page follows the selected date range, except the **State** column on **Coverage**, which always reflects the last 30 days.

Each connect and disconnect event is also a row in [Logs](/docs/insights/logs), under the **Client connections** type.

Adoption covers every member, so it needs [`log:admin`](/docs/reference/permissions#log:admin) and [`member:read`](/docs/reference/permissions#member:read).
