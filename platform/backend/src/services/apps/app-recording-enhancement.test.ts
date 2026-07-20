import { describe, expect, test } from "@/test";
import { sanitizeHumanAsk } from "./app-recording-enhancement";

describe("sanitizeHumanAsk", () => {
  test("keeps the human ask and drops the spec a model drifted into", () => {
    // The exact shape observed in a real draft: a plausible opening ask, then
    // a requirements document nobody would ever type into a chat box.
    const drafted = [
      'Build an app called "PR Dashboard" that lists pull requests from the GitHub repository acme/widgets, ordered by date newest-first.',
      "",
      "Features:",
      "- Load pull requests from `acme/widgets` and display them newest-first.",
      "- For each PR, show the open/merged/closed state icon and author avatar.",
      "- Provide filters across All / Open / Merged / Closed.",
    ].join("\n");

    expect(sanitizeHumanAsk(drafted)).toBe(
      "Build an app called PR Dashboard that lists pull requests from the GitHub repository acme/widgets, ordered by date newest-first.",
    );
  });

  test("cuts at the first bullet even when no section header announces it", () => {
    const drafted =
      "Build me a tracker for unpaid invoices.\n- Pull them from Gmail\n- Flag the overdue ones";

    expect(sanitizeHumanAsk(drafted)).toBe(
      "Build me a tracker for unpaid invoices.",
    );
  });

  test("leaves a genuinely human ask untouched", () => {
    const human =
      "Build me an app that shows every open pull request across our repos as a review queue, sorted by how long each has been waiting, with anything older than 3 days flagged.";

    expect(sanitizeHumanAsk(human)).toBe(human);
  });

  test("trims an over-long ask at a sentence boundary, never mid-clause", () => {
    const rambling = `${"word ".repeat(60)}. And then it should also do something else entirely that nobody asked for, ${"more ".repeat(30)}.`;

    const result = sanitizeHumanAsk(rambling);
    expect(result.split(" ").length).toBeLessThanOrEqual(70);
    expect(result.endsWith(".")).toBe(true);
  });

  test("strips markdown emphasis and quoting a chat message never carries", () => {
    expect(
      sanitizeHumanAsk('Build me a **bold** app with `code` and "quotes"'),
    ).toBe("Build me a bold app with code and quotes");
  });
});
