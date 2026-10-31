import { request, test as setup } from "@playwright/test";
import { ArchestraApi } from "../src/api";
import { backdateKnowledgeFiles, seedDatabaseRows } from "../src/db-seed";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ARCHESTRA_URL,
  ONLY,
  PERSONA_AUTH_FILE,
} from "../src/env";
import { ensurePersona, PERSONA } from "../src/persona";
import { seedDemoData, seedKnowledgeFiles } from "../src/seed";

setup("seed the demo organization", async () => {
  const adminContext = await request.newContext({ baseURL: ARCHESTRA_URL });
  const admin = new ArchestraApi(adminContext);
  if (!(await admin.signIn(ADMIN_EMAIL, ADMIN_PASSWORD))) {
    throw new Error(
      `Could not sign in as ${ADMIN_EMAIL}. Set ARCHESTRA_AUTH_ADMIN_EMAIL and ARCHESTRA_AUTH_ADMIN_PASSWORD for this instance.`,
    );
  }
  // The persona creates and owns every demo record, so no shot shows the
  // instance's admin as an owner.
  const anonymous = await request.newContext({ baseURL: ARCHESTRA_URL });
  await ensurePersona({ admin, anonymous });
  await adminContext.dispose();

  const personaContext = await request.newContext({ baseURL: ARCHESTRA_URL });
  const persona = new ArchestraApi(personaContext);
  if (!(await persona.signIn(PERSONA.email, PERSONA.password))) {
    throw new Error(`Could not sign in as the persona ${PERSONA.email}.`);
  }
  const onlyModelRouterKey =
    ONLY.length === 1 &&
    ONLY[0] === "automated_screenshots/llm-proxy_model-router-key";
  const state = await seedDemoData(persona, { onlyModelRouterKey });
  if (!onlyModelRouterKey) {
    await seedDatabaseRows(state);
    await seedKnowledgeFiles(persona, state);
    backdateKnowledgeFiles(state);
  }
  await personaContext.storageState({ path: PERSONA_AUTH_FILE });
  await personaContext.dispose();
  await anonymous.dispose();
});
