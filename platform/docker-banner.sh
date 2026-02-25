#!/bin/sh

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# URLs with defaults
FRONTEND_URL="${ARCHESTRA_FRONTEND_URL:-http://localhost:3000}"
BACKEND_URL="${ARCHESTRA_INTERNAL_API_BASE_URL:-http://localhost:9000}"

# Detect ngrok tunnel URL if ngrok is enabled
TUNNEL_URL=""
if [ -n "$ARCHESTRA_NGROK_AUTH_TOKEN" ]; then
    for i in $(seq 1 15); do
        NGROK_RESPONSE=$(wget -qO- http://localhost:4040/api/tunnels 2>/dev/null || true)
        if [ -n "$NGROK_RESPONSE" ]; then
            TUNNEL_URL=$(echo "$NGROK_RESPONSE" | sed -n 's/.*"public_url":"\([^"]*\)".*/\1/p' | head -1)
            [ -n "$TUNNEL_URL" ] && break
        fi
        sleep 1
    done
fi

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
fi
echo ""
echo "   Our team is working hard to make Archestra great for you!"
echo "   Please reach out to us with any questions, requests or feedback"
echo ""
printf "   ${BLUE}Slack Community:${NC} https://archestra.ai/join-slack\n"
printf "   ${BLUE}Give us a star on GitHub:${NC} https://github.com/archestra-ai/archestra\n"
echo ""
echo ""

