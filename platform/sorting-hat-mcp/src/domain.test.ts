import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizeTravel,
  castPatronus,
  createQuidditchEvents,
  sortTool,
} from "./domain.js";

describe("sortTool", () => {
  it("sorts destructive tools into slytherin", () => {
    const result = sortTool({
      toolName: "delete_database",
      toolDescription: "Delete production records with admin credentials",
    });

    assert.equal(result.house, "slytherin");
    assert.ok(result.confidence >= 0.55);
  });

  it("honors the please_not_slytherin preference", () => {
    const result = sortTool({
      toolName: "delete_secret",
      toolDescription: "Delete a secret",
      pleaseNotSlytherin: true,
    });

    assert.notEqual(result.house, "slytherin");
    assert.equal(result.preferenceApplied, true);
  });
});

describe("castPatronus", () => {
  it("returns stable deterministic forms for the same user", () => {
    const first = castPatronus({
      userId: "user-123",
      charm: "expecto_patronum",
    });
    const second = castPatronus({
      userId: "user-123",
      charm: "expecto_patronum",
    });

    assert.deepEqual(first, second);
  });
});

describe("authorizeTravel", () => {
  it("blocks slytherin travel for non-corporeal patronus", () => {
    const result = authorizeTravel({
      sortResult: {
        house: "slytherin",
        confidence: 0.9,
        riskScore: 1,
        preferenceApplied: false,
        monologue: [],
      },
      patronus: {
        userId: "user-123",
        form: "otter",
        corporeal: false,
      },
      fromServer: "github",
      toServer: "database",
      payload: { action: "delete" },
    });

    assert.equal(result.authorized, false);
  });
});

describe("createQuidditchEvents", () => {
  it("generates bounded progress frames", () => {
    const events = createQuidditchEvents("call-1", 3);

    assert.equal(events.length, 3);
    assert.equal(events[0].progress, 0);
    assert.equal(events[2].progress, 1);
  });
});
