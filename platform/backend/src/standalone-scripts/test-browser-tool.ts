
import { executeArchestraTool } from "../archestra-mcp-server";
import { TOOL_BROWSE_WEB_NAME, ARCHESTRA_MCP_SERVER_NAME, MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";

const TOOL_BROWSE_WEB_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_BROWSE_WEB_NAME}`;

async function run() {
    console.log("Testing browse_web tool...");

    const context = {
        profile: {
            id: "test-profile",
            name: "Test Profile",
        },
    };

    const result = await executeArchestraTool(
        TOOL_BROWSE_WEB_FULL_NAME,
        { url: "https://example.com" },
        context
    );

    console.log("Result:", JSON.stringify(result, null, 2));

    if (result.isError) {
        console.error("Test failed!");
        process.exit(1);
    } else {
        console.log("Test passed!");
    }
}

run().catch((error) => {
    console.error("Error running test:", error);
    process.exit(1);
});
