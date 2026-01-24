#!/bin/bash
# =============================================================================
# MCP UI Demo Setup Script
# For Archestra PR #2248 - MCP UI Support
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVERS_DIR="$SCRIPT_DIR/servers"

echo "=========================================="
echo "MCP UI Demo Setup for Archestra PR #2248"
echo "=========================================="
echo ""

# Check prerequisites
check_prerequisites() {
    echo "[1/5] Checking prerequisites..."

    local missing=()

    if ! command -v git &> /dev/null; then
        missing+=("git")
    fi

    if ! command -v node &> /dev/null; then
        missing+=("node")
    fi

    if ! command -v npm &> /dev/null; then
        missing+=("npm")
    fi

    # Check for pnpm (preferred) or npm
    if command -v pnpm &> /dev/null; then
        PKG_MANAGER="pnpm"
    elif command -v npm &> /dev/null; then
        PKG_MANAGER="npm"
    else
        missing+=("pnpm or npm")
    fi

    if [ ${#missing[@]} -ne 0 ]; then
        echo "ERROR: Missing prerequisites: ${missing[*]}"
        echo "Please install them and try again."
        exit 1
    fi

    echo "  - git: $(git --version)"
    echo "  - node: $(node --version)"
    echo "  - Package manager: $PKG_MANAGER"
    echo "  [OK] All prerequisites met"
    echo ""
}

# Create servers directory
create_directories() {
    echo "[2/5] Creating directories..."
    mkdir -p "$SERVERS_DIR"
    echo "  [OK] Created $SERVERS_DIR"
    echo ""
}

# Clone MCP-UI repository
clone_mcp_ui() {
    echo "[3/5] Cloning MCP-UI repository..."

    if [ -d "$SERVERS_DIR/mcp-ui" ]; then
        echo "  [SKIP] mcp-ui already exists, pulling latest..."
        cd "$SERVERS_DIR/mcp-ui"
        git pull origin main || true
    else
        cd "$SERVERS_DIR"
        git clone https://github.com/MCP-UI-Org/mcp-ui.git
    fi

    echo "  [OK] MCP-UI repository ready"
    echo ""
}

# Clone ext-apps repository (official MCP Apps SDK)
clone_ext_apps() {
    echo "[4/5] Cloning MCP ext-apps repository..."

    if [ -d "$SERVERS_DIR/ext-apps" ]; then
        echo "  [SKIP] ext-apps already exists, pulling latest..."
        cd "$SERVERS_DIR/ext-apps"
        git pull origin main || true
    else
        cd "$SERVERS_DIR"
        git clone https://github.com/modelcontextprotocol/ext-apps.git
    fi

    echo "  [OK] ext-apps repository ready"
    echo ""
}

# Install dependencies
install_dependencies() {
    echo "[5/5] Installing dependencies..."

    # MCP-UI TypeScript demo server
    echo "  Installing mcp-ui/typescript-server-demo..."
    cd "$SERVERS_DIR/mcp-ui/examples/typescript-server-demo"
    if [ "$PKG_MANAGER" = "pnpm" ]; then
        pnpm install 2>/dev/null || npm install
    else
        npm install
    fi

    # ext-apps threejs server
    echo "  Installing ext-apps/threejs-server..."
    cd "$SERVERS_DIR/ext-apps/examples/threejs-server"
    npm install 2>/dev/null || true

    # ext-apps map server
    echo "  Installing ext-apps/map-server..."
    cd "$SERVERS_DIR/ext-apps/examples/map-server"
    npm install 2>/dev/null || true

    echo "  [OK] Dependencies installed"
    echo ""
}

# Main execution
main() {
    check_prerequisites
    create_directories
    clone_mcp_ui
    clone_ext_apps
    install_dependencies

    echo "=========================================="
    echo "Setup Complete!"
    echo "=========================================="
    echo ""
    echo "Available MCP UI servers:"
    echo ""
    echo "1. MCP-UI TypeScript Demo (all UIResource types)"
    echo "   Location: $SERVERS_DIR/mcp-ui/examples/typescript-server-demo"
    echo "   Tools: showExternalUrl, showRawHtml, showRemoteDom"
    echo ""
    echo "2. Three.js Server (3D visualization)"
    echo "   Location: $SERVERS_DIR/ext-apps/examples/threejs-server"
    echo ""
    echo "3. Map Server (geographic UI)"
    echo "   Location: $SERVERS_DIR/ext-apps/examples/map-server"
    echo ""
    echo "Next steps:"
    echo "  1. Run: ./run-servers.sh"
    echo "  2. Follow: ./DEMO_GUIDE.md"
    echo ""
}

main "$@"
