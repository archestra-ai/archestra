#!/bin/sh

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# URLs with defaults
FRONTEND_URL="${ARCHESTRA_FRONTEND_URL:-http://localhost:3000}"
BACKEND_URL="${ARCHESTRA_API_BASE_URL:-http://localhost:9000}"

echo ""
echo -e "${GREEN}   Welcome to Archestra! <3 ${NC}"
echo ""
echo -e "   > ${BOLD}Frontend:${NC} ${FRONTEND_URL}"
echo -e "   > ${BOLD}Backend:${NC}  ${BACKEND_URL}"
echo ""
echo "   Our team is working hard to make Archestra great for you!"
echo "   Please reach out to us with any questions, requests or feedback"
echo ""
echo -e "   ${BLUE}Slack Community:${NC} https://join.slack.com/t/archestracommunity/shared_invite/zt-39yk4skox-zBF1NoJ9u4t59OU8XxQChg"
echo -e "   ${BLUE}Give us a star on GitHub:${NC} https://github.com/archestra-ai/archestra"
echo ""
echo ""

