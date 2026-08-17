---
title: Batch Analysis
category: Agents
order: 12
description: Ask the same questions of many documents and get a table of answers back
lastUpdated: 2026-08-16
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A batch analysis asks the same set of questions of every source in a set. You get a table back: one row per source, one column per question. Each answer links to the text it came from, so you can check it.

![The batch analyses list](/docs/automated_screenshots/platform-batch-analysis_list.webp)

## Columns

A column is a question, asked of every source. Give it a name and the question itself — "Data residency region", asking "Where is customer data stored?" — and you get one column of regions across the whole set.

Each column has an output format: text, yes/no, date, number, list, or exact quote. Exact quote returns the source's own words rather than a summary.

## Rows

A row is a source to analyse. Add sources when you create the analysis, or later as the set grows. Re-running an analysis only fills in what is missing, so adding rows does not redo the answers you already have.

## The Agent

An analysis names an agent. That agent supplies the model the run uses and the credential it spends. Anyone who can open the analysis can run it, so the audience you give it decides who can spend against that credential.

## Visibility

An analysis is visible to you alone by default. Change it to a team or the whole organization when you are ready to share.

Visibility covers every action, not just the listing: an analysis you cannot see is one you cannot open, run, edit or delete.

## Editing

Edit an analysis to change its name, its agent, its columns or its visibility. A renamed column keeps the answers already written against it.

Changing the columns does not re-run anything. Existing answers stay until you run the analysis again.

![Editing an analysis](/docs/automated_screenshots/platform-batch-analysis_edit.webp)

## Use Case: Comparing Vendor Security Posture

A security analyst has forty vendor questionnaires and three questions to ask of each.

1. Create an analysis with three columns: data residency region, sub-processor disclosure, and breach notification window.
2. Add the forty documents as rows.
3. Run it, and read the table.
4. Open any cell to see the passage the answer came from.

Sharing the analysis with the security team lets a colleague add next quarter's vendors and re-run it.
