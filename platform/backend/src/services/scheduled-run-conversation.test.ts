import ConversationModel from "@/models/conversation";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import { projectService } from "@/services/project";
import { createAndLinkRunConversation } from "@/services/scheduled-run-conversation";
import { expect, test } from "@/test";

test("createAndLinkRunConversation makes a project-scoped, schedule-origin chat and links it once", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  const org = await makeOrganization();
  const actor = await makeUser();
  await makeMember(actor.id, org.id, { role: "admin" });
  const agent = await makeAgent({ organizationId: org.id, authorId: actor.id });
  const project = await projectService.create({
    organizationId: org.id,
    userId: actor.id,
    name: "runs",
    description: null,
  });
  const trigger = await makeScheduleTrigger({
    organizationId: org.id,
    actorUserId: actor.id,
    agentId: agent.id,
    projectId: project.id,
  });
  const run = await makeScheduleTriggerRun(trigger.id, {
    organizationId: org.id,
    runKind: "due",
  });

  const conversation = await createAndLinkRunConversation({
    run,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });

  expect(conversation.projectId).toBe(project.id);
  expect(conversation.origin).toBe("schedule_trigger");

  const linked = await ScheduleTriggerRunModel.findById(run.id);
  expect(linked?.chatConversationId).toBe(conversation.id);

  // A second call (e.g. the lazy view racing the handler) must not create a
  // second conversation — it returns the already-linked one.
  const again = await createAndLinkRunConversation({
    run: linked ?? run,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });
  expect(again.id).toBe(conversation.id);

  const all = await ConversationModel.findAll(actor.id, org.id);
  expect(all.filter((c) => c.projectId === project.id)).toHaveLength(1);
});
