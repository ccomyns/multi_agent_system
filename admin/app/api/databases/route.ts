import { NextResponse } from "next/server";
import { createDatabase, DatabaseConfigurationError, DatabaseConflictError, listDatabases } from "@/lib/databases";
import { databaseNameError, DATABASE_DESCRIPTION_MAX_LENGTH } from "@/lib/database-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

function failure(error: unknown) {
  if (error instanceof DatabaseConflictError) return json({ error: error.message }, 409);
  if (error instanceof DatabaseConfigurationError) return json({ error: error.message }, 503);
  if (typeof error === "object" && error !== null && "code" in error && error.code === "42P04") {
    return json({ error: "A database with that name already exists." }, 409);
  }
  return json({ error: "The database request failed. Check RDS connectivity and SSM permissions. If creation was interrupted, submit the same name again to resume setup." }, 502);
}

export async function GET() {
  try { return json({ databases: await listDatabases() }); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  let input;
  try { input = await request.json(); }
  catch { return json({ error: "The database request must contain valid JSON." }, 400); }
  if (!input || typeof input.name !== "string" || (input.description !== undefined && typeof input.description !== "string")) {
    return json({ error: "Provide a database name and an optional description." }, 400);
  }
  const name = input.name.trim();
  const description = (input.description ?? "").trim();
  const invalid = databaseNameError(name);
  if (invalid) return json({ error: invalid }, 400);
  if (description.length > DATABASE_DESCRIPTION_MAX_LENGTH || description.includes("\0")) return json({ error: "The description must be 350 characters or fewer and contain no null characters." }, 400);
  try { return json(await createDatabase(name, description), 201); }
  catch (error) { return failure(error); }
}
