#!/bin/sh

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# URLs with defaults
FRONTEND_URL="${ARCHESTRA_FRONTEND_URL:-http://localhost:3000}"
BACKEND_URL="${ARCHESTRA_INTERNAL_API_BASE_URL:-http://localhost:9000}"

echo ""
printf "${GREEN}  Welcome to Archestra! <3 ${NC}\n"
echo ""
printf "   > ${BOLD}Frontend:${NC} ${FRONTEND_URL}\n"
printf "   > ${BOLD}Backend:${NC}  ${BACKEND_URL}\n"
echo ""
echo "   Our team is working hard to make Archestra great for you!"
echo "   Please reach out to us with any questions, requests or feedback"
echo ""
printf "   ${BLUE}Slack Community:${NC} https://join.slack.com/t/archestracommunity/shared_invite/zt-39yk4skox-zBF1NoJ9u4t59OU8XxQChg\n"
printf "   ${BLUE}Give us a star on GitHub:${NC} https://github.com/archestra-ai/archestra\n"
echo ""
echo ""

