import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
} from "@aws-sdk/client-ec2";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";
import type {
  StressTestCall,
  StressTestLaunch,
  StressTestReport,
} from "@/lib/stress-test";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Leave room for the harness's "-call-100" request-ID suffix (Lambda permits 128 chars).
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,118}$/;
const INSTANCE_ID_PATTERN = /^i-[0-9a-f]+$/;

type StressTestRequest = {
  invocations?: unknown;
  expectedLimit?: unknown;
  orchestratorId?: unknown;
};

type StoredReport = {
  test?: unknown;
  orchestrator_id?: unknown;
  run_at?: unknown;
  expected_limit?: unknown;
  invocations?: unknown;
  accepted?: unknown;
  rejected?: unknown;
  passed?: unknown;
  results?: unknown;
};

function json(data: unknown, init?: ResponseInit) {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function errorResponse(error: string, status: number) {
  return json({ error }, { status });
}

function readInteger(value: unknown, name: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function isMissingS3Key(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  const metadata = (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata;
  return error.name === "NoSuchKey" || metadata?.httpStatusCode === 404;
}

function parseStoredReport(value: unknown): StressTestReport {
  if (typeof value !== "object" || value === null) {
    throw new Error("The stored stress-test report is not a JSON object.");
  }
  const stored = value as StoredReport;
  const numericFields = [
    stored.expected_limit,
    stored.invocations,
    stored.accepted,
    stored.rejected,
  ];
  if (
    stored.test !== "subagent_concurrency_limit" ||
    typeof stored.orchestrator_id !== "string" ||
    typeof stored.run_at !== "string" ||
    !numericFields.every(Number.isInteger) ||
    typeof stored.passed !== "boolean" ||
    !Array.isArray(stored.results)
  ) {
    throw new Error("The stored stress-test report has an unexpected shape.");
  }

  const calls: StressTestCall[] = stored.results.map((result, index) => {
    if (
      typeof result !== "object" ||
      result === null ||
      !("statusCode" in result) ||
      typeof result.statusCode !== "number"
    ) {
      throw new Error("The stored stress-test report contains an invalid call result.");
    }
    return {
      call: index + 1,
      status: result.statusCode,
      body: "body" in result ? result.body : null,
    };
  });

  return {
    test: "subagent_concurrency_limit",
    orchestratorId: stored.orchestrator_id,
    runAt: stored.run_at,
    expectedLimit: stored.expected_limit as number,
    invocations: stored.invocations as number,
    accepted: stored.accepted as number,
    rejected: stored.rejected as number,
    passed: stored.passed,
    calls,
  };
}

function configuration() {
  const launchTemplateId = process.env.STRESS_TEST_LAUNCH_TEMPLATE_ID;
  const auditBucket = process.env.AUDIT_BUCKET_NAME;
  if (!launchTemplateId || !auditBucket) {
    return null;
  }
  return {
    launchTemplateId,
    launchTemplateVersion: process.env.STRESS_TEST_LAUNCH_TEMPLATE_VERSION || "$Default",
    auditBucket,
    region: process.env.AWS_REGION,
  };
}

export async function POST(request: Request) {
  if (process.env.STRESS_TESTS_ENABLED !== "true") {
    return errorResponse(
      "Stress tests are disabled. Set STRESS_TESTS_ENABLED=true on the admin server to enable them.",
      503,
    );
  }

  const config = configuration();
  if (!config) {
    return errorResponse(
      "The admin server is missing STRESS_TEST_LAUNCH_TEMPLATE_ID or AUDIT_BUCKET_NAME.",
      503,
    );
  }

  let input: StressTestRequest;
  try {
    input = (await request.json()) as StressTestRequest;
  } catch {
    return errorResponse("Request body must be valid JSON.", 400);
  }

  let invocations: number;
  let expectedLimit: number;
  let orchestratorId: string;
  try {
    invocations = readInteger(input.invocations, "invocations", 2, 100);
    expectedLimit = readInteger(input.expectedLimit, "expectedLimit", 1, 99);
    if (expectedLimit >= invocations) {
      throw new Error("expectedLimit must be less than invocations so the rejection boundary is tested.");
    }

    orchestratorId =
      typeof input.orchestratorId === "string" && input.orchestratorId.length > 0
        ? input.orchestratorId
        : `stress-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    if (!ID_PATTERN.test(orchestratorId)) {
      throw new Error(
        "orchestratorId must be 1-119 characters using letters, numbers, '.', '_', ':', or '-'.",
      );
    }
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Invalid request.", 400);
  }

  const s3 = new S3Client(awsClientOptions());
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: config.auditBucket,
        Key: `stress-tests/${orchestratorId}.json`,
      }),
    );
    return errorResponse(
      "A stress-test report already exists for that orchestrator ID. Use a new ID.",
      409,
    );
  } catch (error) {
    if (!isMissingS3Key(error)) {
      console.error("Stress-test report preflight failed", error);
      return errorResponse(
        error instanceof Error ? error.message : "The audit bucket could not be checked.",
        502,
      );
    }
  } finally {
    s3.destroy();
  }

  const ec2 = new EC2Client(awsClientOptions());
  try {
    const response = await ec2.send(
      new RunInstancesCommand({
        LaunchTemplate: {
          LaunchTemplateId: config.launchTemplateId,
          Version: config.launchTemplateVersion,
        },
        MinCount: 1,
        MaxCount: 1,
        ClientToken: randomUUID(),
        MetadataOptions: {
          HttpEndpoint: "enabled",
          HttpProtocolIpv6: "disabled",
          HttpPutResponseHopLimit: 1,
          HttpTokens: "required",
          InstanceMetadataTags: "enabled",
        },
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              { Key: "Name", Value: "subagent-concurrency-stress-test" },
              { Key: "Role", Value: "orchestrator" },
              { Key: "Mode", Value: "stress-test" },
              { Key: "StressOrchestratorId", Value: orchestratorId },
              { Key: "StressInvocations", Value: String(invocations) },
              { Key: "StressExpectedLimit", Value: String(expectedLimit) },
            ],
          },
          {
            ResourceType: "volume",
            Tags: [
              { Key: "Role", Value: "orchestrator" },
              { Key: "Mode", Value: "stress-test" },
              { Key: "StressOrchestratorId", Value: orchestratorId },
            ],
          },
        ],
      }),
    );
    const instanceId = response.Instances?.[0]?.InstanceId;
    if (!instanceId) {
      throw new Error("EC2 accepted the launch request without returning an instance ID.");
    }

    const launch: StressTestLaunch = {
      orchestratorId,
      instanceId,
      startedAt: new Date().toISOString(),
      invocations,
      expectedLimit,
    };
    return json(launch, { status: 202 });
  } catch (error) {
    console.error("Stress-test orchestrator launch failed", error);
    return errorResponse(
      error instanceof Error ? error.message : "The stress-test orchestrator could not be launched.",
      502,
    );
  } finally {
    ec2.destroy();
  }
}

export async function GET(request: Request) {
  if (process.env.STRESS_TESTS_ENABLED !== "true") {
    return errorResponse(
      "Stress tests are disabled. Set STRESS_TESTS_ENABLED=true on the admin server to enable them.",
      503,
    );
  }

  const config = configuration();
  if (!config) {
    return errorResponse(
      "The admin server is missing STRESS_TEST_LAUNCH_TEMPLATE_ID or AUDIT_BUCKET_NAME.",
      503,
    );
  }

  const url = new URL(request.url);
  const orchestratorId = url.searchParams.get("orchestratorId") ?? "";
  const instanceId = url.searchParams.get("instanceId") ?? "";
  if (!ID_PATTERN.test(orchestratorId) || !INSTANCE_ID_PATTERN.test(instanceId)) {
    return errorResponse("A valid orchestratorId and instanceId are required.", 400);
  }

  const s3 = new S3Client(awsClientOptions());
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: config.auditBucket,
        Key: `stress-tests/${orchestratorId}.json`,
      }),
    );
    if (!response.Body) {
      throw new Error("S3 returned an empty stress-test report.");
    }
    const report = parseStoredReport(JSON.parse(await response.Body.transformToString()));
    return json({ status: "complete", report });
  } catch (error) {
    if (!isMissingS3Key(error)) {
      console.error("Stress-test report read failed", error);
      return errorResponse(
        error instanceof Error ? error.message : "The stress-test report could not be read.",
        502,
      );
    }
  } finally {
    s3.destroy();
  }

  const ec2 = new EC2Client(awsClientOptions());
  try {
    const response = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    const instanceState = response.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "pending";
    if (["shutting-down", "terminated", "stopped"].includes(instanceState)) {
      return json({
        status: "failed",
        error: `The stress-test instance reached ${instanceState} without writing a report.`,
      });
    }
    return json({ status: "running", instanceState });
  } catch (error) {
    if (error instanceof Error && error.name === "InvalidInstanceID.NotFound") {
      return json({ status: "running", instanceState: "pending" });
    }
    console.error("Stress-test instance status read failed", error);
    return errorResponse(
      error instanceof Error ? error.message : "The stress-test instance status could not be read.",
      502,
    );
  } finally {
    ec2.destroy();
  }
}
