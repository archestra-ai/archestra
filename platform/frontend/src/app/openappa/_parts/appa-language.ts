import type { EditorProps } from "@monaco-editor/react";

/**
 * Monaco support for OpenAPPA replay files (`.appa`): highlighting, folding a
 * whole step, a formatter, `expect` completions and inline syntax errors.
 *
 * The grammar follows the replay parser: blank lines and `#` comments are
 * ignored; a step is a call line `family/server/tool {` (or `{}`), one
 * `key: <JSON value>` per line, `}`, then `expect allow`, `expect withhold`,
 * `expect deny`, `expect authority [name]` or `expect sanitizer [name]`.
 */
export const APPA_LANGUAGE_ID = "appa";

export const APPA_EDITOR_THEMES = { dark: "appa-dark", light: "appa-light" };

/** Pass as the editor's `beforeMount`; safe to call for every editor. */
export function registerAppaLanguage(monaco: Monaco) {
  if (registered.has(monaco)) return;
  registered.add(monaco);

  monaco.languages.register({ id: APPA_LANGUAGE_ID, extensions: [".appa"] });
  monaco.languages.setLanguageConfiguration(APPA_LANGUAGE_ID, {
    comments: { lineComment: "#" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
    indentationRules: {
      increaseIndentPattern: /\{\s*$/,
      decreaseIndentPattern: /^\s*\}/,
    },
  });
  monaco.languages.setMonarchTokensProvider(APPA_LANGUAGE_ID, {
    defaultToken: "",
    tokenizer: {
      root: [
        [/^\s*#.*$/, "comment"],
        [/^\s*(expect)(\s+)(allow)\b/, ["keyword", "", "appa.allow"]],
        [/^\s*(expect)(\s+)(deny|withhold)\b/, ["keyword", "", "appa.deny"]],
        [
          /^\s*(expect)(\s+)(authority|sanitizer)((?:\s+[A-Za-z_][\w-]*)?)/,
          ["keyword", "", "appa.review", "appa.review"],
        ],
        [/^\s*expect\b/, "keyword"],
        [
          /^(\s*)([A-Za-z0-9_.-]+\/)([A-Za-z0-9_.-]+\/)?([A-Za-z0-9_.-]+)(?=\s*\{)/,
          ["", "appa.family", "appa.server", "appa.tool"],
        ],
        [/^(\s*)([A-Za-z_][\w-]*)(\s*)(:)/, ["", "appa.key", "", "delimiter"]],
        { include: "@json" },
      ],
      json: [
        [/"([^"\\]|\\.)*"/, "string"],
        [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
        [/\b(true|false|null)\b/, "appa.constant"],
        [/[{}[\]]/, "@brackets"],
        [/[,:]/, "delimiter"],
        [/[A-Za-z_][\w-]*/, "identifier"],
      ],
    },
  });

  // Fold a whole step, from its call line through its `expect` line.
  monaco.languages.registerFoldingRangeProvider(APPA_LANGUAGE_ID, {
    provideFoldingRanges: (model: TextModel) =>
      parseAppa(model.getLinesContent())
        .steps.filter((step) => step.endLine > step.line)
        .map((step) => ({ start: step.line, end: step.endLine })),
  });

  monaco.languages.registerDocumentFormattingEditProvider(APPA_LANGUAGE_ID, {
    provideDocumentFormattingEdits: (model: TextModel) => {
      const text = model.getValue();
      const formatted = formatAppa(text);
      return formatted === text
        ? []
        : [{ range: model.getFullModelRange(), text: formatted }];
    },
  });

  monaco.languages.registerCompletionItemProvider(APPA_LANGUAGE_ID, {
    triggerCharacters: [" "],
    provideCompletionItems: (model: TextModel, position: Position) => {
      const before = model
        .getLineContent(position.lineNumber)
        .slice(0, position.column - 1);
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const kind = monaco.languages.CompletionItemKind.Keyword;
      if (/^\s*expect\s+\w*$/.test(before))
        return {
          suggestions: EXPECTATIONS.map(([label, detail]) => ({
            label,
            kind,
            detail,
            insertText: label,
            range,
          })),
        };
      if (/^\s*\w*$/.test(before) && model.getLineCount() > 0)
        return {
          suggestions: [
            {
              label: "expect",
              kind,
              detail: "The decision the call above should get",
              insertText: "expect ",
              range,
              command: {
                id: "editor.action.triggerSuggest",
                title: "Suggest decisions",
              },
            },
          ],
        };
      return { suggestions: [] };
    },
  });

  monaco.editor.defineTheme(APPA_EDITOR_THEMES.dark, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "appa.family", foreground: "808080" },
      { token: "appa.server", foreground: "9CDCFE" },
      { token: "appa.tool", foreground: "DCDCAA", fontStyle: "bold" },
      { token: "appa.key", foreground: "9CDCFE" },
      { token: "appa.constant", foreground: "569CD6" },
      { token: "appa.allow", foreground: "4EC98F", fontStyle: "bold" },
      { token: "appa.deny", foreground: "F48771", fontStyle: "bold" },
      { token: "appa.review", foreground: "E5C07B", fontStyle: "bold" },
    ],
    colors: {},
  });
  monaco.editor.defineTheme(APPA_EDITOR_THEMES.light, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "appa.family", foreground: "8A8A8A" },
      { token: "appa.server", foreground: "0451A5" },
      { token: "appa.tool", foreground: "795E26", fontStyle: "bold" },
      { token: "appa.key", foreground: "001080" },
      { token: "appa.constant", foreground: "0000FF" },
      { token: "appa.allow", foreground: "15803D", fontStyle: "bold" },
      { token: "appa.deny", foreground: "B91C1C", fontStyle: "bold" },
      { token: "appa.review", foreground: "A16207", fontStyle: "bold" },
    ],
    colors: {},
  });

  // Inline syntax errors for every `.appa` model, kept in step with edits.
  const watch = (model: TextModel) => {
    if (model.getLanguageId() !== APPA_LANGUAGE_ID) return;
    const check = () =>
      monaco.editor.setModelMarkers(
        model,
        APPA_LANGUAGE_ID,
        parseAppa(model.getLinesContent()).errors.map((error) => ({
          severity: monaco.MarkerSeverity.Error,
          message: error.message,
          startLineNumber: error.line,
          endLineNumber: error.line,
          startColumn: 1,
          endColumn: model.getLineMaxColumn(error.line),
        })),
      );
    check();
    model.onDidChangeContent(check);
  };
  monaco.editor.getModels().forEach(watch);
  monaco.editor.onDidCreateModel(watch);
  monaco.editor.onDidChangeModelLanguage(({ model }: { model: TextModel }) =>
    watch(model),
  );
}

/**
 * Normalizes layout without changing meaning: two-space argument indent,
 * `key: value` spacing, one blank line between steps, no trailing spaces.
 */
export function formatAppa(text: string) {
  const out: string[] = [];
  let inCall = false;
  // Between a call's `}` and its `expect`, blank lines are dropped.
  let awaitingExpect = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (!awaitingExpect && out.length && out.at(-1) !== "") out.push("");
      continue;
    }
    if (inCall) {
      if (line === "}") {
        out.push("}");
        inCall = false;
        awaitingExpect = true;
        continue;
      }
      const pair = /^([^:\s]+)\s*:\s*(.*)$/.exec(line);
      out.push(pair ? `  ${pair[1]}: ${pair[2]}` : `  ${line}`);
      continue;
    }
    const call = /^(\S+)\s*\{\s*(\})?$/.exec(line);
    if (call) {
      // A new step starts after a blank line, unless it opens the file or
      // directly follows its own leading comments.
      if (out.length && out.at(-1) !== "" && !out.at(-1)?.startsWith("#"))
        out.push("");
      out.push(call[2] ? `${call[1]} {}` : `${call[1]} {`);
      inCall = !call[2];
      awaitingExpect = Boolean(call[2]);
      continue;
    }
    awaitingExpect = false;
    if (line.startsWith("expect")) {
      out.push(line.split(/\s+/).join(" "));
      continue;
    }
    out.push(line);
  }
  while (out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
}

/** Mirrors the replay parser's structure checks so mistakes show while typing. */
export function parseAppa(lines: string[]) {
  const steps: { line: number; endLine: number }[] = [];
  const errors: { line: number; message: string }[] = [];
  let state = "call" as "call" | "args" | "expect";
  let callLine = 0;
  let keys = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const number = index + 1;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (state === "args") {
      if (line === "}") {
        state = "expect";
        continue;
      }
      const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.+)$/.exec(line);
      if (!pair) {
        errors.push({
          line: number,
          message: `Expected \`key: value\` or \`}\`, found \`${line}\``,
        });
        continue;
      }
      if (keys.has(pair[1]))
        errors.push({
          line: number,
          message: `\`${pair[1]}\` is already set for this call`,
        });
      keys.add(pair[1]);
      if (!isJsonValue(pair[2]))
        errors.push({
          line: number,
          message: `The value of \`${pair[1]}\` must be JSON, such as "text", 42, true or ["a"]`,
        });
      continue;
    }
    if (state === "expect") {
      if (EXPECT_LINE.test(line)) {
        steps.push({ line: callLine, endLine: number });
        state = "call";
        continue;
      }
      errors.push({
        line: number,
        message: `Expected ${EXPECT_WORDS} after the call at line ${callLine}, found \`${line}\``,
      });
      state = "call";
      continue;
    }
    const call = /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\s*\{\s*(\})?$/.exec(
      line,
    );
    if (!call) {
      errors.push({
        line: number,
        message: `Expected a tool call like \`mcp/files/read {\`, found \`${line}\``,
      });
      continue;
    }
    callLine = number;
    keys = new Set();
    state = call[2] ? "expect" : "args";
  }
  if (state === "args")
    errors.push({
      line: callLine,
      message: "This call is missing its closing `}`",
    });
  if (state === "expect")
    errors.push({
      line: callLine,
      message: `This call has no \`expect\` line; add ${EXPECT_WORDS}`,
    });
  return { steps, errors };
}

// ===========================================================================
// Internal helpers
// ===========================================================================

type Monaco = Parameters<NonNullable<EditorProps["beforeMount"]>>[0];
type TextModel = ReturnType<Monaco["editor"]["getModels"]>[number];
type Position = { lineNumber: number; column: number };

const registered = new WeakSet<Monaco>();

const EXPECTATIONS: [string, string][] = [
  ["allow", "The call runs"],
  ["deny", "The call is refused"],
  ["withhold", "The call runs but its result is held back"],
  ["authority hitl", "The call needs a person's approval"],
  ["authority", "The call needs an authority's approval"],
  ["sanitizer", "The call's result must be cleaned first"],
];

const EXPECT_WORDS =
  "`expect allow`, `expect withhold`, `expect deny`, `expect authority [name]` or `expect sanitizer [name]`";

const EXPECT_LINE =
  /^expect\s+(allow|withhold|deny|(authority|sanitizer)(\s+[A-Za-z_][\w-]*)?)$/;

function isJsonValue(text: string) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
