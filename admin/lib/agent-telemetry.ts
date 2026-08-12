export type TokenUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
};

export type AgentTelemetrySummary = {
  currentCheckpoint: string | null;
  detail: string | null;
  updatedAt: string | null;
  lastActivityAt: string | null;
  codexStartedAt: string | null;
  codexFinishedAt: string | null;
  codexExitCode: number | null;
  usage: TokenUsage;
};

export type AgentTelemetryEvent = {
  timestamp: string;
  checkpoint: string;
  detail: string;
  source: "runner" | "control_plane";
};

export type AgentTelemetryResponse = {
  actorType: "orchestrator" | "subagent";
  agentId: string | null;
  task: string;
  status: string;
  error?: string | null;
  isTerminal: boolean;
  telemetry: AgentTelemetrySummary | null;
  events: AgentTelemetryEvent[];
};

const EMPTY_USAGE: TokenUsage = {
  inputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  totalTokens: null,
};

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || nullableInteger(value) !== null;
}

function isClientTelemetry(value: unknown): value is AgentTelemetrySummary {
  const record = recordValue(value);
  const usage = recordValue(record?.usage);
  return Boolean(
    record &&
      (record.currentCheckpoint === null || typeof record.currentCheckpoint === "string") &&
      (record.detail === null || typeof record.detail === "string") &&
      (record.updatedAt === null || typeof record.updatedAt === "string") &&
      (record.lastActivityAt === null || typeof record.lastActivityAt === "string") &&
      (record.codexStartedAt === null || typeof record.codexStartedAt === "string") &&
      (record.codexFinishedAt === null || typeof record.codexFinishedAt === "string") &&
      isNullableInteger(record.codexExitCode) &&
      usage &&
      isNullableInteger(usage.inputTokens) &&
      isNullableInteger(usage.cachedInputTokens) &&
      isNullableInteger(usage.cacheWriteInputTokens) &&
      isNullableInteger(usage.outputTokens) &&
      isNullableInteger(usage.reasoningOutputTokens) &&
      isNullableInteger(usage.totalTokens),
  );
}

function isTelemetryEvent(value: unknown): value is AgentTelemetryEvent {
  const record = recordValue(value);
  return Boolean(
    record &&
      typeof record.timestamp === "string" &&
      typeof record.checkpoint === "string" &&
      typeof record.detail === "string" &&
      (record.source === "runner" || record.source === "control_plane"),
  );
}

export function parseTelemetrySummary(value: unknown): AgentTelemetrySummary | null {
  const record = recordValue(value);
  if (!record || record.schema_version !== 1) {
    return null;
  }
  const usage = recordValue(record.usage);
  return {
    currentCheckpoint: nullableString(record.current_checkpoint),
    detail: nullableString(record.detail),
    updatedAt: nullableString(record.updated_at),
    lastActivityAt: nullableString(record.last_activity_at),
    codexStartedAt: nullableString(record.codex_started_at),
    codexFinishedAt: nullableString(record.codex_finished_at),
    codexExitCode: nullableInteger(record.codex_exit_code),
    usage: usage
      ? {
          inputTokens: nullableInteger(usage.input_tokens),
          cachedInputTokens: nullableInteger(usage.cached_input_tokens),
          cacheWriteInputTokens: nullableInteger(usage.cache_write_input_tokens),
          outputTokens: nullableInteger(usage.output_tokens),
          reasoningOutputTokens: nullableInteger(usage.reasoning_output_tokens),
          totalTokens: nullableInteger(usage.total_tokens),
        }
      : { ...EMPTY_USAGE },
  };
}

export function parseTelemetryEvents(text: string): AgentTelemetryEvent[] {
  const events: AgentTelemetryEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = recordValue(JSON.parse(line));
      const timestamp = nullableString(record?.timestamp);
      const checkpoint = nullableString(record?.checkpoint);
      const detail = nullableString(record?.detail);
      if (timestamp && checkpoint && detail) {
        events.push({ timestamp, checkpoint, detail, source: "runner" });
      }
    } catch {
      // One malformed line should not hide otherwise valid telemetry.
    }
  }
  return events;
}

export function isAgentTelemetryResponse(value: unknown): value is AgentTelemetryResponse {
  const record = recordValue(value);
  return Boolean(
    record &&
      (record.actorType === "orchestrator" || record.actorType === "subagent") &&
      (record.agentId === null || typeof record.agentId === "string") &&
      typeof record.task === "string" &&
      typeof record.status === "string" &&
      (!("error" in record) || record.error === null || typeof record.error === "string") &&
      typeof record.isTerminal === "boolean" &&
      (record.telemetry === null || isClientTelemetry(record.telemetry)) &&
      Array.isArray(record.events) &&
      record.events.every(isTelemetryEvent),
  );
}
