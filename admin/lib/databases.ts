import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GetParameterCommand, GetParametersCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Client } from "pg";
import { awsClientOptions } from "@/lib/aws";
import { databaseNameError, type DatabaseSummary } from "@/lib/database-types";

export class DatabaseConfigurationError extends Error {}
export class DatabaseConflictError extends Error {}
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: string) => "E'" + value.replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";

// Only the trusted admin server reads the instance-level provisioning credential.
async function withProvisioner<T>(action: (client: Client, ssm: SSMClient, prefix: string, connect: (database: string) => Client, host: string, port: number) => Promise<T>) {
  const prefix = process.env.POSTGRESQL_SSM_PARAMETER_PREFIX?.replace(/\/$/, "");
  const caPath = process.env.POSTGRESQL_CA_BUNDLE_PATH;
  if (!prefix || !caPath) throw new DatabaseConfigurationError("Configure POSTGRESQL_SSM_PARAMETER_PREFIX and POSTGRESQL_CA_BUNDLE_PATH on the admin server.");
  const ssm = new SSMClient(awsClientOptions());
  let client: Client | undefined;
  try {
    const fields = ["host", "port", "username", "password"];
    const parameters = await ssm.send(new GetParametersCommand({ Names: fields.map((field) => `${prefix}/${field}`), WithDecryption: true }));
    const values = Object.fromEntries((parameters.Parameters ?? []).map((item) => [item.Name?.split("/").pop(), item.Value]));
    if (fields.some((field) => !values[field])) throw new DatabaseConfigurationError("Required PostgreSQL connection parameters are missing.");
    const ssl = { ca: await readFile(caPath, "utf8"), rejectUnauthorized: true };
    const connect = (database: string) => new Client({ host: values.host, port: Number(values.port), user: values.username, password: values.password, database, ssl, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
    client = connect("postgres");
    await client.connect();
    return await action(client, ssm, `${prefix}/databases`, connect, values.host!, Number(values.port));
  } finally {
    await client?.end();
    ssm.destroy();
  }
}

async function readParameter(ssm: SSMClient, name: string) {
  try { return (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value; }
  catch (error) {
    if (error instanceof Error && error.name === "ParameterNotFound") return undefined;
    throw error;
  }
}

export function listDatabases() {
  return withProvisioner(async (client, ssm, prefix) => {
    const result = await client.query<DatabaseSummary>(`
      SELECT datname AS name, shobj_description(oid, 'pg_database') AS description
      FROM pg_database WHERE NOT datistemplate AND datallowconn
        AND datname <> 'rdsadmin' AND has_database_privilege(datname, 'CONNECT') ORDER BY datname
    `);
    const databases = result.rows.map((database) => ({ ...database, managed: false }));
    const eligible = databases.filter((database) => !databaseNameError(database.name));
    for (let offset = 0; offset < eligible.length; offset += 10) {
      const chunk = eligible.slice(offset, offset + 10);
      const statuses = await ssm.send(new GetParametersCommand({ Names: chunk.map((database) => `${prefix}/${database.name}/status`) }));
      const ready = new Set((statuses.Parameters ?? []).filter((item) => item.Value === "ready").map((item) => item.Name));
      for (const database of chunk) database.managed = ready.has(`${prefix}/${database.name}/status`);
    }
    return databases;
  });
}

interface Provisioning {
  owner: string;
  app: string;
  ownerPassword: string;
  appPassword: string;
}

export function createDatabase(name: string, description: string) {
  const invalid = databaseNameError(name);
  if (invalid) throw new DatabaseConfigurationError(invalid);
  return withProvisioner(async (client, ssm, prefix, connect, host, port) => {
    // Session locks serialize retries across admin processes. Closing the
    // connection releases the lock even after a failed provisioning attempt.
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [`managed-database:${name}`]);
    if (!lock.rows[0].acquired) throw new DatabaseConflictError("This database is being configured. Try again shortly.");
    const path = `${prefix}/${name}`;
    const existing = await client.query("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1", [name]);
    const stored = await readParameter(ssm, `${path}/provisioning`);
    if (!stored && existing.rows.length) throw new DatabaseConflictError("A database with that name already exists and is not managed by this workflow.");
    let state: Provisioning;
    if (stored) {
      state = JSON.parse(stored);
      if (!/^db_[a-f0-9]{24}_owner$/.test(state.owner) || !/^db_[a-f0-9]{24}_app$/.test(state.app) || typeof state.ownerPassword !== "string" || typeof state.appPassword !== "string") throw new DatabaseConfigurationError("Invalid database provisioning record.");
    } else {
      const id = randomBytes(12).toString("hex");
      state = { owner: `db_${id}_owner`, app: `db_${id}_app`, ownerPassword: randomBytes(32).toString("base64url"), appPassword: randomBytes(32).toString("base64url") };
      await ssm.send(new PutParameterCommand({ Name: `${path}/provisioning`, Type: "SecureString", Value: JSON.stringify(state), Overwrite: false }));
    }
    if (existing.rows.length && existing.rows[0].owner !== state.owner) throw new DatabaseConflictError("The database owner does not match its provisioning record.");
    const put = (suffix: string, value: string, secret = true) => ssm.send(new PutParameterCommand({ Name: `${path}/${suffix}`, Type: secret ? "SecureString" : "String", Value: value, Overwrite: true }));
    if (existing.rows.length && await readParameter(ssm, `${path}/status`) === "ready") {
      const result = await client.query("SELECT shobj_description(oid, 'pg_database') AS description FROM pg_database WHERE datname = $1", [name]);
      return { database: { name, description: result.rows[0].description, managed: true } };
    }
    await put("status", "provisioning", false);
    const owner = identifier(state.owner);
    const app = identifier(state.app);
    const database = identifier(name);
    for (const [role, password] of [[state.owner, state.ownerPassword], [state.app, state.appPassword]]) {
      const found = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (!found.rows.length) await client.query(`CREATE ROLE ${identifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`);
    }
    // The provisioner can SET ROLE for ownership/default privileges. The owner
    // receives no membership in other database roles or the master role.
    await client.query(`GRANT ${owner} TO CURRENT_USER`);
    if (!existing.rows.length) await client.query(`CREATE DATABASE ${database} OWNER ${owner}`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${app}`);
    await client.query(`COMMENT ON DATABASE ${database} IS ${literal(description)}`);
    const scoped = connect(name);
    try {
      await scoped.connect();
      await scoped.query("BEGIN");
      await scoped.query(`SET LOCAL ROLE ${owner}`);
      await scoped.query(`ALTER SCHEMA public OWNER TO ${owner}`);
      await scoped.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await scoped.query(`GRANT USAGE ON SCHEMA public TO ${app}`);
      await scoped.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app}`);
      await scoped.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${app}`);
      await scoped.query("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC");
      await scoped.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`);
      await scoped.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE ON SEQUENCES TO ${app}`);
      await scoped.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
      await scoped.query("COMMIT");
    } finally { await scoped.end(); }
    for (const role of [owner, app]) await client.query(`ALTER ROLE ${role} LOGIN`);
    const credential = (username: string, password: string) => JSON.stringify({ database_name: name, url: `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(name)}?sslmode=require` });
    await put("app", credential(state.app, state.appPassword));
    await put("owner", credential(state.owner, state.ownerPassword));
    await put("status", "ready", false);
    return { database: { name, description: description || null, managed: true } };
  });
}

export class DatabaseBrowseNotFoundError extends Error {}

// Browsing uses the trusted server credential, never the agent's credentials.
// Restrict each connection to read-only queries and check the database catalog
// rather than applying the narrower rules used when creating managed databases.
async function withDatabaseReader<T>(name: string, action: (client: Client) => Promise<T>) {
  return withProvisioner(async (provisioner, _ssm, _prefix, connect) => {
    const found = await provisioner.query(`SELECT 1 FROM pg_database
      WHERE datname = $1 AND NOT datistemplate AND datallowconn
      AND datname <> 'rdsadmin' AND has_database_privilege(datname, 'CONNECT')`, [name]);
    if (!found.rows.length) throw new DatabaseBrowseNotFoundError("Database not found or unavailable.");
    const client = connect(name);
    try {
      await client.connect();
      await client.query("BEGIN READ ONLY");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } finally {
      await client.end();
    }
  });
}

export function listDatabaseTables(database: string) {
  return withDatabaseReader(database, async (client) => {
    const result = await client.query<import("@/lib/database-types").DatabaseTableSummary>(`
      SELECT n.nspname AS schema, c.relname AS name,
        GREATEST(c.reltuples, 0)::float8 AS "estimatedRows"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')
      ORDER BY n.nspname, c.relname`);
    return result.rows;
  });
}

export function readDatabaseTable(database: string, schema: string, table: string, page: number) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new DatabaseConfigurationError("Invalid table page.");
  return withDatabaseReader(database, async (client): Promise<import("@/lib/database-types").DatabaseTablePage> => {
    const relation = await client.query<{ oid: number }>(`
      SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')`, [schema, table]);
    if (!relation.rows.length) throw new DatabaseBrowseNotFoundError("Table not found or unavailable.");
    const oid = relation.rows[0].oid;
    const columns = await client.query<{ name: string; dataType: string; nullable: boolean }>(`
      SELECT attname AS name, format_type(atttypid, atttypmod) AS "dataType", NOT attnotnull AS nullable
      FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [oid]);
    const keys = await client.query<{ name: string }>(`
      SELECT a.attname AS name FROM pg_index i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, position)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = $1 AND i.indisprimary AND k.position <= i.indnkeyatts ORDER BY k.position`, [oid]);
    const pageSize = 100;
    const order = keys.rows.length ? keys.rows.map((key) => identifier(key.name)).join(", ") : "tableoid, ctid";
    // Text casts preserve bigint/numeric precision and represent JSON, arrays,
    // timestamps and other PostgreSQL values without lossy JS conversions.
    const projection = columns.rows.map((column) => `${identifier(column.name)}::text AS ${identifier(column.name)}`).join(", ");
    const result = await client.query<Record<string, string | null>>(
      `SELECT ${projection || '*'} FROM ${identifier(schema)}.${identifier(table)} ORDER BY ${order} LIMIT $1 OFFSET $2`,
      [pageSize + 1, (page - 1) * pageSize],
    );
    return { columns: columns.rows, rows: result.rows.slice(0, pageSize), page, pageSize, hasMore: result.rows.length > pageSize };
  });
}
