import { describe, expect, test } from "vitest";
import {
  buildUserSystemPromptContext,
  USER_SYSTEM_PROMPT_MEMORY_BLOCK_TEMPLATE,
} from ".";

describe("buildUserSystemPromptContext", () => {
  test("sets memory to null by default", () => {
    const context = buildUserSystemPromptContext({
      userName: "Alice",
      userEmail: "alice@example.com",
      userTeams: ["Platform"],
    });

    expect(context).toEqual({
      user: {
        name: "Alice",
        email: "alice@example.com",
        teams: ["Platform"],
      },
      memory: null,
    });
  });

  test("includes memory payload when provided", () => {
    const context = buildUserSystemPromptContext({
      userName: "Bob",
      userEmail: "bob@example.com",
      userTeams: [],
      memory: "<durable_memory>...</durable_memory>",
    });

    expect(context.memory).toBe("<durable_memory>...</durable_memory>");
  });
});

describe("USER_SYSTEM_PROMPT_MEMORY_BLOCK_TEMPLATE", () => {
  test("uses conditional memory block in handlebars syntax", () => {
    expect(USER_SYSTEM_PROMPT_MEMORY_BLOCK_TEMPLATE).toContain(
      "{{#if memory}}",
    );
    expect(USER_SYSTEM_PROMPT_MEMORY_BLOCK_TEMPLATE).toContain("{{memory}}");
    expect(USER_SYSTEM_PROMPT_MEMORY_BLOCK_TEMPLATE).toContain("{{/if}}");
  });
});
