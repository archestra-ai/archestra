import { S3Client } from "@aws-sdk/client-s3";
import { vi } from "vitest";
import BlobProviderModel from "@/models/blob-provider";
import CostExportModel from "@/models/cost-export";
import TaskModel from "@/models/task";
import { beforeEach, describe, expect, test } from "@/test";
import { FakeS3Client } from "@/test/fake-s3-client";
import { costExportService } from ".";

describe("cost exports", () => {
  let s3: FakeS3Client;

  beforeEach(() => {
    // The network is the boundary: S3 calls land in an in-memory bucket.
    s3 = new FakeS3Client();
    vi.spyOn(S3Client.prototype, "send").mockImplementation(((
      command: unknown,
    ) => s3.send(command)) as never);
  });

  test("writes each completed hour as a FOCUS file and advances the watermark", async ({
    makeOrganization,
    makeAgent,
    makeInteraction,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Support Bot",
    });
    const someone = await makeUser({ email: "dev@example.com" });
    const hour = startOfHour(Date.now() - 3 * HOUR);
    await makeInteraction(agent.id, {
      type: "anthropic:messages",
      model: "claude-test",
      inputTokens: 1000,
      outputTokens: 200,
      cost: "0.0125",
      billingMode: "metered",
      userId: someone.id,
      createdAt: new Date(hour.getTime() + 5 * MINUTE),
    });
    await makeInteraction(agent.id, {
      type: "anthropic:messages",
      model: "claude-test",
      inputTokens: 500,
      outputTokens: 100,
      cost: "0.5",
      billingMode: "subscription",
      userId: someone.id,
      createdAt: new Date(hour.getTime() + 10 * MINUTE),
    });
    const costExport = await makeExport({
      organizationId: organization.id,
      exportedThrough: hour,
    });

    await costExportService.runDue();
    await runQueued();

    const keys = s3.keys().filter((key) => key.includes(isoHour(hour)));
    expect(keys).toEqual([
      `archestra/costs/year=${isoDate(hour).slice(0, 4)}/month=${isoDate(hour).slice(5, 7)}/day=${isoDate(hour).slice(8, 10)}/archestra-focus-${isoHour(hour)}.csv`,
    ]);
    const rows = parseCsv(s3.read(keys[0]) ?? "");
    const metered = rows.find((row) => row.x_BillingMode === "metered");
    const subscription = rows.find(
      (row) => row.x_BillingMode === "subscription",
    );
    expect(metered).toMatchObject({
      BilledCost: "0.0125",
      EffectiveCost: "0.0125",
      ListCost: "0.0125",
      BillingAccountId: organization.id,
      BillingCurrency: "USD",
      ChargeCategory: "Usage",
      ChargePeriodStart: isoSeconds(hour),
      ChargePeriodEnd: isoSeconds(new Date(hour.getTime() + HOUR)),
      ProviderName: "Anthropic",
      InvoiceIssuerName: "Anthropic",
      ServiceCategory: "AI and Machine Learning",
      SkuId: "claude-test",
      ResourceId: agent.id,
      ResourceName: "Support Bot",
      ConsumedQuantity: "1200",
      ConsumedUnit: "Tokens",
      x_Requests: "1",
      x_UserEmail: "dev@example.com",
    });
    // Subscription traffic keeps its list price but is not billed per token.
    expect(subscription).toMatchObject({
      BilledCost: "0",
      EffectiveCost: "0",
      ListCost: "0.5",
    });

    const after = await CostExportModel.findById({
      id: costExport.id,
      organizationId: organization.id,
    });
    expect(after).toMatchObject({
      lastRunStatus: "success",
      lastRunError: null,
    });
    // Every settled hour up to now is exported; nothing more is due.
    expect(after?.exportedThrough.getTime()).toBeGreaterThan(hour.getTime());
    const written = s3.keys().length;
    await costExportService.runDue();
    await runQueued();
    expect(s3.keys()).toHaveLength(written);
  });

  test("a daily export taking over mid-day finishes that day hour by hour", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const hour = startOfHour(Date.now() - 2 * HOUR);
    const costExport = await makeExport({
      organizationId: organization.id,
      exportedThrough: hour,
    });
    await costExportService.update({
      id: costExport.id,
      organizationId: organization.id,
      data: { schedule: "daily" },
    });

    await costExportService.runDue();
    await runQueued();

    const files = s3.keys().map((key) => key.split("/").at(-1));
    expect(files).toContain(`archestra-focus-${isoHour(hour)}.csv`);
    // The day is not over, so it is not written again as a daily file.
    expect(files).not.toContain(`archestra-focus-${isoDate(hour)}.csv`);
  });

  test("leaves out other organizations' usage", async ({
    makeOrganization,
    makeAgent,
    makeInteraction,
  }) => {
    const organization = await makeOrganization();
    const other = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: other.id });
    const hour = startOfHour(Date.now() - 2 * HOUR);
    await makeInteraction(foreignAgent.id, {
      cost: "9",
      createdAt: new Date(hour.getTime() + MINUTE),
    });
    await makeExport({
      organizationId: organization.id,
      exportedThrough: hour,
    });

    await costExportService.runDue();
    await runQueued();

    const file = s3.keys().find((key) => key.includes(isoHour(hour)));
    expect(parseCsv(s3.read(file ?? "") ?? "")).toEqual([]);
  });

  test("a failed write keeps the watermark so the next run retries", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const hour = startOfHour(Date.now() - 2 * HOUR);
    const costExport = await makeExport({
      organizationId: organization.id,
      exportedThrough: hour,
    });
    s3.send = async () => {
      throw Object.assign(new Error("No such bucket"), {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      });
    };

    await costExportService.runDue();
    await runQueued();

    const after = await CostExportModel.findById({
      id: costExport.id,
      organizationId: organization.id,
    });
    expect(after).toMatchObject({
      lastRunStatus: "failed",
      // The provider's explanation, as its connection test shows it.
      lastRunError: 'Bucket "finops" does not exist in us-east-1.',
      exportedThrough: hour,
    });
  });

  test("a failing export backs off before the scheduler retries it", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const costExport = await makeExport({
      organizationId: organization.id,
      exportedThrough: startOfHour(Date.now() - 2 * HOUR),
    });
    s3.send = async () => {
      throw Object.assign(new Error("No such bucket"), {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      });
    };
    await costExportService.runDue();
    await runQueued();
    const failed = await costExportService.get({
      id: costExport.id,
      organizationId: organization.id,
    });

    // A tick inside the backoff queues nothing; one after it retries.
    await costExportService.runDue(new Date(Date.now() + 4 * MINUTE));
    const during = await pendingRuns();
    await costExportService.runDue(new Date(Date.now() + 6 * MINUTE));
    const after = await pendingRuns();

    expect(failed.nextRetryAt?.getTime()).toBe(
      (failed.lastRunAt?.getTime() ?? 0) + 5 * MINUTE,
    );
    expect(during).toHaveLength(0);
    expect(after).toHaveLength(1);
  });

  test("a start date in the past backfills every period since, in chained runs", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const costExport = await costExportService.create({
      organizationId: organization.id,
      data: {
        name: "backfill",
        blobProviderId: (await makeProvider(organization.id)).id,
        format: "focus_csv",
        schedule: "hourly",
        pathPrefix: "costs",
        enabled: true,
        // More hours than one run writes, so the catch-up chains.
        startFrom: new Date(Date.now() - 60 * HOUR).toISOString(),
      },
    });

    await costExportService.runDue();
    await runQueued();
    await runQueued();

    const after = await costExportService.get({
      id: costExport.id,
      organizationId: organization.id,
    });
    expect(s3.keys().length).toBeGreaterThanOrEqual(59);
    expect(after.running).toBe(false);
    expect(after.exportedThrough.getTime()).toBeGreaterThan(
      Date.now() - 2 * HOUR,
    );
  });

  test("a start date in the future is refused", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();

    await expect(
      costExportService.create({
        organizationId: organization.id,
        data: {
          name: "later",
          blobProviderId: (await makeProvider(organization.id)).id,
          format: "focus_csv",
          schedule: "daily",
          pathPrefix: "costs",
          enabled: true,
          startFrom: new Date(Date.now() + DAY).toISOString(),
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("run now rewrites the latest completed period when nothing is due", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const costExport = await costExportService.create({
      organizationId: organization.id,
      data: {
        name: "hourly",
        blobProviderId: (await makeProvider(organization.id)).id,
        format: "focus_csv",
        schedule: "hourly",
        pathPrefix: "archestra/costs",
        enabled: true,
      },
    });
    const params = { id: costExport.id, organizationId: organization.id };

    const queued = await costExportService.runNow(params);
    expect(queued.running).toBe(true);
    await runQueued();
    const first = await costExportService.get(params);
    await costExportService.runNow(params);
    await runQueued();
    const second = await costExportService.get(params);

    expect(first).toMatchObject({ running: false, lastRunStatus: "success" });
    expect(second.lastObjectKey).toBe(first.lastObjectKey);
    expect(s3.keys()).toEqual([first.lastObjectKey]);
  });

  test("run now refuses while a run is queued", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const costExport = await makeExport({
      organizationId: organization.id,
      exportedThrough: startOfHour(Date.now() - 2 * HOUR),
    });
    const params = { id: costExport.id, organizationId: organization.id };

    await costExportService.runNow(params);

    await expect(costExportService.runNow(params)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test("a tick queues one run per due export, never a second while one is pending", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const hour = startOfHour(Date.now() - 2 * HOUR);
    await makeExport({
      organizationId: organization.id,
      exportedThrough: hour,
    });
    await makeExport({
      organizationId: organization.id,
      exportedThrough: hour,
    });

    await costExportService.runDue();
    await costExportService.runDue();

    expect(await pendingRuns()).toHaveLength(2);
  });

  test("a run whose claim expired and was taken over writes nothing", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const costExport = await makeExport({
      organizationId: organization.id,
      exportedThrough: startOfHour(Date.now() - 2 * HOUR),
    });
    const stale = await CostExportModel.claimRun({
      id: costExport.id,
      leaseSeconds: -1,
    });
    // The stale claim has expired; another run takes the lease.
    await CostExportModel.claimRun({ id: costExport.id, leaseSeconds: 900 });

    await costExportService.runQueued({
      costExportId: costExport.id,
      claimedUntil: stale?.runningUntil.toISOString(),
      rewriteLatest: false,
    });

    expect(s3.keys()).toEqual([]);
  });
});

// ===== Helpers =====

/** Run every queued `cost_export_run` task, as a worker would. */
async function runQueued() {
  for (const task of await pendingRuns()) {
    await costExportService.runQueued(task.payload);
    await TaskModel.complete(task.id);
  }
}

async function pendingRuns() {
  const tasks = [];
  for (;;) {
    const task = await TaskModel.dequeue(["cost_export_run"]);
    if (!task) break;
    tasks.push(task);
  }
  // Dequeue marked them processing; the caller completes them.
  return tasks;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

async function makeProvider(organizationId: string) {
  return BlobProviderModel.create({
    organizationId,
    name: `bucket-${crypto.randomUUID()}`,
    config: {
      type: "s3",
      bucket: "finops",
      region: "us-east-1",
      keyPrefix: "",
      endpoint: null,
      forcePathStyle: false,
      authMethod: "default_chain",
      roleArn: null,
      externalId: null,
    },
    secretId: null,
  });
}

async function makeExport(params: {
  organizationId: string;
  exportedThrough: Date;
}) {
  const provider = await makeProvider(params.organizationId);
  return CostExportModel.create({
    organizationId: params.organizationId,
    blobProviderId: provider.id,
    name: "hourly",
    enabled: true,
    format: "focus_csv",
    schedule: "hourly",
    pathPrefix: "archestra/costs",
    exportedThrough: params.exportedThrough,
  });
}

function startOfHour(ms: number): Date {
  const date = new Date(ms);
  date.setUTCMinutes(0, 0, 0);
  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoHour(date: Date): string {
  return date.toISOString().slice(0, 13);
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Minimal RFC 4180 reader for the test's own output. */
function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  const [header, ...rows] = records;
  return rows.map((row) =>
    Object.fromEntries(header.map((name, index) => [name, row[index]])),
  );
}
