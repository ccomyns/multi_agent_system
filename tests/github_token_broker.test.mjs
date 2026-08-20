import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  assignedRepository,
  BrokerError,
  createAppJwt,
  issueRepositoryToken,
  parseBrokerRequest,
} from "../src/github_token_broker/broker.mjs";

const JOB_ID = "job_abc1_1234abcd";
const INSTANCE_ID = "i-1234567890abcdef0";

function request() {
  return {
    job_id: JOB_ID,
    orchestrator_instance_id: INSTANCE_ID,
  };
}

function activeLock() {
  return { active_job_id: { S: `JOB#${JOB_ID}` } };
}

function job() {
  return {
    job_id: { S: JOB_ID },
    type_of_job: { S: "software_builder" },
    status: { S: "running" },
    orchestrator_instance_id: { S: INSTANCE_ID },
  };
}

function assignment() {
  return {
    job_id: { S: JOB_ID },
    github_repository_id: { N: "123456789" },
    github_repository_full_name: { S: "mas-workspace/example-repository" },
  };
}

function keyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
}

test("broker input cannot select its own repository", () => {
  assert.throws(
    () => parseBrokerRequest({ ...request(), repository_id: 999 }),
    (error) =>
      error instanceof BrokerError &&
      error.code === "repository_scope_not_accepted",
  );
});

test("repository scope comes from the trusted assignment table", () => {
  assert.deepEqual(
    assignedRepository({
      request: parseBrokerRequest(request()),
      activeLock: activeLock(),
      job: job(),
      assignment: assignment(),
      organization: "mas-workspace",
    }),
    {
      id: 123456789,
      fullName: "mas-workspace/example-repository",
    },
  );
});

test("repository assignment rejects another orchestrator", () => {
  const anotherJob = job();
  anotherJob.orchestrator_instance_id = { S: "i-abcdef12345678901" };
  assert.throws(
    () =>
      assignedRepository({
        request: parseBrokerRequest(request()),
        activeLock: activeLock(),
        job: anotherJob,
        assignment: assignment(),
        organization: "mas-workspace",
      }),
    (error) =>
      error instanceof BrokerError && error.code === "orchestrator_mismatch",
  );
});

test("App JWT uses RS256 and the configured client ID", () => {
  const { privateKey, publicKey } = keyPair();
  const nowMs = Date.parse("2026-08-20T01:00:00Z");
  const jwt = createAppJwt({
    clientId: "Iv-writer-client",
    privateKey,
    nowMs,
  });
  const [header, payload, signature] = jwt.split(".");

  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
    iat: Math.floor(nowMs / 1000) - 60,
    exp: Math.floor(nowMs / 1000) + 540,
    iss: "Iv-writer-client",
  });
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
});

test("issued installation token is limited to the assigned repository", async () => {
  const { privateKey } = keyPair();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/orgs/mas-workspace/installation")) {
      return new Response(JSON.stringify({ id: 777 }), { status: 200 });
    }
    if (url.endsWith("/app/installations/777/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "ghs_repository_scoped_token",
          expires_at: "2026-08-20T02:00:00Z",
        }),
        { status: 201 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await issueRepositoryToken(
    request(),
    {
      getActiveLock: async () => activeLock(),
      getJob: async () => job(),
      getAssignment: async () => assignment(),
      getPrivateKey: async () => privateKey,
      fetchImpl,
      nowMs: Date.parse("2026-08-20T01:00:00Z"),
    },
    {
      clientId: "Iv-writer-client",
      organization: "mas-workspace",
    },
  );

  assert.equal(result.token, "ghs_repository_scoped_token");
  assert.deepEqual(result.repository, {
    id: 123456789,
    fullName: "mas-workspace/example-repository",
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    repository_ids: [123456789],
    permissions: {
      contents: "write",
      metadata: "read",
    },
  });
});
