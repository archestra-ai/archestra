import { describe, expect, test } from "vitest";
import { applyResponseModifierTemplate } from "./templating";

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
