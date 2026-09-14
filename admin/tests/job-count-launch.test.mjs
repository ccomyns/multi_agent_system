import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, imports = {}, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const compiledModule = { exports: {} };
  vm.runInNewContext(outputText, { module: compiledModule, exports: compiledModule.exports,
    require: (name) => imports[name] ?? require(name), Error, console, ...globals });
  return compiledModule.exports;
}
function harness(extract) {
  const writes = [], launches = [];
  let stored;
  const documents = {
    destroy() {},
    async send(command) {
      writes.push(command.input);
      if (command.input.TransactItems) stored = command.input.TransactItems[1].Put.Item;
      return { Attributes: { ...stored, status: "running", orchestrator_instance_id: "i-example" } };
    },
  };
  class EC2Client {
    destroy() {}
    async send(command) { launches.push(command.input); return { Instances: [{ InstanceId: "i-example" }] }; }
  }
  class TaskCountError extends Error { constructor(message, status) { super(message); this.status = status; } }
  const route = load("../app/api/jobs/route.ts", {
    "@/lib/aws": { awsClientOptions: () => ({}) },
    "@/lib/jobs": load("../lib/jobs.ts"),
    "@/lib/task-count": { TaskCountError, extractExpectedSubagentCount: async (prompt) => extract(prompt, TaskCountError) },
    "@/lib/github-repositories": {}, "@/lib/project-uploads": {}, "@/lib/databases": {},
    "@aws-sdk/lib-dynamodb": { ...require("@aws-sdk/lib-dynamodb"), DynamoDBDocumentClient: { from: () => documents } },
    "@aws-sdk/client-ec2": { ...require("@aws-sdk/client-ec2"), EC2Client },
  }, { process: { env: {
    JOBS_TABLE_NAME: "jobs", ORCHESTRATOR_LAUNCH_TEMPLATE_ID: "mining-template",
    SOFTWARE_BUILDER_ORCHESTRATOR_LAUNCH_TEMPLATE_ID: "software-template",
    GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME: "assignments",
    GLOBAL_MEMORY_BUCKET_NAME: "memory", AGENT_WORKSPACE_BUCKET_NAME: "workspace",
  } } });
  return { route, writes, launches };
}
function request() {
  return new Request("http://localhost/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: "job_abcd_12345678", originalTask: "Research 250 firms", typeOfJob: "data_mining" }) });
}

test("extracted count is stored and delivered as the bootstrap instance tag", async () => {
  const { route, writes, launches } = harness(async (prompt) => {
    assert.equal(prompt, "Research 250 firms");
    return 250;
  });
  const response = await route.POST(request());
  assert.equal(response.status, 201);
  assert.equal(writes[0].TransactItems[1].Put.Item.expected_subagent_count, 250);
  const tags = launches[0].TagSpecifications.find((entry) => entry.ResourceType === "instance").Tags;
  assert.equal(tags.find((tag) => tag.Key === "ExpectedSubagentCount").Value, "250");
});

test("extraction failure neither takes the lock nor launches EC2", async () => {
  const { route, writes, launches } = harness(async (_prompt, ErrorType) => { throw new ErrorType("No clear count", 400); });
  const response = await route.POST(request());
  assert.equal(response.status, 400);
  assert.equal(writes.length, 0);
  assert.equal(launches.length, 0);
});
