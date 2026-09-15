import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Execute the actual route against in-memory AWS clients. No credentials,
// network requests, instances, or deployed jobs are used by these tests.
function harness(status = "running", type = "software_builder", completeDuringEnd = false) {
  let item = {
    pk: "JOB#job_abc1_1234abcd", job_id: "job_abc1_1234abcd",
    original_task: "Build a dashboard", type_of_job: type, status,
    created_at: "2026-01-01T00:00:00Z", orchestrator_instance_id: "i-test",
  };
  const calls = [];
  const commands = {};
  for (const name of ["GetCommand", "ScanCommand", "TransactWriteCommand", "UpdateCommand",
    "RunInstancesCommand", "TerminateInstancesCommand", "ListObjectsV2Command", "PutObjectCommand"]) {
    commands[name] = class { constructor(input) { this.input = input; this.name = name; } };
  }
  class Client {
    destroy() {}
    async send(command) {
      calls.push(command);
      const input = command.input;
      switch (command.name) {
        case "GetCommand": return { Item: { ...item } };
        case "TransactWriteCommand": {
          const job = input.TransactItems.find((entry) => entry.Put?.Item.original_task)?.Put.Item;
          if (job) item = { ...job };
          const terminal = input.TransactItems.find((entry) => entry.Update)?.Update;
          if (terminal) item.status = terminal.ExpressionAttributeValues[":status"];
          return {};
        }
        case "UpdateCommand": {
          assert.match(input.ConditionExpression, /status|attribute_exists/);
          if (input.UpdateExpression.includes("end_requested_at")) {
            assert.match(input.ConditionExpression, /type_of_job = :software/);
            if (completeDuringEnd) {
              item.status = "completed";
              throw Object.assign(new Error("Job completed concurrently"), { name: "ConditionalCheckFailedException" });
            }
            item.end_requested_at ??= input.ExpressionAttributeValues[":now"];
          } else {
            item.status = "running";
            item.orchestrator_instance_id = "i-test";
          }
          return { Attributes: { ...item } };
        }
        case "RunInstancesCommand": return { Instances: [{ InstanceId: "i-test" }] };
        case "TerminateInstancesCommand": return {};
        default: throw new Error(`Unexpected ${command.name}`);
      }
    }
  }
  const stubs = {
    "@aws-sdk/client-dynamodb": { DynamoDBClient: Client, TransactionCanceledException: class extends Error {} },
    "@aws-sdk/client-ec2": { EC2Client: Client, ...commands },
    "@aws-sdk/client-s3": { S3Client: Client, ...commands },
    "@aws-sdk/lib-dynamodb": { DynamoDBDocumentClient: { from: () => new Client() }, ...commands },
    "next/server": { NextResponse: { json: (data, init) => new Response(JSON.stringify(data), init) } },
    "@/lib/aws": { awsClientOptions: () => ({}) },
    "@/lib/task-count": { extractExpectedSubagentCount: async () => 1, TaskCountError: class extends Error {} },
    "@/lib/github-repositories": {
      getOrganizationRepository: async (id) => ({ id, fullName: "org/repo" }),
      GitHubApiError: class extends Error {}, GitHubConfigurationError: class extends Error {},
    },
    "@/lib/project-uploads": {}, "@/lib/databases": {},
  };
  function load(relative) {
    const source = ts.transpileModule(readFileSync(path.join(__dirname, "..", relative), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(source, {
      exports, require: (name) => {
        if (!(name in stubs)) throw new Error(`Missing stub ${name}`);
        return stubs[name];
      },
      Request, Response, URL, Buffer, TextDecoder, console, Error,
      process: { env: Object.fromEntries([
        "JOBS_TABLE_NAME", "ORCHESTRATOR_LAUNCH_TEMPLATE_ID", "SOFTWARE_BUILDER_ORCHESTRATOR_LAUNCH_TEMPLATE_ID",
        "GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME", "GLOBAL_MEMORY_BUCKET_NAME", "AGENT_WORKSPACE_BUCKET_NAME",
      ].map((key) => [key, key])) },
    });
    return exports;
  }
  stubs["@/lib/jobs"] = load("lib/jobs.ts");
  return { route: load("app/api/jobs/route.ts"), calls, item: () => item };
}

function endRequest() { return new Request("http://localhost/api/jobs?jobId=job_abc1_1234abcd", { method: "DELETE" }); }
function launchRequest(reprompt, typeOfJob = "software_builder") {
  return new Request("http://localhost/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: "job_abc1_1234abcd", originalTask: "Build a dashboard", typeOfJob,
      githubRepositoryId: typeOfJob === "software_builder" ? 123 : undefined, reprompt }) });
}

test("software End Job preserves the instance and lock until worker completion", async () => {
  const { route, calls, item } = harness();
  const response = await route.DELETE(endRequest());
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal(job.status, "running");
  assert.ok(job.endRequestedAt);
  assert.equal(job.finishedAt, null);
  assert.equal(item().status, "running");
  assert.deepEqual(calls.map((call) => call.name), ["GetCommand", "UpdateCommand"]);
  const repeated = await route.DELETE(endRequest());
  assert.equal((await repeated.json()).endRequestedAt, job.endRequestedAt);
  assert.equal(calls.filter((call) => call.name === "UpdateCommand").length, 1);
});

test("software End Job can be requested during initialization", async () => {
  const { route, item } = harness("initializing");
  assert.equal((await route.DELETE(endRequest())).status, 202);
  assert.equal(item().status, "initializing");
  assert.ok(item().end_requested_at);
});

test("ending completed software jobs is read-only", async () => {
  const { route, calls } = harness("completed");
  assert.equal((await route.DELETE(endRequest())).status, 200);
  assert.deepEqual(calls.map((call) => call.name), ["GetCommand"]);
});

test("completion racing End Job returns terminal status without terminating anything", async () => {
  const { route, calls } = harness("running", "software_builder", true);
  const response = await route.DELETE(endRequest());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "completed");
  assert.deepEqual(calls.map((call) => call.name), ["GetCommand", "UpdateCommand", "GetCommand"]);
});

test("data-mining End Job retains existing termination behavior", async () => {
  const { route, calls } = harness("running", "data_mining");
  assert.equal((await route.DELETE(endRequest())).status, 200);
  assert.ok(calls.some((call) => call.name === "TerminateInstancesCommand"));
  assert.ok(calls.some((call) => call.name === "TransactWriteCommand"));
});

test("software launch persists the trimmed REPROMPT with the task", async () => {
  const { route, item, calls } = harness();
  const response = await route.POST(launchRequest("  Be ambitious.  "));
  assert.equal(response.status, 201);
  assert.equal(item().reprompt, "Be ambitious.");
  assert.equal(item().original_task, "Build a dashboard");
  assert.ok(calls.some((call) => call.name === "RunInstancesCommand"));
});

test("invalid REPROMPT is rejected before any AWS mutation", async () => {
  for (const [reprompt, type] of [[{}, "software_builder"], ["x".repeat(4001), "software_builder"], ["encouragement", "data_mining"]]) {
    const { route, calls } = harness();
    assert.equal((await route.POST(launchRequest(reprompt, type))).status, 400);
    assert.equal(calls.length, 0);
  }
});

test("missing, null, empty, and whitespace REPROMPT are stored as null for single-turn jobs", async () => {
  for (const reprompt of [undefined, null, "", " \n\t "]) {
    const { route, item } = harness();
    assert.equal((await route.POST(launchRequest(reprompt))).status, 201);
    assert.equal(item().reprompt, null);
  }
});
