import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  parseTelemetryEvents,
  parseTelemetrySummary,
} from "@/lib/agent-telemetry";
import type {
  AgentTelemetryEvent,
  AgentTelemetrySummary,
} from "@/lib/agent-telemetry";

function isNotFound(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export async function readOptionalS3Text(
  s3: S3Client,
  bucket: string,
  key: string,
) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await response.Body?.transformToString()) ?? null;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function readAgentTelemetry(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<{ telemetry: AgentTelemetrySummary | null; events: AgentTelemetryEvent[] }> {
  const [latestText, eventsText] = await Promise.all([
    readOptionalS3Text(s3, bucket, `${prefix}/latest.json`),
    readOptionalS3Text(s3, bucket, `${prefix}/events.jsonl`),
  ]);
  let telemetry: AgentTelemetrySummary | null = null;
  if (latestText) {
    try {
      telemetry = parseTelemetrySummary(JSON.parse(latestText));
    } catch {
      telemetry = null;
    }
  }
  return {
    telemetry,
    events: eventsText ? parseTelemetryEvents(eventsText) : [],
  };
}

export function controlPlaneEvent(
  timestamp: unknown,
  checkpoint: string,
  detail: string,
): AgentTelemetryEvent | null {
  return typeof timestamp === "string" && timestamp.length > 0
    ? { timestamp, checkpoint, detail, source: "control_plane" }
    : null;
}

export function mergeTelemetryEvents(
  runnerEvents: AgentTelemetryEvent[],
  controlEvents: Array<AgentTelemetryEvent | null>,
) {
  return [...runnerEvents, ...controlEvents.filter((event) => event !== null)].sort(
    (left, right) => left.timestamp.localeCompare(right.timestamp),
  );
}
