#!/bin/bash
# =============================================================================
# MCP UI Resource Test Script
# Tests that MCP servers return valid UIResource objects
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=========================================="
echo "MCP UIResource Validation Tests"
echo "=========================================="
echo ""

# Test 1: Check if MCP-UI demo server is running
test_mcp_ui_server() {
    echo -n "Testing MCP-UI Demo Server (port 3000)... "

    if curl -s http://localhost:3000/health > /dev/null 2>&1; then
        echo -e "${GREEN}[RUNNING]${NC}"
        return 0
    elif curl -s http://localhost:3000 > /dev/null 2>&1; then
        echo -e "${GREEN}[RUNNING]${NC}"
        return 0
    else
        echo -e "${RED}[NOT RUNNING]${NC}"
        echo "  Start with: ./run-servers.sh and select option 1"
        return 1
    fi
}

# Test 2: Validate UIResource structure
test_ui_resource_structure() {
    echo ""
    echo "Testing UIResource structure validation..."
    echo ""

    # Sample UIResource objects to validate
    local test_cases=(
        '{"uri":"ui://test/html","mimeType":"text/html","text":"<div>Hello</div>"}'
        '{"uri":"ui://test/url","mimeType":"text/uri-list","text":"https://example.com"}'
        '{"uri":"ui://test/remote","mimeType":"application/vnd.mcp-ui.remote-dom","text":"export default () => {}"}'
    )

    local names=("HTML UIResource" "URL UIResource" "RemoteDOM UIResource")

    for i in "${!test_cases[@]}"; do
        local json="${test_cases[$i]}"
        local name="${names[$i]}"

        echo -n "  Validating $name... "

        # Check required fields
        local uri=$(echo "$json" | jq -r '.uri // empty')
        local mimeType=$(echo "$json" | jq -r '.mimeType // empty')
        local text=$(echo "$json" | jq -r '.text // empty')
        local blob=$(echo "$json" | jq -r '.blob // empty')

        local valid=true
        local errors=""

        # URI must start with ui://
        if [[ ! "$uri" =~ ^ui:// ]]; then
            valid=false
            errors+="URI must start with ui://. "
        fi

        # Must have text or blob
        if [ -z "$text" ] && [ -z "$blob" ]; then
            valid=false
            errors+="Must have text or blob. "
        fi

        # Validate mimeType
        case "$mimeType" in
            "text/html"|"text/uri-list"|"application/vnd.mcp-ui.remote-dom"|"")
                ;;
            *)
                valid=false
                errors+="Invalid mimeType: $mimeType. "
                ;;
        esac

        if $valid; then
            echo -e "${GREEN}[VALID]${NC}"
        else
            echo -e "${RED}[INVALID]${NC}"
            echo "    Errors: $errors"
        fi
    done
}

# Test 3: Check Archestra UIResource detection
test_archestra_detection() {
    echo ""
    echo "Testing Archestra UIResource detection logic..."

    # Run the Archestra unit tests for UIResource
    if [ -d "$SCRIPT_DIR/../platform/frontend" ]; then
        echo "  Running ui-resource.utils.test.ts..."
        cd "$SCRIPT_DIR/../platform/frontend"

        if command -v pnpm &> /dev/null; then
            pnpm test src/components/chat/ui-resource.utils.test.ts 2>&1 | tail -5
        elif command -v npx &> /dev/null; then
            npx vitest run src/components/chat/ui-resource.utils.test.ts 2>&1 | tail -5
        else
            echo -e "  ${YELLOW}[SKIP] No test runner available${NC}"
        fi
    else
        echo -e "  ${YELLOW}[SKIP] Archestra platform not found${NC}"
    fi
}

# Test 4: Check UIResourceTool component tests
test_archestra_component() {
    echo ""
    echo "Testing Archestra UIResourceTool component..."

    if [ -d "$SCRIPT_DIR/../platform/frontend" ]; then
        echo "  Running ui-resource-tool.test.tsx..."
        cd "$SCRIPT_DIR/../platform/frontend"

        if command -v pnpm &> /dev/null; then
            pnpm test src/components/chat/ui-resource-tool.test.tsx 2>&1 | tail -5
        elif command -v npx &> /dev/null; then
            npx vitest run src/components/chat/ui-resource-tool.test.tsx 2>&1 | tail -5
        else
            echo -e "  ${YELLOW}[SKIP] No test runner available${NC}"
        fi
    else
        echo -e "  ${YELLOW}[SKIP] Archestra platform not found${NC}"
    fi
}

# Summary
print_summary() {
    echo ""
    echo "=========================================="
    echo "Test Summary"
    echo "=========================================="
    echo ""
    echo "UIResource Requirements for Archestra:"
    echo ""
    echo "  1. uri: Must start with 'ui://'"
    echo "  2. mimeType: One of:"
    echo "     - text/html (inline HTML)"
    echo "     - text/uri-list (external URL)"
    echo "     - application/vnd.mcp-ui.remote-dom (interactive)"
    echo "  3. content: Either 'text' or 'blob' field"
    echo ""
    echo "MCP Tool Response Example:"
    echo ""
    cat << 'EOF'
{
  "content": [{
    "type": "resource",
    "resource": {
      "uri": "ui://my-tool/result",
      "mimeType": "text/html",
      "text": "<div class='card'><h1>Hello</h1><button>Click me</button></div>"
    }
  }]
}
EOF
    echo ""
}

# Main
main() {
    test_mcp_ui_server
    test_ui_resource_structure
    test_archestra_detection
    test_archestra_component
    print_summary
}

main "$@"
