import AgentModel from "./agent";

describe("AgentModel", () => {
  test("can create an agent", async () => {
    await AgentModel.create({ name: "Test Agent" });
    await AgentModel.create({ name: "Test Agent 2" });

    expect(await AgentModel.findAll()).toHaveLength(2);
  });
});
