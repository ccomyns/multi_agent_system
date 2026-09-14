import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function harness(fetch, env = { OPENAI_API_KEY: "test-key" }) {
  const source = readFileSync(new URL("../lib/task-count.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const compiledModule = { exports: {} };
  vm.runInNewContext(outputText, { module: compiledModule, exports: compiledModule.exports, fetch,
    process: { env }, AbortSignal, Error });
  return compiledModule.exports;
}
function response(count, extra = {}) {
  return { ok: true, json: async () => ({ status: "completed", output: [
    { type: "message", content: [{ type: "output_text", text: JSON.stringify({ count }) }] },
  ], ...extra }) };
}

test("extracts a count with a strict schema and sends the original prompt", async () => {
  const prompt = "Research 250 firms with 5 fields each, founded after 1990.";
  const api = harness(async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.input, prompt);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.model, "configured-model");
    return response(250);
  }, { OPENAI_API_KEY: "test-key", OPENAI_TASK_COUNT_MODEL: "configured-model" });
  assert.equal(await api.extractExpectedSubagentCount(prompt), 250);
});

test("rejects absent, ambiguous, nonpositive, fractional and unsafe counts", async () => {
  for (const count of [null, 0, -1, 1.5, "250", Number.MAX_SAFE_INTEGER + 1]) {
    const api = harness(async () => response(count));
    await assert.rejects(api.extractExpectedSubagentCount("prompt"), (error) => error.status === 400);
  }
});

test("configuration, upstream failure, refusal and incomplete output cannot launch a job", async () => {
  const missing = harness(() => { throw new Error("must not call API"); }, {});
  await assert.rejects(missing.extractExpectedSubagentCount("250 firms"), (error) => error.status === 503);
  for (const result of [{ ok: false }, response(250, { status: "incomplete" }),
    response(250, { output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }] })]) {
    const api = harness(async () => result);
    await assert.rejects(api.extractExpectedSubagentCount("250 firms"), (error) => error.status === 502);
  }
});
