---
title: "Deleted Items"
category: Administration
description: "Restore deleted agents, apps, chats, projects, and skills, or remove them for good"
order: 10
lastUpdated: 2026-07-31
---

Deleting an agent, app, chat, project, or skill does not remove it right away. It moves to Deleted Items, where an admin can bring it back or remove it for good. Deleted Items lives in **Settings > Deleted Items**.

Everything a deleted item owns travels with it. A deleted project keeps its files, a deleted chat keeps its messages, and a deleted skill keeps its resource files — so a restore returns the whole thing, not an empty shell.

## Restoring an Item

Find the item in the list and choose **Restore**. It returns to its own page immediately.

A restore can fail. Deleting an item frees its name, so something created since may already hold it. Rename the newer item, then restore again.

Two things do not come back. A restored chat comes back private — deleting it revoked its share link, and restoring does not hand that link out again. Apps cannot be restored at all: deleting an app also removes the MCP server behind it, so there is nothing left to restore it onto.

## Removing an Item for Good

Choose **Delete permanently** to remove an item now, along with any files it stored. This cannot be undone.

## Retention

Deleted items are kept for a set number of days, then removed automatically. The default is 30 days. Change it at the top of the page.

Turn off automatic cleanup to keep deleted items indefinitely. Nothing is removed on a schedule then — only a permanent delete reclaims it.

Everyone sees how long they have: the message shown after a delete reports the current window, so a member who deletes something knows when it stops being recoverable.

## Permissions

Reading Deleted Items takes the `organizationSettings` read permission. Restoring, deleting permanently, and changing the retention window take `organizationSettings` update. This is an organization-wide view of every member's deleted items, which is why it sits behind an organization-level permission rather than a per-resource one. See [Access Control](./platform-access-control) for permissions.

Deleting is unaffected — anyone who can delete something still can, and the message they get afterward offers to undo it.

## Use Case

A member deletes the **Q3 Vendor Review** project, thinking the work is finished. Two weeks later the finance team asks for the cost breakdown that lived in it.

An admin opens Settings > Deleted Items, finds the project, and chooses **Restore**. The project returns with its files and its monthly schedule, which resumes on its next run rather than firing for every date it missed. The chats started in it were kept as ordinary conversations the whole time.

Had the organization's retention window been 7 days instead of 30, the project would have been gone — which is the tradeoff the window sets.
