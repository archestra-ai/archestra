---
name: archestra-record-demo
description: Use when asked to record a demo, screencast, or video of an Archestra feature (on localhost or staging) and share it in Slack.
---

# Record a demo

Record a captioned MP4 of a real Archestra feature with shot-scraper and share it in Slack. Scripts live in `scripts/` next to this file. Recording needs the sandbox disabled (Chrome, uvx caches, TLS).

## 1. Ask first

Ask in one go (AskUserQuestion):

- **Target**: `http://localhost:3000` or `https://frontend.archestra.dev` (staging).
- **Destination**: the user's DM with themselves, or the Slack thread of an Archestra PM issue (get the issue key or thread link).
- **What to show**: the feature/PR and the outcome a viewer must see.

Staging is shared: before recording a flow that creates, changes, or deletes data, confirm it and plan cleanup.

## 2. Log in

Auth file: `~/.cache/archestra-demo/<host>.json`. Reuse it if its `*session_token` cookie has not expired. Localhost with `ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL` set needs no login.

Otherwise ask the user to run this in a **regular terminal** (`!` cannot pass the Enter keypress):

```bash
mkdir -p ~/.cache/archestra-demo && <skill-dir>/scripts/login.sh https://frontend.archestra.dev ~/.cache/archestra-demo/frontend.archestra.dev.json
```

It strips every cookie not belonging to the target host (Google SSO otherwise saves the whole Google session).

## 3. Storyboard

Write `demo.yml` in the session scratchpad. Format: `uvx shot-scraper video --help`. Extra action: `- caption: "text"` renders a bottom overlay (`""` hides it).

```yaml
url: https://frontend.archestra.dev/agents
viewport: {width: 1440, height: 900}
cursor: true
wait_for: "role=heading[name='Agents']"
scenes:
- name: Open the connect dialog
  do:
  - caption: "Paste an Agent Card URL; details fill in from the card"
  - click: "role=button[name='Connect agent']"
  - pause: 2.5
```

- Start on the relevant page, with data already seeded. No login screens, spinners, or empty tables.
- One caption per scene: the user-visible outcome and why it matters, not the clicks.
- Show starting state, action, settled result. Wait for real requests (`wait_for`) before moving on; 2-3s per caption.
- Keep it under ~45s. Prefer `role=` selectors.
- Real app and real APIs only: no mocked responses or DOM edits that fake the feature.

## 4. Record and check

```bash
<skill-dir>/scripts/record.sh demo.yml ~/.cache/archestra-demo/<host>.json <scratchpad>/demo-out
```

Writes `demo.mp4` and `contact-sheet.png`. Read the contact sheet (extract more frames with ffmpeg if needed): the changed controls and outcome are visible, captions do not cover them, and each caption matches what is on screen. Re-record until it does.

## 5. Share

Only to the destination chosen in step 1. Never attach the video to a GitHub PR, issue, or commit, or post it to a channel. Repositories and PRs are public.

1. Resolve the destination:
   - **Self DM**: get your own user ID with `slack_read_user_profile`, then the `D…` channel from `slack_list_user_channels` (`types: "im"`).
   - **PM issue thread**: parse the thread link `…/archives/<channel>/p<ts>`, where `thread_ts` is `<ts>` with a dot before the last 6 digits. With only an issue key, find the thread with `slack_search_public_and_private` and confirm it with the user.
2. Show the user the contact sheet, destination, and comment. Upload only after they approve.
3. `slack_get_file_upload_url` (filename, exact byte size), then `curl -X POST "$URL" -H 'Content-Type: video/mp4' --data-binary @demo.mp4`, then `slack_complete_file_upload` with `channel_id`, `thread_ts` (thread only), and a one-line `initial_comment`.
4. Clean up any staging data the demo created.
