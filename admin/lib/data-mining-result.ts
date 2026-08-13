export const DATA_MINING_RESULT_KIND = "data_mining_result";
export const DATA_MINING_RESULT_SCHEMA_VERSION = 1;

export type DataMiningColumnType = "text" | "number" | "boolean" | "date" | "url";
export type DataMiningCell = string | number | boolean | null;

export type DataMiningColumn = {
  key: string;
  label: string;
  type: DataMiningColumnType;
  nullable: boolean;
  hidden: boolean;
};

export type DataMiningTable = {
  id: string;
  name: string;
  primary_key: string;
  columns: DataMiningColumn[];
  rows: Array<Record<string, DataMiningCell>>;
};

export type DataMiningRelationship = {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
};

export type DataMiningResult = {
  kind: typeof DATA_MINING_RESULT_KIND;
  schema_version: typeof DATA_MINING_RESULT_SCHEMA_VERSION;
  tables: DataMiningTable[];
  relationships: DataMiningRelationship[];
};

export type FinalResultResponse =
  | { view: "database"; result: DataMiningResult }
  | { view: "json"; result: unknown; schemaError: string };

export type DataMiningResultValidation =
  | { valid: true; result: DataMiningResult }
  | { valid: false; error: string };

const COLUMN_TYPES: DataMiningColumnType[] = ["text", "number", "boolean", "date", "url"];
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
const DATE_PATTERN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonemptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(record: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validDate(value: string) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : null;
  const day = match[3] ? Number(match[3]) : null;
  if (month === null) return year >= 1;
  if (month < 1 || month > 12) return false;
  if (day === null) return true;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function validUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function validCell(value: unknown, column: DataMiningColumn) {
  if (value === null) return column.nullable;
  switch (column.type) {
    case "text":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && validDate(value);
    case "url":
      return typeof value === "string" && validUrl(value);
  }
}

function keyToken(value: DataMiningCell) {
  return `${typeof value}:${String(value)}`;
}

export function validateDataMiningResult(value: unknown): DataMiningResultValidation {
  const root = recordValue(value);
  if (!root) return { valid: false, error: "The result is not a database-result object." };
  if (!exactKeys(root, ["kind", "relationships", "schema_version", "tables"])) {
    return { valid: false, error: "The database-result envelope has an invalid shape." };
  }
  if (root.kind !== DATA_MINING_RESULT_KIND || root.schema_version !== DATA_MINING_RESULT_SCHEMA_VERSION) {
    return { valid: false, error: "The result does not use data-mining result schema version 1." };
  }
  if (!Array.isArray(root.tables) || root.tables.length < 1 || root.tables.length > 2) {
    return { valid: false, error: "A database result must contain one or two tables." };
  }
  if (!Array.isArray(root.relationships)) {
    return { valid: false, error: "The database result has no relationships array." };
  }

  const tables: DataMiningTable[] = [];
  const tableIds = new Set<string>();
  for (const [tableIndex, candidate] of root.tables.entries()) {
    const table = recordValue(candidate);
    const location = `Table ${tableIndex + 1}`;
    if (!table) return { valid: false, error: `${location} is not an object.` };
    if (!exactKeys(table, ["columns", "id", "name", "primary_key", "rows"])) {
      return { valid: false, error: `${location} has an invalid shape.` };
    }
    if (!nonemptyString(table.id) || !IDENTIFIER_PATTERN.test(table.id as string)) {
      return { valid: false, error: `${location} has an invalid id.` };
    }
    if (tableIds.has(table.id as string)) {
      return { valid: false, error: `Table id ${(table.id as string)} is duplicated.` };
    }
    tableIds.add(table.id as string);
    if (!nonemptyString(table.name)) return { valid: false, error: `${location} has no name.` };
    if (!nonemptyString(table.primary_key)) {
      return { valid: false, error: `${location} has no primary key.` };
    }
    if (!Array.isArray(table.columns) || table.columns.length === 0) {
      return { valid: false, error: `${location} has no columns.` };
    }
    if (!Array.isArray(table.rows)) return { valid: false, error: `${location} has no rows array.` };

    const columns: DataMiningColumn[] = [];
    const columnKeys = new Set<string>();
    for (const [columnIndex, columnCandidate] of table.columns.entries()) {
      const column = recordValue(columnCandidate);
      const columnLocation = `${location}, column ${columnIndex + 1}`;
      if (!column) return { valid: false, error: `${columnLocation} is not an object.` };
      if (!exactKeys(column, ["hidden", "key", "label", "nullable", "type"])) {
        return { valid: false, error: `${columnLocation} has an invalid shape.` };
      }
      if (!nonemptyString(column.key) || !IDENTIFIER_PATTERN.test(column.key as string)) {
        return { valid: false, error: `${columnLocation} has an invalid key.` };
      }
      if (columnKeys.has(column.key as string)) {
        return { valid: false, error: `${location} has duplicate column ${(column.key as string)}.` };
      }
      columnKeys.add(column.key as string);
      if (!nonemptyString(column.label)) {
        return { valid: false, error: `${columnLocation} has no label.` };
      }
      if (!COLUMN_TYPES.includes(column.type as DataMiningColumnType)) {
        return { valid: false, error: `${columnLocation} has an unsupported type.` };
      }
      if (typeof column.nullable !== "boolean" || typeof column.hidden !== "boolean") {
        return { valid: false, error: `${columnLocation} has invalid display metadata.` };
      }
      columns.push({
        key: column.key as string,
        label: column.label as string,
        type: column.type as DataMiningColumnType,
        nullable: column.nullable as boolean,
        hidden: column.hidden as boolean,
      });
    }

    if (!columnKeys.has(table.primary_key as string)) {
      return { valid: false, error: `${location}'s primary key is not a declared column.` };
    }
    if (!columns.some((column) => !column.hidden)) {
      return { valid: false, error: `${location} has no visible columns.` };
    }
    const primaryColumn = columns.find((column) => column.key === table.primary_key);
    if (!primaryColumn || primaryColumn.nullable) {
      return { valid: false, error: `${location}'s primary key must be non-nullable.` };
    }

    const expectedRowKeys = [...columnKeys].sort();
    const primaryValues = new Set<string>();
    const rows: Array<Record<string, DataMiningCell>> = [];
    for (const [rowIndex, rowCandidate] of table.rows.entries()) {
      const row = recordValue(rowCandidate);
      const rowLocation = `${location}, row ${rowIndex + 1}`;
      if (!row || !exactKeys(row, expectedRowKeys)) {
        return { valid: false, error: `${rowLocation} does not exactly match the declared columns.` };
      }
      for (const column of columns) {
        if (!validCell(row[column.key], column)) {
          return { valid: false, error: `${rowLocation} has an invalid ${column.label} value.` };
        }
      }
      const primaryValue = row[table.primary_key as string] as DataMiningCell;
      const token = keyToken(primaryValue);
      if (primaryValues.has(token)) {
        return { valid: false, error: `${location} has a duplicate primary-key value.` };
      }
      primaryValues.add(token);
      rows.push(row as Record<string, DataMiningCell>);
    }

    tables.push({
      id: table.id as string,
      name: table.name as string,
      primary_key: table.primary_key as string,
      columns,
      rows,
    });
  }

  if ((tables.length === 1 && root.relationships.length !== 0) ||
      (tables.length === 2 && root.relationships.length === 0)) {
    return { valid: false, error: "Relationships must be empty for one table and present for two tables." };
  }

  const tableById = new Map(tables.map((table) => [table.id, table]));
  const relationships: DataMiningRelationship[] = [];
  for (const [index, candidate] of root.relationships.entries()) {
    const relationship = recordValue(candidate);
    if (!relationship || !exactKeys(relationship, ["from_column", "from_table", "to_column", "to_table"])) {
      return { valid: false, error: `Relationship ${index + 1} has an invalid shape.` };
    }
    const fromTable = tableById.get(String(relationship.from_table));
    const toTable = tableById.get(String(relationship.to_table));
    if (!fromTable || !toTable || fromTable.id === toTable.id) {
      return { valid: false, error: `Relationship ${index + 1} does not connect the two result tables.` };
    }
    const fromColumn = fromTable.columns.find((column) => column.key === relationship.from_column);
    const toColumn = toTable.columns.find((column) => column.key === relationship.to_column);
    if (!fromColumn || !toColumn || toColumn.key !== toTable.primary_key || fromColumn.type !== toColumn.type) {
      return { valid: false, error: `Relationship ${index + 1} does not reference compatible key columns.` };
    }
    const targetValues = new Set(toTable.rows.map((row) => keyToken(row[toColumn.key])));
    if (fromTable.rows.some((row) => row[fromColumn.key] !== null && !targetValues.has(keyToken(row[fromColumn.key])))) {
      return { valid: false, error: `Relationship ${index + 1} contains an orphaned foreign key.` };
    }
    relationships.push({
      from_table: relationship.from_table as string,
      from_column: relationship.from_column as string,
      to_table: relationship.to_table as string,
      to_column: relationship.to_column as string,
    });
  }

  return {
    valid: true,
    result: {
      kind: DATA_MINING_RESULT_KIND,
      schema_version: DATA_MINING_RESULT_SCHEMA_VERSION,
      tables,
      relationships,
    },
  };
}

export function isFinalResultResponse(value: unknown): value is FinalResultResponse {
  const response = recordValue(value);
  if (!response) return false;
  if (response.view === "database") return validateDataMiningResult(response.result).valid;
  return response.view === "json" && "result" in response && typeof response.schemaError === "string";
}
