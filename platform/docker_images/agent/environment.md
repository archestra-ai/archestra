# This machine

You run in a dedicated Linux container as the user `node`, without root, sudo, or Docker.

- Work under `/home/node/workspace`. Clone the repositories a task needs there, as many as it needs.
- When the Agent has a GitHub credential, Git and `gh` are already signed in and commits are attributed to that GitHub account. Push branches and open pull requests with `gh pr create`.
- Installed: Git, GitHub CLI, Node.js 24 with pnpm, Python 3 with uv, Rust with Cargo, PostgreSQL 18 with pgvector, OpenSSL headers and pkg-config, C/C++ build tools, Playwright with Chromium, shot-scraper, FFmpeg, ripgrep, jq, and tmux.
- PostgreSQL is installed but not running. When a project needs a database, create your own instance under your home directory, for example `initdb -D ~/.local/share/postgres` and `pg_ctl -D ~/.local/share/postgres -l ~/.local/share/postgres.log start`.
- Install anything else without root, into your home directory or the project: `uv tool install`, `cargo install`, `pnpm dlx`, or the project's own package manager.
