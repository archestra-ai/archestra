import { describe, expect, it } from "vitest";
import {
  __test,
  sortingHatToolEntries,
  sortingHatTools,
} from "./sorting-hat";

const { sortTool, getPatronusForm, isCorporeal } = __test;

// ─── sortTool Tests ───────────────────────────────────────────────────────────

describe("sortTool", () => {
  describe("Hufflepuff (low risk / read-only)", () => {
    it("sorts a read-only tool into Hufflepuff", () => {
      const result = sortTool("read_file", "Reads a file from disk");
      expect(result.house).toBe("hufflepuff");
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reasoning).toContain("Hufflepuff");
    });

    it("sorts a list tool into Hufflepuff", () => {
      const result = sortTool("list_users", "Lists all users in the system");
      expect(result.house).toBe("hufflepuff");
    });

    it("sorts a status check into Hufflepuff", () => {
      const result = sortTool("health_check", "Check service health status");
      expect(result.house).toBe("hufflepuff");
    });
  });

  describe("Ravenclaw (analysis / queries)", () => {
    it("sorts an analysis tool into Ravenclaw", () => {
      const result = sortTool(
        "analyze_data",
        "Analyzes dataset for patterns and anomalies",
      );
      expect(result.house).toBe("ravenclaw");
      expect(result.reasoning).toContain("Ravenclaw");
    });

    it("sorts a validation tool into Ravenclaw", () => {
      const result = sortTool(
        "validate_input",
        "Validates user input against schema",
      );
      expect(result.house).toBe("ravenclaw");
    });
  });

  describe("Gryffindor (writes / modifications)", () => {
    it("sorts a create tool into Gryffindor", () => {
      const result = sortTool(
        "create_record",
        "Creates a new database record",
      );
      expect(result.house).toBe("gryffindor");
      expect(result.reasoning).toContain("Gryffindor");
    });

    it("sorts a deploy tool into Gryffindor", () => {
      const result = sortTool(
        "deploy_service",
        "Deploys a service to production",
      );
      expect(result.house).toBe("gryffindor");
    });

    it("sorts a send tool into Gryffindor", () => {
      const result = sortTool("send_email", "Sends an email to recipients");
      expect(result.house).toBe("gryffindor");
    });
  });

  describe("Slytherin (destructive / admin)", () => {
    it("sorts a delete tool into Slytherin", () => {
      const result = sortTool(
        "delete_user",
        "Deletes a user account permanently",
      );
      expect(result.house).toBe("slytherin");
      expect(result.reasoning).toContain("Slytherin");
    });

    it("sorts an exec tool into Slytherin", () => {
      const result = sortTool(
        "exec_command",
        "Execute arbitrary shell commands",
      );
      expect(result.house).toBe("slytherin");
    });

    it("sorts a revoke tool into Slytherin", () => {
      const result = sortTool(
        "revoke_access",
        "Revokes user access permissions",
      );
      expect(result.house).toBe("slytherin");
    });
  });

  describe("Confidence scoring", () => {
    it("returns confidence between 0 and 1", () => {
      const result = sortTool("test", "A test tool");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it("returns higher confidence for clear signals", () => {
      const clear = sortTool(
        "delete_all_data",
        "Permanently deletes all data from the database",
      );
      const ambiguous = sortTool("do_thing", "Does a thing");
      expect(clear.confidence).toBeGreaterThanOrEqual(ambiguous.confidence);
    });
  });

  describe("Determinism", () => {
    it("returns the same result for the same input", () => {
      const r1 = sortTool("my_tool", "My tool description");
      const r2 = sortTool("my_tool", "My tool description");
      expect(r1.house).toBe(r2.house);
      expect(r1.confidence).toBe(r2.confidence);
      expect(r1.reasoning).toBe(r2.reasoning);
    });
  });
});

// ─── getPatronusForm Tests ────────────────────────────────────────────────────

describe("getPatronusForm", () => {
  it("returns a string form", () => {
    const form = getPatronusForm("user-123");
    expect(typeof form).toBe("string");
    expect(form.length).toBeGreaterThan(0);
  });

  it("returns the same form for the same user_id", () => {
    const f1 = getPatronusForm("user-456");
    const f2 = getPatronusForm("user-456");
    expect(f1).toBe(f2);
  });

  it("returns different forms for different user_ids", () => {
    // With 26 possible forms, two random IDs should very likely differ
    const forms = new Set<string>();
    for (let i = 0; i < 50; i++) {
      forms.add(getPatronusForm(`user-${i}`));
    }
    // At least 5 different forms in 50 users
    expect(forms.size).toBeGreaterThanOrEqual(5);
  });

  it("returns a known patronus form", () => {
    const knownForms = [
      "otter",
      "stag",
      "doe",
      "hare",
      "hound",
      "tabby cat",
      "fox",
      "wolf",
      "owl",
      "eagle",
      "unicorn",
      "phoenix",
    ];
    const form = getPatronusForm("test-user");
    expect(knownForms).toContain(form);
  });
});

// ─── isCorporeal Tests ────────────────────────────────────────────────────────

describe("isCorporeal", () => {
  it("returns a boolean", () => {
    expect(typeof isCorporeal("user-1")).toBe("boolean");
  });

  it("is deterministic", () => {
    const c1 = isCorporeal("user-789");
    const c2 = isCorporeal("user-789");
    expect(c1).toBe(c2);
  });

  it("produces corporeal patronuses most of the time (85%)", () => {
    let corporealCount = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (isCorporeal(`user-${i}`)) corporealCount++;
    }
    // Allow some variance: 70%-100%
    expect(corporealCount).toBeGreaterThanOrEqual(700);
    expect(corporealCount).toBeLessThanOrEqual(total);
  });
});

// ─── Tool Registry Tests ──────────────────────────────────────────────────────

describe("sorting-hat tools registry", () => {
  it("exports 4 tools", () => {
    expect(sortingHatTools.length).toBe(4);
  });

  it("has sorting_hat.sort tool", () => {
    const tool = sortingHatTools.find((t) => t.name.includes("sorting_hat"));
    expect(tool).toBeDefined();
    expect(tool?.title).toContain("Sorting Hat");
  });

  it("has patronus.cast tool", () => {
    const tool = sortingHatTools.find((t) => t.name.includes("patronus"));
    expect(tool).toBeDefined();
    expect(tool?.title).toContain("Patronus");
  });

  it("has floo.travel tool", () => {
    const tool = sortingHatTools.find((t) => t.name.includes("floo"));
    expect(tool).toBeDefined();
    expect(tool?.title).toContain("Floo");
  });

  it("has quidditch.stream tool", () => {
    const tool = sortingHatTools.find((t) => t.name.includes("quidditch"));
    expect(tool).toBeDefined();
    expect(tool?.title).toContain("Quidditch");
  });

  it("has tool entries for all 4 tools", () => {
    const entryCount = Object.keys(sortingHatToolEntries).length;
    expect(entryCount).toBe(4);
  });
});
