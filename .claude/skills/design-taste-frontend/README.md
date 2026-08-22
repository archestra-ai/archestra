# design-taste-frontend (vendored)

Third-party skill, vendored from [`leonxlnx/taste-skill`](https://github.com/leonxlnx/taste-skill).

| | |
|---|---|
| Upstream path | `skills/taste-skill/SKILL.md` |
| Pinned commit | `843c8dd4d18ccff0d5a9cd4b0b71d7dbf7278293` |
| Upstream file sha256 | `aa194351b246b8b4799099d4ed7b033d29eab6e6e3d58d8d2172978be7b3ec89` |
| License | MIT — see `UPSTREAM-LICENSE-MIT.txt` |

## Why it is pinned, and why it is vendored rather than fetched

A skill is a prompt that steers an agent holding this repo's credentials. Tracking upstream
`main` would let a force-push rewrite those instructions with nobody reviewing the diff, so the
file is committed here at a reviewed commit. Moving the pin means reading the upstream diff
first — treat a bump like any other dependency bump, not a formality.

## The one local deviation

Only the frontmatter `description:` differs from upstream. Everything below the frontmatter is
byte-identical to the pinned file (verify with the sha256 above after restoring the original
description line).

Claude Code routes skills by their `description`, and this repo already has
`archestra-dev-frontend` covering day-to-day Next.js/React work. Upstream's description
("anti-slop frontend skill … redesigns") is broad enough to pull this skill into routine
platform UI changes, where it does not belong — upstream itself says, in the first line of the
body, "Not dashboards, not data tables, not multi-step product UI," which is most of
`platform/frontend/`. The local description states that boundary explicitly and names
`archestra-dev-frontend` as the alternative.

Use this skill for: marketing and landing pages, generated apps, standalone or portfolio-style
surfaces — greenfield work where visual direction is the point.

## Caveat when applying it in this repo

The skill recommends installing official design-system packages (`@fluentui/*`, `@atlaskit/*`,
`@material/web`, …). Any such install is subject to this repo's dependency policy — `pnpm` with
`ignoreScripts: true` and a 7-day `minimumReleaseAge` (see `platform/CLAUDE.md`). Do not add a
dependency just to satisfy a design suggestion; the platform frontend already has its own
component stack.

## It is also installed, separately, inside crab-env VMs

`infra`'s `services/crab-env-controller/vm/startup.sh` sparse-clones this same upstream repo
**at this same commit** and copies all 13 of its skill directories into `~/.claude/skills/` on
every crab-env VM (personal scope, so they apply to any repo a session works on — website and
infra included, which this vendored copy does not cover).

Two consequences worth knowing:

- **Keep the two pins in step.** `TASTE_SKILL_SHA` in that startup script and the commit pinned
  above are currently the same commit. Bumping one without the other means a crab-env session
  and a laptop session are steered by different instructions.
- **Inside a crab-env working on this repo, two skills declare `name: design-taste-frontend`** —
  the personal copy from the VM and this project copy. The frontmatter `name`, not the directory
  name, is what collides, so renaming a directory does not resolve it; one shadows the other. If
  the personal copy wins, it carries upstream's unscoped description and the routing boundary
  described above does not apply. Deciding which copy a crab-env should keep is an `infra`
  change, not a change here.

## Re-syncing

```bash
git clone --filter=blob:none --sparse https://github.com/leonxlnx/taste-skill.git
cd taste-skill && git sparse-checkout set skills && git checkout <new-sha>
# review the diff for skills/taste-skill/SKILL.md, then copy it over and
# re-apply the local description line documented above
```

Upstream ships 12 further skills under `skills/` (brandkit, brutalist, minimalist, image-gen,
Stitch, …). They are deliberately not vendored — several are aggressive global behavior
overrides or image-generation prompts with no use in this repo.
