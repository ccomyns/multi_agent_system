import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import {
  BrokerError,
  issueRepositoryToken,
} from "./broker.mjs";

const dynamodb = new DynamoDBClient({});
const ssm = new SSMClient({});

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new BrokerError(
      500,
      "broker_not_configured",
      `The token broker is missing ${name}.`,
    );
  }
  return value;
}

function configuration() {
  return {
    clientId: requiredEnvironment("GITHUB_WRITER_APP_CLIENT_ID"),
    organization: requiredEnvironment("GITHUB_ORGANIZATION"),
    jobsTable: requiredEnvironment("JOBS_TABLE_NAME"),
    assignmentsTable: requiredEnvironment(
      "GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME",
    ),
    privateKeyParameter: requiredEnvironment(
      "GITHUB_WRITER_PRIVATE_KEY_SSM_PARAMETER_NAME",
    ),
  };
}

async function item(tableName, keyName, key) {
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { [keyName]: { S: key } },
      ConsistentRead: true,
    }),
  );
  return response.Item ?? null;
}

async function privateKey(parameterName) {
  const response = await ssm.send(
    new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    }),
  );
  const value = response.Parameter?.Value;
  if (
    typeof value !== "string" ||
    !value.includes("-----BEGIN") ||
    !value.includes("PRIVATE KEY-----")
  ) {
    throw new BrokerError(
      500,
      "private_key_unavailable",
      "The GitHub writer private-key parameter is empty or invalid.",
    );
  }
  return value;
}

export async function handler(event) {
  try {
    const config = configuration();
    const body = await issueRepositoryToken(
      event,
      {
        getActiveLock: () => item(config.jobsTable, "pk", "ACTIVE_JOB"),
        getJob: (jobId) => item(config.jobsTable, "pk", `JOB#${jobId}`),
        getAssignment: (jobId) =>
          item(config.assignmentsTable, "job_id", jobId),
        getPrivateKey: () => privateKey(config.privateKeyParameter),
      },
      config,
    );
    return { statusCode: 200, body };
  } catch (error) {
    if (error instanceof BrokerError) {
      console.error("GitHub token broker request failed", {
        code: error.code,
        message: error.message,
      });
      return {
        statusCode: error.statusCode,
        body: { error: error.code, message: error.message },
      };
    }
    console.error("GitHub token broker request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown failure",
    });
    return {
      statusCode: 500,
      body: {
        error: "internal_error",
        message: "The GitHub token could not be issued.",
      },
    };
  }
}
