import { describe, expect, test } from "@/test";
import { cohereAdapterFactory } from "./cohere";

describe("CohereStreamAdapter", () => {
    describe("processChunk", () => {
        test("handles tool call with existing ID", () => {
            const adapter = cohereAdapterFactory.createStreamAdapter();

            const chunk = {
                type: "tool-call-start",
                tool_call: {
                    id: "existing-id",
                    function: {
                        name: "test_tool"
                    }
                }
            };

            adapter.processChunk(chunk);

            expect(adapter.state.toolCalls).toHaveLength(1);
            expect(adapter.state.toolCalls[0].id).toBe("existing-id");
        });

        test("generates ID for tool call with missing ID", () => {
            const adapter = cohereAdapterFactory.createStreamAdapter();

            const chunk = {
                type: "tool-call-start",
                tool_call: {
                    // No id provided
                    function: {
                        name: "test_tool"
                    }
                }
            };

            adapter.processChunk(chunk as any);

            expect(adapter.state.toolCalls).toHaveLength(1);
            expect(adapter.state.toolCalls[0].id).toBeTruthy(); // Should be a non-empty string
            expect(adapter.state.toolCalls[0].id).not.toBe(""); // Should not be empty string
        });

        test("generates ID for tool call with empty string ID", () => {
            const adapter = cohereAdapterFactory.createStreamAdapter();

            const chunk = {
                type: "tool-call-start",
                tool_call: {
                    id: "",
                    function: {
                        name: "test_tool"
                    }
                }
            };

            adapter.processChunk(chunk);

            expect(adapter.state.toolCalls).toHaveLength(1);
            expect(adapter.state.toolCalls[0].id).toBeTruthy(); // Should be a non-empty string
            expect(adapter.state.toolCalls[0].id).not.toBe(""); // Should not be empty string
        });
    });
});
