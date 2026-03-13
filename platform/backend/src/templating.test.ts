import { describe, expect, test } from "@/test";
import {
  applyResponseModifierTemplate,
  buildRenderedPrompts,
  evaluateRoleMappingTemplate,
  extractGroupsWithTemplate,
  promptNeedsRendering,
  renderSystemPrompt,
} from "./templating";

describe("applyResponseModifierTemplate", () => {
  test("renders basic text template", () => {
    const content = [{ type: "text", text: "Hello World" }];
    const template = 'Modified: {{lookup (lookup response 0) "text"}}';

    const result = applyResponseModifierTemplate(template, content);

    expect(result).toEqual([{ type: "text", text: "Modified: Hello World" }]);
  });

  test("renders JSON template and parses result", () => {
    const content = [{ type: "text", text: "test data" }];
    const template =
      '{"formatted": true, "data": "{{lookup (lookup response 0) "text"}}"}';

    const result = applyResponseModifierTemplate(template, content);

    expect(result).toEqual({ formatted: true, data: "test data" });
  });

  test("accesses nested properties in response data with 'with' helper", () => {
    const content = [
      {
        type: "resource",
        resource: {
          uri: "file:///test.txt",
          mimeType: "text/plain",
          text: "File contents",
        },
      },
    ];
    const template =
      "{{#with (lookup response 0)}}URI: {{resource.uri}}{{/with}}";

    const result = applyResponseModifierTemplate(template, content);

    expect(result).toEqual([{ type: "text", text: "URI: file:///test.txt" }]);
  });

  test("uses json helper to stringify objects", () => {
    const content = [
      {
        type: "text",
        text: "data",
      },
    ];
    const template = "{{{json (lookup response 0)}}}";

    const result = applyResponseModifierTemplate(template, content);

    // json helper stringifies the object, then JSON.parse parses it back at the end
    expect(result).toEqual({
      type: "text",
      text: "data",
    });
  });

  test("parses and re-stringifies JSON from first element", () => {
    // Realistic GitHub MCP server response format
    const content = [
      {
        type: "text",
        text: '{"issues":[{"id":816,"title":"Add authentication for MCP gateways"},{"id":815,"title":"ERROR: role \\"postgres\\" already exists"}]}',
      },
    ];

    // Template to parse and re-stringify the JSON (using nested json calls)
    const template =
      "{{#with (lookup response 0)}}{{{json (json this.text)}}}{{/with}}";

    const result = applyResponseModifierTemplate(template, content);

    // First json parses the string, second json stringifies it back, triple braces prevent escaping
    expect(result).toEqual({
      issues: [
        { id: 816, title: "Add authentication for MCP gateways" },
        { id: 815, title: 'ERROR: role "postgres" already exists' },
      ],
    });
  });

  test("transforms GitHub issues data to id:title mapping using json helper", () => {
    const content = [
      {
        type: "text",
        text: '{"issues":[{"id":3550499726,"number":816,"state":"OPEN","title":"Add authentication for MCP gateways"},{"id":3550391199,"number":815,"state":"OPEN","title":"ERROR: role \\"postgres\\" already exists"},{"id":3545318824,"number":805,"state":"OPEN","title":"Bug: if I rename default agent, it gets re-created"}]}',
      },
    ];

    // Template that parses the JSON and creates id:title mapping
    // Use escapeJson helper with triple braces to properly escape quotes
    const template = `{{#with (lookup response 0)}}{{#with (json this.text)}}
{
  {{#each this.issues}}
    "{{this.id}}": "{{{escapeJson this.title}}}"{{#unless @last}},{{/unless}}
  {{/each}}
}
{{/with}}{{/with}}`;

    const result = applyResponseModifierTemplate(template, content);

    expect(result).toEqual({
      "3550499726": "Add authentication for MCP gateways",
      "3550391199": 'ERROR: role "postgres" already exists',
      "3545318824": "Bug: if I rename default agent, it gets re-created",
    });
  });

  test("returns original content when template produces invalid JSON", () => {
    const content = [{ type: "text", text: "test" }];
    const template = 'This is not JSON: {{lookup (lookup response 0) "text"}}';

    const result = applyResponseModifierTemplate(template, content);

    // Should return as text content block since it's not valid JSON
    expect(result).toEqual([{ type: "text", text: "This is not JSON: test" }]);
  });

  test("returns original content when template fails to compile", () => {
    const content = [{ type: "text", text: "test" }];
    const template = "{{#invalid}}"; // Invalid Handlebars syntax

    const result = applyResponseModifierTemplate(template, content);

    // Should return original content when template fails
    expect(result).toEqual(content);
  });

  test("handles multiple content blocks using with helpers", () => {
    const content = [
      { type: "text", text: "Line 1" },
      { type: "text", text: "Line 2" },
    ];
    const template =
      '{{#with (lookup response 0)}}{{#with (lookup ../response 1)}}{"first": "{{../this.text}}", "second": "{{this.text}}"}{{/with}}{{/with}}';

    const result = applyResponseModifierTemplate(template, content);

    expect(result).toEqual({ first: "Line 1", second: "Line 2" });
  });
});

describe("evaluateRoleMappingTemplate", () => {
  test("returns true when includes helper matches", () => {
    const context = { groups: ["admin", "users"] };
    const template = '{{#includes groups "admin"}}true{{/includes}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("returns false when includes helper does not match", () => {
    const context = { groups: ["users", "developers"] };
    const template = '{{#includes groups "admin"}}true{{/includes}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(false);
  });

  test("includes helper is case-insensitive", () => {
    const context = { groups: ["Admin", "Users"] };
    const template = '{{#includes groups "admin"}}true{{/includes}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("returns true when equals helper matches", () => {
    const context = { role: "administrator" };
    const template = '{{#equals role "administrator"}}true{{/equals}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("equals helper is case-insensitive for strings", () => {
    const context = { role: "Administrator" };
    const template = '{{#equals role "administrator"}}true{{/equals}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("returns false when equals helper does not match", () => {
    const context = { role: "member" };
    const template = '{{#equals role "administrator"}}true{{/equals}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(false);
  });

  test("handles contains helper for string matching", () => {
    const context = { email: "user@admin.example.com" };
    const template = '{{#contains email "admin"}}true{{/contains}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("handles and helper", () => {
    const context = { department: "IT", title: "Manager" };
    const template = "{{#and department title}}true{{/and}}";

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("and helper returns false when any value is falsy", () => {
    const context = { department: "IT", title: null };
    const template = "{{#and department title}}true{{/and}}";

    expect(evaluateRoleMappingTemplate(template, context)).toBe(false);
  });

  test("handles or helper", () => {
    const context = { isAdmin: false, isModerator: true };
    const template = "{{#or isAdmin isModerator}}true{{/or}}";

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("handles exists helper", () => {
    const context = { email: "user@example.com" };
    const template = "{{#exists email}}true{{/exists}}";

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("exists helper returns false for null/undefined", () => {
    const context = { email: null };
    const template = "{{#exists email}}true{{/exists}}";

    expect(evaluateRoleMappingTemplate(template, context)).toBe(false);
  });

  test("handles notEquals helper", () => {
    const context = { status: "active" };
    const template = '{{#notEquals status "disabled"}}true{{/notEquals}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("handles each loop for array matching", () => {
    const context = { roles: ["user", "admin", "editor"] };
    const template =
      '{{#each roles}}{{#equals this "admin"}}true{{/equals}}{{/each}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("returns false for invalid template", () => {
    const context = { groups: ["admin"] };
    const template = "{{#invalid}}";

    expect(evaluateRoleMappingTemplate(template, context)).toBe(false);
  });

  test("returns false for empty result", () => {
    const context = { groups: [] };
    const template = '{{#includes groups "admin"}}true{{/includes}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(false);
  });

  test("treats 'false' string as falsy", () => {
    const context = { value: "false" };
    const template = "{{value}}";

    expect(evaluateRoleMappingTemplate(template, context)).toBe(false);
  });

  test("treats '0' string as falsy", () => {
    const context = { value: "0" };
    const template = "{{value}}";

    expect(evaluateRoleMappingTemplate(template, context)).toBe(false);
  });
});

describe("extractGroupsWithTemplate", () => {
  test("extracts groups using each helper", () => {
    const context = { groups: ["admin", "users", "developers"] };
    const template = "{{#each groups}}{{this}},{{/each}}";

    expect(extractGroupsWithTemplate(template, context)).toEqual([
      "admin",
      "users",
      "developers",
    ]);
  });

  test("extracts nested property from objects", () => {
    const context = {
      roles: [{ name: "admin" }, { name: "user" }, { name: "editor" }],
    };
    const template = "{{#each roles}}{{this.name}},{{/each}}";

    expect(extractGroupsWithTemplate(template, context)).toEqual([
      "admin",
      "user",
      "editor",
    ]);
  });

  test("handles pluck helper for property extraction", () => {
    const context = {
      roles: [{ name: "admin" }, { name: "user" }],
    };
    const template = '{{{json (pluck roles "name")}}}';

    expect(extractGroupsWithTemplate(template, context)).toEqual([
      "admin",
      "user",
    ]);
  });

  test("handles JSON array output", () => {
    const context = { groups: ["admin", "users"] };
    const template = "{{{json groups}}}";

    expect(extractGroupsWithTemplate(template, context)).toEqual([
      "admin",
      "users",
    ]);
  });

  test("returns empty array for empty template result", () => {
    const context = { groups: [] };
    const template = "{{#each groups}}{{this}},{{/each}}";

    expect(extractGroupsWithTemplate(template, context)).toEqual([]);
  });

  test("returns empty array for invalid template", () => {
    const context = { groups: ["admin"] };
    const template = "{{#invalid}}";

    expect(extractGroupsWithTemplate(template, context)).toEqual([]);
  });

  test("handles single value", () => {
    const context = { primaryGroup: "admin" };
    const template = "{{primaryGroup}}";

    expect(extractGroupsWithTemplate(template, context)).toEqual(["admin"]);
  });

  test("handles deeply nested access", () => {
    const context = {
      user: {
        memberships: {
          groups: ["team-a", "team-b"],
        },
      },
    };
    const template = "{{#each user.memberships.groups}}{{this}},{{/each}}";

    expect(extractGroupsWithTemplate(template, context)).toEqual([
      "team-a",
      "team-b",
    ]);
  });

  test("filters empty strings from result", () => {
    const context = { groups: ["admin", "", "users", ""] };
    const template = "{{#each groups}}{{this}},{{/each}}";

    // The empty strings become empty array elements which are filtered out
    expect(extractGroupsWithTemplate(template, context)).toEqual([
      "admin",
      "users",
    ]);
  });

  test("handles JSON string roles claim", () => {
    // This is the actual format from Okta where roles is a JSON string, not an array
    const context = {
      roles:
        '[{"name":"Application Administrator","attributes":[],"functionalAbilities":[]},{"name":"n8n_access","attributes":[],"functionalAbilities":[]}]',
    };
    const template =
      "{{#with (json roles)}}{{#each this}}{{this.name}},{{/each}}{{/with}}";

    expect(extractGroupsWithTemplate(template, context)).toEqual([
      "Application Administrator",
      "n8n_access",
    ]);
  });

  test("handles JSON string roles with pluck helper", () => {
    const context = {
      roles:
        '[{"name":"admin","type":"system"},{"name":"editor","type":"custom"}]',
    };
    const template = '{{{json (pluck (json roles) "name")}}}';

    expect(extractGroupsWithTemplate(template, context)).toEqual([
      "admin",
      "editor",
    ]);
  });
});

describe("evaluateRoleMappingTemplate with JSON string claims", () => {
  test("matches role in JSON string array", () => {
    const context = {
      roles:
        '[{"name":"Application Administrator","attributes":[]},{"name":"archestra-admin","attributes":[]}]',
    };
    const template =
      '{{#with (json roles)}}{{#each this}}{{#equals this.name "archestra-admin"}}true{{/equals}}{{/each}}{{/with}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(true);
  });

  test("does not match when role not in JSON string array", () => {
    const context = {
      roles:
        '[{"name":"Application Administrator","attributes":[]},{"name":"n8n_access","attributes":[]}]',
    };
    const template =
      '{{#with (json roles)}}{{#each this}}{{#equals this.name "archestra-admin"}}true{{/equals}}{{/each}}{{/with}}';

    expect(evaluateRoleMappingTemplate(template, context)).toBe(false);
  });

  test("handles invalid JSON string gracefully", () => {
    const context = {
      roles: "not valid json",
    };
    const template =
      '{{#with (json roles)}}{{#each this}}{{#equals this.name "admin"}}true{{/equals}}{{/each}}{{/with}}';

    // Should return false when JSON parsing fails
    expect(evaluateRoleMappingTemplate(template, context)).toBe(false);
  });
});

describe("renderSystemPrompt", () => {
  const baseContext = {
    user: {
      name: "Alice Smith",
      email: "alice@example.com",
      teams: ["Engineering", "Platform"],
    },
  };

  test("renders user.name variable", () => {
    const template = "Hello {{user.name}}, welcome!";
    expect(renderSystemPrompt(template, baseContext)).toBe(
      "Hello Alice Smith, welcome!",
    );
  });

  test("renders user.email variable", () => {
    const template = "Your email is {{user.email}}";
    expect(renderSystemPrompt(template, baseContext)).toBe(
      "Your email is alice@example.com",
    );
  });

  test("renders user.teams with each loop", () => {
    const template =
      "Teams: {{#each user.teams}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}";
    expect(renderSystemPrompt(template, baseContext)).toBe(
      "Teams: Engineering, Platform",
    );
  });

  test("renders currentDate helper in YYYY-MM-DD format", () => {
    const template = "Today is {{currentDate}}";
    const result = renderSystemPrompt(template, baseContext);
    expect(result).toMatch(/^Today is \d{4}-\d{2}-\d{2}$/);
  });

  test("renders currentTime helper in HH:MM:SS UTC format", () => {
    const template = "Time is {{currentTime}}";
    const result = renderSystemPrompt(template, baseContext);
    expect(result).toMatch(/^Time is \d{2}:\d{2}:\d{2} UTC$/);
  });

  test("passes through plain text without templates unchanged", () => {
    const template = "You are a helpful assistant. Be concise.";
    expect(renderSystemPrompt(template, baseContext)).toBe(
      "You are a helpful assistant. Be concise.",
    );
  });

  test("returns original template string on invalid Handlebars syntax", () => {
    const template = "Hello {{#invalid}}";
    expect(renderSystemPrompt(template, baseContext)).toBe(
      "Hello {{#invalid}}",
    );
  });

  test("renders empty string for missing variables", () => {
    const template = "Hello {{user.nonexistent}}!";
    expect(renderSystemPrompt(template, baseContext)).toBe("Hello !");
  });

  test("renders complex template with multiple variables and helpers", () => {
    const template = `You are an assistant for {{user.name}} ({{user.email}}).
You are a member of: {{#each user.teams}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}.
Current date: {{currentDate}}.`;
    const result = renderSystemPrompt(template, baseContext);
    expect(result).toContain("You are an assistant for Alice Smith");
    expect(result).toContain("(alice@example.com)");
    expect(result).toContain("You are a member of: Engineering, Platform");
    expect(result).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
  });

  test("handles empty teams array", () => {
    const context = {
      user: { name: "Bob", email: "bob@test.com", teams: [] },
    };
    const template =
      "{{#if user.teams}}Teams: {{#each user.teams}}{{this}}{{/each}}{{else}}No teams{{/if}}";
    expect(renderSystemPrompt(template, context)).toBe("No teams");
  });

  test("handles conditional blocks with user data", () => {
    const template =
      '{{#includes user.teams "Engineering"}}You are an engineer{{else}}You are not an engineer{{/includes}}';
    expect(renderSystemPrompt(template, baseContext)).toBe(
      "You are an engineer",
    );
  });

  test("renders variables adjacent to backticks correctly", () => {
    const template = "Use `{{user.name}}` in your code";
    expect(renderSystemPrompt(template, baseContext)).toBe(
      "Use `Alice Smith` in your code",
    );
  });

  test("renders variables inside triple backtick code blocks", () => {
    const template = "```\n{{user.name}}\n```";
    expect(renderSystemPrompt(template, baseContext)).toBe(
      "```\nAlice Smith\n```",
    );
  });

  test("does not HTML-escape apostrophes in variable values", () => {
    const context = {
      user: { name: "O'Brien", email: "obrien@test.com", teams: [] },
    };
    const template = "Hello {{user.name}}";
    expect(renderSystemPrompt(template, context)).toBe("Hello O'Brien");
  });

  test("does not HTML-escape ampersands in variable values", () => {
    const context = {
      user: { name: "Alice", email: "alice@test.com", teams: ["R&D"] },
    };
    const template = "Teams: {{#each user.teams}}{{this}}{{/each}}";
    expect(renderSystemPrompt(template, context)).toBe("Teams: R&D");
  });

  test("does not HTML-escape backticks in variable values", () => {
    const context = {
      user: {
        name: "use `tool` here",
        email: "test@test.com",
        teams: [],
      },
    };
    const template = "Instruction: {{user.name}}";
    expect(renderSystemPrompt(template, context)).toBe(
      "Instruction: use `tool` here",
    );
  });

  test("does not HTML-escape angle brackets in variable values", () => {
    const context = {
      user: { name: "<admin>", email: "admin@test.com", teams: [] },
    };
    const template = "User: {{user.name}}";
    expect(renderSystemPrompt(template, context)).toBe("User: <admin>");
  });

  test("renders backtick-wrapped variable with special chars in value", () => {
    const context = {
      user: {
        name: "O'Brien",
        email: "obrien@test.com",
        teams: ["R&D"],
      },
    };
    const template = "Welcome `{{user.name}}` from `{{user.teams}}`";
    expect(renderSystemPrompt(template, context)).toBe(
      "Welcome `O'Brien` from `R&D`",
    );
  });
});

describe("promptNeedsRendering", () => {
  test("returns false for plain text prompts", () => {
    expect(promptNeedsRendering("You are a helpful assistant.")).toBe(false);
  });

  test("returns true when prompt contains handlebars syntax", () => {
    expect(promptNeedsRendering("Hello {{user.name}}")).toBe(true);
  });

  test("returns false for null and undefined prompts", () => {
    expect(promptNeedsRendering(null, undefined)).toBe(false);
  });

  test("returns false when all prompts are null or undefined", () => {
    expect(promptNeedsRendering(null, undefined, null)).toBe(false);
  });

  test("returns true when any prompt contains handlebars syntax", () => {
    expect(promptNeedsRendering("plain text", "Hello {{user.name}}")).toBe(
      true,
    );
  });

  test("returns false for single curly braces", () => {
    expect(promptNeedsRendering("Use { and } for JSON")).toBe(false);
  });

  test("returns true for helper syntax", () => {
    expect(promptNeedsRendering("{{#if user.teams}}yes{{/if}}")).toBe(true);
  });

  test("returns false with no arguments", () => {
    expect(promptNeedsRendering()).toBe(false);
  });
});

describe("buildRenderedPrompts", () => {
  const context = {
    user: {
      name: "Alice",
      email: "alice@test.com",
      teams: ["Engineering"],
    },
  };

  test("returns empty arrays when both prompts are null", () => {
    const result = buildRenderedPrompts({
      systemPrompt: null,
      userPrompt: null,
      context: null,
    });
    expect(result).toEqual({ systemPromptParts: [], userPromptParts: [] });
  });

  test("returns raw prompts when no templating needed", () => {
    const result = buildRenderedPrompts({
      systemPrompt: "Be helpful",
      userPrompt: "Answer concisely",
      context: null,
    });
    expect(result.systemPromptParts).toEqual(["Be helpful"]);
    expect(result.userPromptParts).toEqual(["Answer concisely"]);
  });

  test("renders templates when context is provided and prompts contain handlebars", () => {
    const result = buildRenderedPrompts({
      systemPrompt: "Hello {{user.name}}",
      userPrompt: null,
      context,
    });
    expect(result.systemPromptParts).toEqual(["Hello Alice"]);
    expect(result.userPromptParts).toEqual([]);
  });

  test("renders both system and user prompts", () => {
    const result = buildRenderedPrompts({
      systemPrompt: "For {{user.name}}",
      userPrompt: "Email: {{user.email}}",
      context,
    });
    expect(result.systemPromptParts).toEqual(["For Alice"]);
    expect(result.userPromptParts).toEqual(["Email: alice@test.com"]);
  });

  test("skips rendering when context is null even if prompts have braces", () => {
    const result = buildRenderedPrompts({
      systemPrompt: "Hello {{user.name}}",
      userPrompt: null,
      context: null,
    });
    expect(result.systemPromptParts).toEqual(["Hello {{user.name}}"]);
  });

  test("handles only userPrompt being set", () => {
    const result = buildRenderedPrompts({
      systemPrompt: null,
      userPrompt: "Plain text",
      context: null,
    });
    expect(result.systemPromptParts).toEqual([]);
    expect(result.userPromptParts).toEqual(["Plain text"]);
  });
});
