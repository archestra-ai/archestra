#!/bin/sh

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[1;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Sized to the live TTY width; falls back to 80 when there's no TTY
# (e.g. `docker logs` re-render). Matches the docker-entrypoint quickstart
# banner so the two share a visual frame.
BANNER_COLS=$(stty size 2>/dev/null | awk '{print $2}')
[ -z "$BANNER_COLS" ] && BANNER_COLS="${COLUMNS:-80}"
case "$BANNER_COLS" in ''|*[!0-9]*) BANNER_COLS=80 ;; esac
[ "$BANNER_COLS" -lt 40 ] && BANNER_COLS=40
BANNER_BAR=$(printf '═%.0s' $(seq 1 "$BANNER_COLS"))

# URLs with defaults
FRONTEND_URL="${ARCHESTRA_FRONTEND_URL:-http://localhost:3000}"
BACKEND_URL="${ARCHESTRA_INTERNAL_API_BASE_URL:-http://localhost:9000}"

# The backend brings up the ngrok tunnel in-process. With a reserved domain the
# public URL is known up-front and shown here; with an ephemeral domain it is
# only known once the tunnel connects (logged by the backend, and shown on the
# in-app MS Teams setup page).
TUNNEL_URL=""
if [ -n "$ARCHESTRA_NGROK_DOMAIN" ]; then
    TUNNEL_URL="https://${ARCHESTRA_NGROK_DOMAIN}"
fi

echo ""
printf "${CYAN}%s${NC}\n" "$BANNER_BAR"
echo ""
printf "${GREEN}  Welcome to Archestra! <3 ${NC}\n"
echo ""
printf "   > ${BOLD}Frontend:${NC} ${FRONTEND_URL}\n"
printf "   > ${BOLD}Backend:${NC}  ${BACKEND_URL}\n"
if [ -n "$TUNNEL_URL" ]; then
    printf "   > ${BOLD}Tunnel:${NC}   ${TUNNEL_URL}\n"
    echo ""
    printf "   ${BLUE}${BOLD}MS Teams Webhook:${NC} ${BLUE}${TUNNEL_URL}/api/webhooks/chatops/ms-teams${NC}\n"
    echo "   (Set this as the Messaging Endpoint in your Azure Bot Configuration)"
elif [ -n "$ARCHESTRA_NGROK_AUTH_TOKEN" ]; then
    printf "   > ${BOLD}Tunnel:${NC}   starting ngrok... (public URL appears on the MS Teams setup page once connected)\n"
fi
echo ""
echo "   Our team is working hard to make Archestra great for you!"
echo "   Please reach out with any questions, requests, or feedback."
echo ""
printf "   ${BLUE}Slack Community:${NC} https://archestra.ai/join-slack\n"
printf "   ${BLUE}Give us a star on GitHub:${NC} https://github.com/archestra-ai/archestra\n"
echo ""
printf "${CYAN}%s${NC}\n" "$BANNER_BAR"
echo ""
