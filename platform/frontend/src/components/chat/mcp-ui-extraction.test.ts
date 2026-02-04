import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { tryToExtractMcpUiMetadata } from "./chat-messages.utils";

describe("tryToExtractMcpUiMetadata", () => {
    it("should return undefined for undefined or null output", () => {
        expect(tryToExtractMcpUiMetadata(undefined)).toBeUndefined();
        expect(tryToExtractMcpUiMetadata(null)).toBeUndefined();
    });

    it("should return undefined for non-object output", () => {
        expect(tryToExtractMcpUiMetadata("string")).toBeUndefined();
        expect(tryToExtractMcpUiMetadata(123)).toBeUndefined();
        expect(tryToExtractMcpUiMetadata(true)).toBeUndefined();
    });

    it("should return undefined for object without uiMetadata", () => {
        expect(tryToExtractMcpUiMetadata({ foo: "bar" })).toBeUndefined();
    });

    it("should return metadata when output is a valid object", () => {
        const output = {
            uiMetadata: {
                type: "html",
                html: "<div>Test</div>",
            },
        };
        expect(tryToExtractMcpUiMetadata(output)).toEqual(output);
    });

    it("should extract metadata from JSON string", () => {
        const output = JSON.stringify({
            uiMetadata: {
                type: "html",
                html: "<div>Test</div>",
            },
        });

        expect(tryToExtractMcpUiMetadata(output)).toEqual({
            uiMetadata: {
                type: "html",
                html: "<div>Test</div>",
            },
        });
    });

    it("should return undefined for invalid JSON string", () => {
        expect(tryToExtractMcpUiMetadata("{invalid_json")).toBeUndefined();
    });

    it("should return undefined/ignore if JSON string does not contain uiMetadata", () => {
        const output = JSON.stringify({ foo: "bar" });
        expect(tryToExtractMcpUiMetadata(output)).toBeUndefined();
    });

    it("should handle nested structures correctly if passed directly", () => {
        const output = {
            content: {
                uiMetadata: { type: "test" }
            }
        };
        // The current implementation checks "uiMetadata" in the top level object
        // It does NOT search recursively.
        expect(tryToExtractMcpUiMetadata(output)).toBeUndefined();

        expect(tryToExtractMcpUiMetadata(output.content)).toEqual({
            uiMetadata: { type: "test" }
        });
    });
});
