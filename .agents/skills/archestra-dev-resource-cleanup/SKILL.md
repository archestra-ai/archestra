---
name: archestra-dev-resource-cleanup
description: Reclaim unused Archestra development worktrees, local branches, processes, and OrbStack Kubernetes resources while preserving the active Tilt stack and unfinished work.
---

# Reclaim development resources

Run commands from `platform/`. First identify the active worktree and the Tilt-owned ports, processes, and Kubernetes resources. Keep those running. Inventory other worktrees with `git worktree list --porcelain`, check each status and live process working directories, and preserve any uncommitted files before removal. Prune stale worktree registrations. Delete local branches only when their work is available in a remote branch or another retained ref; never push or delete remote branches as part of cleanup.

For orphan processes, verify their working directory and listener before stopping them. For OrbStack, inspect the current Kubernetes context, namespace, labels, owners, and active app references before deleting resources. Keep shared dependencies such as the Tilt PostgreSQL instance, active agent runtimes, and their volumes. Recheck the intended local ports and Tilt health after cleanup, then report what was removed and what was retained.
