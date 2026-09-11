export interface DatabaseSummary {
  name: string;
  description: string | null;
  managed: boolean;
}

export const DATABASE_DESCRIPTION_MAX_LENGTH = 350;

export function databaseNameError(name: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    return "Use 1–63 lowercase letters, numbers, or underscores, starting with a letter.";
  }
  if (name === "postgres" || name.startsWith("pg_") || name.startsWith("rds") || name.startsWith("template")) {
    return "Choose a name that is not reserved for a system database.";
  }
  return null;
}

export function isDatabaseSummary(value: unknown): value is DatabaseSummary {
  return typeof value === "object" && value !== null &&
    "name" in value && typeof value.name === "string" &&
    "managed" in value && typeof value.managed === "boolean" &&
    "description" in value && (value.description === null || typeof value.description === "string");
}

export interface DatabaseTableSummary {
  schema: string;
  name: string;
  estimatedRows: number;
}

export interface DatabaseTablePage {
  columns: Array<{ name: string; dataType: string; nullable: boolean }>;
  rows: Array<Record<string, string | null>>;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
