import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(relativePath, imports = {}, globals = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const compiledModule = { exports: {} };
  vm.runInNewContext(outputText, {
    module: compiledModule, exports: compiledModule.exports,
    require: (name) => imports[name] ?? require(name),
    Error, ...globals,
  });
  return compiledModule.exports;
}

const types = load("../lib/database-types.ts");
function api(overrides = {}) {
  const creations = [];
  const route = load("../app/api/databases/route.ts", {
    "@/lib/database-types": types,
    "@/lib/databases": {
      DatabaseConfigurationError: class extends Error {},
      DatabaseConflictError: class extends Error {},
      listDatabases: async () => [{ name: "existing_app", description: "Existing" }],
      createDatabase: async (name, description) => {
        creations.push({ name, description });
        return { database: { name, description } };
      },
      ...overrides,
    },
  });
  return { ...route, creations };
}
const request = (body) => new Request("http://localhost/api/databases", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function provisioningHarness() {
  const parameters = new Map();
  const roles = new Set();
  const databases = new Map();
  const statements = [];
  let failSuffix;
  let acquired = true;
  class GetParameterCommand { constructor(input) { this.input = input; } }
  class GetParametersCommand { constructor(input) { this.input = input; } }
  class PutParameterCommand { constructor(input) { this.input = input; } }
  class SSMClient {
    destroy() {}
    async send(command) {
      const input = command.input;
      if (command instanceof PutParameterCommand) {
        if (failSuffix && input.Name.endsWith(failSuffix)) { failSuffix = undefined; throw new Error("simulated SSM outage"); }
        if (!input.Overwrite && parameters.has(input.Name)) throw new Error("already exists");
        parameters.set(input.Name, input.Value);
        return {};
      }
      if (command instanceof GetParameterCommand) {
        if (!parameters.has(input.Name)) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
        return { Parameter: { Value: parameters.get(input.Name) } };
      }
      const connection = { host: "database.example.com", port: "5432", username: "provisioner", password: "master-secret" };
      return { Parameters: input.Names.flatMap((Name) => {
        const value = parameters.get(Name) ?? (Name.includes("/databases/") ? undefined : connection[Name.split("/").pop()]);
        return value === undefined ? [] : [{ Name, Value: value }];
      }) };
    }
  }
  class Client {
    constructor(options) { this.database = options.database; }
    async connect() {}
    async end() {}
    async query(sql, args) {
      statements.push({ database: this.database, sql });
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired }] };
      if (sql.includes("pg_get_userbyid")) return { rows: databases.has(args[0]) ? [{ owner: databases.get(args[0]) }] : [] };
      if (sql.includes("FROM pg_roles")) return { rows: roles.has(args[0]) ? [{}] : [] };
      if (sql.startsWith("CREATE ROLE")) roles.add(sql.match(/CREATE ROLE "([^"]+)"/)[1]);
      if (sql.startsWith("CREATE DATABASE")) {
        const match = sql.match(/CREATE DATABASE "([^"]+)" OWNER "([^"]+)"/);
        databases.set(match[1], match[2]);
      }
      if (sql.startsWith("SELECT shobj_description")) return { rows: [{ description: "Saved description" }] };
      if (sql.includes("SELECT datname")) return { rows: [...databases.keys()].map((name) => ({ name, description: null })) };
      return { rows: [] };
    }
  }
  const api = load("../lib/databases.ts", {
    "node:fs/promises": { readFile: async () => "test CA" },
    "@aws-sdk/client-ssm": { GetParameterCommand, GetParametersCommand, PutParameterCommand, SSMClient },
    "pg": { Client }, "@/lib/aws": { awsClientOptions: () => ({}) }, "@/lib/database-types": types,
  }, { process: { env: { POSTGRESQL_SSM_PARAMETER_PREFIX: "/test/postgresql", POSTGRESQL_CA_BUNDLE_PATH: "/test/ca" } } });
  return { ...api, parameters, databases, statements, failNextWrite: (suffix) => { failSuffix = suffix; }, lockBusy: () => { acquired = false; } };
}

test("provisioning creates independent credentials, grants row access, and never returns secrets", async () => {
  const harness = provisioningHarness();
  const result = await harness.createDatabase("my_app", "Description");
  const path = "/test/postgresql/databases/my_app";
  const owner = JSON.parse(harness.parameters.get(`${path}/owner`));
  const app = JSON.parse(harness.parameters.get(`${path}/app`));
  assert.notEqual(new URL(owner.url).password, new URL(app.url).password);
  assert.match(new URL(owner.url).username, /_owner$/);
  assert.match(new URL(app.url).username, /_app$/);
  assert.equal(harness.parameters.get(`${path}/status`), "ready");
  assert.equal(result.database.managed, true);
  assert.doesNotMatch(JSON.stringify(result), /password|postgresql:|master-secret/);
  const sql = harness.statements.map((entry) => entry.sql).join("\n");
  assert.match(sql, /REVOKE ALL ON DATABASE "my_app" FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON SCHEMA public FROM PUBLIC/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES .* GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES/);
  assert.match(sql, /GRANT USAGE ON SEQUENCES/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.doesNotMatch(sql, /GRANT ALL|GRANT CREATE|GRANT TRUNCATE/);
});

test("interrupted creation resumes with the same passwords and no duplicate database", async () => {
  const harness = provisioningHarness();
  harness.failNextWrite("/owner");
  await assert.rejects(harness.createDatabase("my_app", "Description"), /simulated/);
  const path = "/test/postgresql/databases/my_app";
  const staged = harness.parameters.get(`${path}/provisioning`);
  const app = harness.parameters.get(`${path}/app`);
  assert.equal(harness.parameters.get(`${path}/status`), "provisioning");
  assert.equal((await harness.listDatabases())[0].managed, false);
  await harness.createDatabase("my_app", "Description");
  assert.equal(harness.parameters.get(`${path}/provisioning`), staged);
  assert.equal(harness.parameters.get(`${path}/app`), app);
  assert.equal(harness.statements.filter((entry) => entry.sql.startsWith("CREATE DATABASE")).length, 1);
  assert.equal((await harness.listDatabases())[0].managed, true);
  await harness.createDatabase("my_app", "Description");
  assert.equal(harness.statements.filter((entry) => entry.sql.startsWith("CREATE ROLE")).length, 2);
});

test("unmanaged databases and concurrent provisioning cannot be adopted", async () => {
  const harness = provisioningHarness();
  harness.databases.set("existing", "unrelated_owner");
  await assert.rejects(harness.createDatabase("existing", ""), /not managed/);
  assert.equal(harness.parameters.size, 0);
  assert.equal((await harness.listDatabases())[0].managed, false);
  harness.lockBusy();
  await assert.rejects(harness.createDatabase("my_app", ""), /being configured/);
  assert.equal(harness.parameters.size, 0);
});

test("listing databases never creates a database and disables caching", async () => {
  const route = api();
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).databases[0].name, "existing_app");
  assert.equal(route.creations.length, 0);
});

test("invalid and reserved names cannot reach database creation", async () => {
  const route = api();
  for (const name of ["", "postgres", "rdsadmin", "template0", "pg_internal", 'app"; DROP DATABASE postgres; --', "A", "a".repeat(64)]) {
    assert.equal((await route.POST(request({ name }))).status, 400, name);
  }
  for (const description of ["a".repeat(351), "null\0byte", 123]) {
    assert.equal((await route.POST(request({ name: "my_app", description }))).status, 400);
  }
  assert.equal(route.creations.length, 0);
});

test("creation accepts an optional description and normalizes surrounding spaces", async () => {
  const route = api();
  assert.equal((await route.POST(request({ name: " my_app " }))).status, 201);
  assert.deepEqual(route.creations, [{ name: "my_app", description: "" }]);
});

test("duplicate database creation returns a conflict", async () => {
  const route = api({ createDatabase: async () => { throw { code: "42P04" }; } });
  assert.equal((await route.POST(request({ name: "my_app" }))).status, 409);
});

test("database connection failures do not expose credentials", async () => {
  const route = api({ listDatabases: async () => { throw new Error("secret-password"); } });
  const response = await route.GET();
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret-password/);
});

test("table API validates selectors, paginates, and masks connection secrets", async () => {
  const calls = [];
  const route = load("../app/api/databases/[database]/tables/route.ts", {
    "@/lib/databases": {
      DatabaseBrowseNotFoundError: class extends Error {}, DatabaseConfigurationError: class extends Error {},
      listDatabaseTables: async () => { throw new Error("secret-password"); },
      readDatabaseTable: async (...args) => { calls.push(args); return { rows: [], page: args[3], hasMore: false }; },
    },
  }, { URL });
  const context = { params: Promise.resolve({ database: "app" }) };
  for (const query of ["?schema=public", "?table=records", "?schema=public&table=records&page=0", "?page=NaN", "?schema=public&table=%00"]) {
    assert.equal((await route.GET(new Request(`http://localhost/api/databases/app/tables${query}`), context)).status, 400);
  }
  assert.equal(calls.length, 0);
  const page = await route.GET(new Request("http://localhost/api/databases/app/tables?schema=custom&table=records&page=2"), context);
  assert.equal(page.status, 200);
  assert.equal((await page.json()).page, 2);
  assert.deepEqual(calls, [["app", "custom", "records", 2]]);
  const response = await route.GET(new Request("http://localhost/api/databases/app/tables"), context);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.doesNotMatch(await response.text(), /secret-password/);
});
