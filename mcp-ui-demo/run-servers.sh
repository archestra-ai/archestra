#!/bin/bash
# =============================================================================
# MCP UI Demo - Run Servers Script
# For Archestra PR #2248 - MCP UI Support
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVERS_DIR="$SCRIPT_DIR/servers"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo -e "${BLUE}==========================================${NC}"
    echo -e "${BLUE}MCP UI Demo - Server Runner${NC}"
    echo -e "${BLUE}==========================================${NC}"
    echo ""
}

print_menu() {
    echo "Available servers:"
    echo ""
    echo -e "  ${GREEN}1)${NC} MCP-UI TypeScript Demo Server (Port 3000)"
    echo "     - Tools: showExternalUrl, showRawHtml, showRemoteDom"
    echo "     - Best for: Testing all UIResource types"
    echo ""
    echo -e "  ${GREEN}2)${NC} Three.js 3D Visualization Server (Port 3001)"
    echo "     - Interactive 3D graphics"
    echo "     - Best for: Visual demo"
    echo ""
    echo -e "  ${GREEN}3)${NC} Map Server (Port 3002)"
    echo "     - Geographic visualization"
    echo "     - Best for: Interactive maps"
    echo ""
    echo -e "  ${GREEN}4)${NC} Run ALL servers (recommended for demo)"
    echo ""
    echo -e "  ${GREEN}5)${NC} Stop all servers"
    echo ""
    echo -e "  ${GREEN}q)${NC} Quit"
    echo ""
}

check_setup() {
    if [ ! -d "$SERVERS_DIR/mcp-ui" ]; then
        echo -e "${RED}ERROR: Servers not set up. Run ./setup.sh first${NC}"
        exit 1
    fi
}

run_mcp_ui_demo() {
    echo -e "${YELLOW}Starting MCP-UI TypeScript Demo Server on port 3000...${NC}"
    cd "$SERVERS_DIR/mcp-ui/examples/typescript-server-demo"

    # Check if pnpm is available
    if command -v pnpm &> /dev/null; then
        pnpm dev &
    else
        npm run dev &
    fi

    MCP_UI_PID=$!
    echo $MCP_UI_PID > "$SCRIPT_DIR/.mcp-ui.pid"
    echo -e "${GREEN}[OK] MCP-UI Demo Server started (PID: $MCP_UI_PID)${NC}"
    echo -e "${GREEN}     URL: http://localhost:3000${NC}"
}

run_threejs_server() {
    echo -e "${YELLOW}Starting Three.js Server on port 3001...${NC}"
    cd "$SERVERS_DIR/ext-apps/examples/threejs-server"

    PORT=3001 npm start &
    THREEJS_PID=$!
    echo $THREEJS_PID > "$SCRIPT_DIR/.threejs.pid"
    echo -e "${GREEN}[OK] Three.js Server started (PID: $THREEJS_PID)${NC}"
    echo -e "${GREEN}     URL: http://localhost:3001${NC}"
}

run_map_server() {
    echo -e "${YELLOW}Starting Map Server on port 3002...${NC}"
    cd "$SERVERS_DIR/ext-apps/examples/map-server"

    PORT=3002 npm start &
    MAP_PID=$!
    echo $MAP_PID > "$SCRIPT_DIR/.map.pid"
    echo -e "${GREEN}[OK] Map Server started (PID: $MAP_PID)${NC}"
    echo -e "${GREEN}     URL: http://localhost:3002${NC}"
}

stop_all_servers() {
    echo -e "${YELLOW}Stopping all servers...${NC}"

    # Kill by PID files
    for pidfile in "$SCRIPT_DIR"/.*.pid; do
        if [ -f "$pidfile" ]; then
            pid=$(cat "$pidfile")
            if kill -0 "$pid" 2>/dev/null; then
                kill "$pid" 2>/dev/null || true
                echo "  Stopped process $pid"
            fi
            rm -f "$pidfile"
        fi
    done

    # Also kill any node processes on our ports
    for port in 3000 3001 3002; do
        pid=$(lsof -ti:$port 2>/dev/null || true)
        if [ -n "$pid" ]; then
            kill $pid 2>/dev/null || true
            echo "  Stopped process on port $port"
        fi
    done

    echo -e "${GREEN}[OK] All servers stopped${NC}"
}

run_all_servers() {
    echo -e "${YELLOW}Starting all servers...${NC}"
    echo ""

    run_mcp_ui_demo
    sleep 2
    run_threejs_server
    sleep 2
    run_map_server

    echo ""
    echo -e "${GREEN}=========================================="
    echo "All servers running!"
    echo "==========================================${NC}"
    echo ""
    echo "Server URLs:"
    echo "  - MCP-UI Demo:  http://localhost:3000"
    echo "  - Three.js:     http://localhost:3001"
    echo "  - Map Server:   http://localhost:3002"
    echo ""
    echo "MCP Server Endpoints for Archestra:"
    echo "  - MCP-UI Demo:  http://localhost:3000/mcp (or stdio)"
    echo ""
    echo -e "${YELLOW}Press Ctrl+C to stop all servers${NC}"

    # Wait for interrupt
    trap stop_all_servers EXIT INT TERM
    wait
}

# Main
print_header
check_setup

while true; do
    print_menu
    read -p "Select option: " choice

    case $choice in
        1)
            run_mcp_ui_demo
            echo ""
            echo "Press Enter to return to menu..."
            read
            ;;
        2)
            run_threejs_server
            echo ""
            echo "Press Enter to return to menu..."
            read
            ;;
        3)
            run_map_server
            echo ""
            echo "Press Enter to return to menu..."
            read
            ;;
        4)
            run_all_servers
            ;;
        5)
            stop_all_servers
            ;;
        q|Q)
            stop_all_servers
            echo "Goodbye!"
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid option${NC}"
            ;;
    esac
done
