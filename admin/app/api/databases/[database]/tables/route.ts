import { NextResponse } from "next/server";
import { DatabaseBrowseNotFoundError, DatabaseConfigurationError, listDatabaseTables, readDatabaseTable } from "@/lib/databases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request, context: { params: Promise<{ database: string }> }) {
  const { database } = await context.params;
  const query = new URL(request.url).searchParams;
  const schema = query.get("schema");
  const table = query.get("table");
  const rawPage = query.get("page") ?? "1";
  if (!database || database.includes("\0") || (schema === null) !== (table === null) ||
      (table !== null && (!table || !schema || table.includes("\0") || schema.includes("\0"))) ||
      !/^[1-9]\d{0,6}$/.test(rawPage) || Number(rawPage) > 1000000) {
    return json({ error: "Provide a valid database, schema, table, and page." }, 400);
  }
  try {
    if (table !== null && schema !== null) return json(await readDatabaseTable(database, schema, table, Number(rawPage)));
    return json({ tables: await listDatabaseTables(database) });
  } catch (error) {
    if (error instanceof DatabaseBrowseNotFoundError) return json({ error: error.message }, 404);
    if (error instanceof DatabaseConfigurationError) return json({ error: error.message }, 503);
    return json({ error: "Unable to read this database. Check RDS connectivity and database read permissions." }, 502);
  }
}
