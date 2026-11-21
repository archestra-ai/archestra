#!/bin/sh
# Kept for commands that still name it; start-production.mjs starts the server.
exec node "$(dirname "$0")/start-production.mjs" "$@"
