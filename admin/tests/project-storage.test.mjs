import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url);
function load(path, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  vm.runInNewContext(outputText, { module, exports: module.exports, require: (name) => imports[name] ?? require(name) });
  return module.exports;
}
const types = load("../lib/project-uploads.ts");
const storage = load("../lib/project-storage.ts", { "@/lib/project-uploads": types });

test("directory listing stays within a folder, follows pages and retains file metadata", async () => {
  const calls = [];
  const pages = [
    { CommonPrefixes: [{ Prefix: "crunchmini/raw/nested/" }], Contents: [{ Key: "crunchmini/raw/", Size: 0 }, { Key: "crunchmini/raw/a #1.json", Size: 42, LastModified: new Date("2026-09-11T12:00:00Z") }], IsTruncated: true, NextContinuationToken: "next" },
    { Contents: [{ Key: "crunchmini/raw/b.json", Size: 100 }, { Key: "other/private.json", Size: 20 }], IsTruncated: false },
  ];
  const entries = await storage.listProjectDirectory({ send: async (command) => { calls.push(command.input); return pages.shift(); } }, "bucket", "crunchmini", "raw/");
  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, "folder");
  assert.equal(entries[0].path, "raw/nested/");
  assert.equal(entries[1].name, "a #1.json");
  assert.equal(entries[1].size, 42);
  assert.equal(entries[1].modifiedAt, "2026-09-11T12:00:00.000Z");
  assert.ok(calls.every((call) => call.Prefix === "crunchmini/raw/" && call.Delimiter === "/"));
  assert.equal(calls[1].ContinuationToken, "next");
});

test("invalid folder paths are rejected before S3 access", async () => {
  const s3 = { send: async () => { throw new Error("must not call S3"); } };
  for (const [project, path] of [["../other", ""], ["crunchmini", "../"], ["crunchmini", "/other/"], ["crunchmini", "raw/../../"], ["crunchmini", "raw//"], ["crunchmini", "raw"], ["crunchmini", "\0/"]]) {
    assert.equal(types.validProjectDirectory(project, path), false);
    await assert.rejects(storage.listProjectDirectory(s3, "bucket", project, path), /Invalid project directory/);
  }
  assert.equal(types.validProjectDirectory("crunchmini", ""), true);
  assert.equal(types.validProjectDirectory("crunchmini", "folder #1/"), true);
});

test("empty folders and broken S3 pagination are handled explicitly", async () => {
  assert.equal((await storage.listProjectDirectory({ send: async () => ({}) }, "bucket", "project", "")).length, 0);
  await assert.rejects(storage.listProjectDirectory({ send: async () => ({ IsTruncated: true }) }, "bucket", "project", ""), /could not be completed/);
  await assert.rejects(storage.listProjectDirectory({ send: async () => ({ IsTruncated: true, NextContinuationToken: "same" }) }, "bucket", "project", ""), /could not be completed/);
});
