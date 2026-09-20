import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const jobId = "job_abc1_1234abcd";
const agentId = `sw-${"a".repeat(32)}`;

function harness(agentOverrides = {}) {
  const reads = [];
  const job = { job_id: jobId, type_of_job: "software_builder", status: "running", orchestrator_instance_id: "i-parent" };
  const agent = { job_id: jobId, agent_id: agentId, state: "RUNNING", output_bucket: "memory", output_prefix: `project/${agentId}/`, ...agentOverrides };
  class GetCommand { constructor(input) { this.input = input; } }
  class Client {
    async send(command) { return { Item: command.input.TableName === "jobs" ? job : agent }; }
    destroy() {}
  }
  const stubs = {
    "@aws-sdk/client-dynamodb": { DynamoDBClient: Client },
    "@aws-sdk/client-s3": { S3Client: Client },
    "@aws-sdk/lib-dynamodb": { DynamoDBDocumentClient: { from: () => new Client() }, GetCommand },
    "next/server": { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
    "@/lib/aws": { awsClientOptions: () => ({}) },
    "@/lib/jobs": { DEFAULT_JOB_TYPE: "data_mining", isJobType: () => true, JOB_ID_PATTERN: /^job_/ },
    "@/lib/telemetry-server": {
      controlPlaneEvent: () => null,
      mergeTelemetryEvents: () => [],
      readOptionalS3Text: async (_s3, bucket, key) => { reads.push({ bucket, key }); return key.endsWith("input.json") ? JSON.stringify({ task: "Research" }) : null; },
      readAgentTelemetry: async (_s3, bucket, key) => { reads.push({ bucket, key }); return { telemetry: null, events: [] }; },
    },
  };
  const source = ts.transpileModule(readFileSync(new URL("../app/api/jobs/[jobId]/agents/[agentId]/telemetry/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports, require: (name) => { assert.ok(name in stubs, name); return stubs[name]; },
    Response, console,
    process: { env: { JOBS_TABLE_NAME: "jobs", STATE_TABLE_NAME: "state", AGENT_WORKSPACE_BUCKET_NAME: "workspace", GLOBAL_MEMORY_BUCKET_NAME: "memory" } },
  });
  return { reads, get: () => exports.GET(new Request("http://localhost/telemetry"), { params: Promise.resolve({ jobId, agentId }) }) };
}

test("software telemetry uses the stored agent folder and exposes its output URI", async () => {
  const h = harness();
  const response = await h.get();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outputUri, `s3://memory/project/${agentId}/`);
  assert.equal(body.task, "Research");
  assert.equal(h.reads.length, 4);
  assert.ok(h.reads.every(({ bucket, key }) => bucket === "memory" && key.startsWith(`project/${agentId}/_runtime/`)));
});

test("telemetry rejects an agent belonging to another job before reading S3", async () => {
  const h = harness({ job_id: "job_other_1234abcd" });
  assert.equal((await h.get()).status, 404);
  assert.equal(h.reads.length, 0);
});

test("telemetry rejects a bucket outside the configured global-memory bucket", async () => {
  const h = harness({ output_bucket: "another-bucket" });
  assert.equal((await h.get()).status, 503);
  assert.equal(h.reads.length, 0);
});
