export type Scalar = string | number | boolean | null;
export type WAEFormat = "JSON" | "JSONEachRow" | "TabSeparated";
export type OrderDirection = "ASC" | "DESC";
export type IntervalUnit =
  "SECOND" | "MINUTE" | "HOUR" | "DAY" | "MONTH" | "YEAR";

export const WAE_BASE_COLUMNS = {
  dataset: "dataset",
  timestamp: "timestamp",
  sampleInterval: "_sample_interval",
} as const;

export const WAE_INDEX_COLUMNS = {
  index: "index1",
} as const;

export const WAE_BLOB_COLUMNS = {
  blob1: "blob1",
  blob2: "blob2",
  blob3: "blob3",
  blob4: "blob4",
  blob5: "blob5",
  blob6: "blob6",
  blob7: "blob7",
  blob8: "blob8",
  blob9: "blob9",
  blob10: "blob10",
  blob11: "blob11",
  blob12: "blob12",
  blob13: "blob13",
  blob14: "blob14",
  blob15: "blob15",
  blob16: "blob16",
  blob17: "blob17",
  blob18: "blob18",
  blob19: "blob19",
  blob20: "blob20",
} as const;

export const WAE_DOUBLE_COLUMNS = {
  double1: "double1",
  double2: "double2",
  double3: "double3",
  double4: "double4",
  double5: "double5",
  double6: "double6",
  double7: "double7",
  double8: "double8",
  double9: "double9",
  double10: "double10",
  double11: "double11",
  double12: "double12",
  double13: "double13",
  double14: "double14",
  double15: "double15",
  double16: "double16",
  double17: "double17",
  double18: "double18",
  double19: "double19",
  double20: "double20",
} as const;

type ValueOf<T> = T[keyof T];

export type WAEBaseColumnName = ValueOf<typeof WAE_BASE_COLUMNS>;
export type WAEIndexColumnName = ValueOf<typeof WAE_INDEX_COLUMNS>;
export type WAEBlobColumnName = ValueOf<typeof WAE_BLOB_COLUMNS>;
export type WAEDoubleColumnName = ValueOf<typeof WAE_DOUBLE_COLUMNS>;
export type WAEColumnName =
  | WAEBaseColumnName
  | WAEIndexColumnName
  | WAEBlobColumnName
  | WAEDoubleColumnName;
export type WAEDataPointValue = string | ArrayBuffer | null;

const WAE_FORMATS = new Set<WAEFormat>(["JSON", "JSONEachRow", "TabSeparated"]);
const ORDER_DIRECTIONS = new Set<OrderDirection>(["ASC", "DESC"]);
const INTERVAL_UNITS = new Set<IntervalUnit>([
  "SECOND",
  "MINUTE",
  "HOUR",
  "DAY",
  "MONTH",
  "YEAR",
]);

export type SQLNode<T = unknown> = {
  readonly sql: string;
  readonly __type?: T;
};

export type Expr<T = unknown> = SQLNode<T>;

export type Column<
  T = unknown,
  SQLName extends string = string,
> = SQLNode<T> & {
  readonly kind: "column";
  readonly name: SQLName;
};

export type Selectable = Column | Expr;
type ValueExpr = Selectable | Scalar;

/** Expected application values, not validated HTTP response values. */
export type SelectedRow<Fields extends Record<string, Selectable>> = {
  [Key in keyof Fields as Key extends string | number ? Key : never]:
    Fields[Key] extends SQLNode<infer Value> ? Value : unknown;
};

/** Optional extraction; executors can infer Row directly from Query<Row>. */
export type InferRow<Q extends Query<unknown>> = Q["$inferRow"];

export type SampledHelpers = {
  count(): Expr<number>;
  sum(value: Selectable): Expr<number>;
  avg(value: Selectable): Expr<number>;
  quantile(quantile: number, value: Selectable): Expr<number>;
};

type DatasetColumns<T extends Record<string, string>> = {
  readonly [K in keyof T]: Column<unknown, T[K]>;
};

export type Dataset<T extends Record<string, string>> = {
  readonly table: string;
  select<TFields extends Record<string, Selectable>>(
    fields: TFields,
  ): Query<SelectedRow<TFields>>;
  where(expression: Expr<boolean> | Expr): Query<unknown>;
} & DatasetColumns<T>;

type WAEFieldNames = readonly string[];

export type WAEDatasetDefinition<
  TBlobs extends WAEFieldNames,
  TDoubles extends WAEFieldNames,
  TIndexes extends WAEFieldNames,
> = {
  name: string;
  blobs?: TBlobs;
  doubles?: TDoubles;
  indexes?: TIndexes;
};

type ColumnsForNames<
  T extends readonly string[],
  TColumnName extends string,
  Value,
> = {
  [K in T[number]]: Column<Value, TColumnName>;
};

export type DefinedDataset<
  TBlobs extends WAEFieldNames,
  TDoubles extends WAEFieldNames,
  TIndexes extends WAEFieldNames,
> = {
  readonly name: string;
  readonly fields: {
    readonly blobs: TBlobs;
    readonly doubles: TDoubles;
    readonly indexes: TIndexes;
  };
  readonly dataset: Column<string, "dataset">;
  readonly timestamp: Column<Date, "timestamp">;
  readonly sampleInterval: Column<number, "_sample_interval">;
  readonly sampled: SampledHelpers;
  readonly blobs: ColumnsForNames<TBlobs, WAEBlobColumnName, string>;
  readonly doubles: ColumnsForNames<TDoubles, WAEDoubleColumnName, number>;
  readonly indexes: ColumnsForNames<TIndexes, WAEIndexColumnName, string>;
  select<TFields extends Record<string, Selectable>>(
    fields: TFields,
  ): Query<SelectedRow<TFields>>;
  where(expression: Expr<boolean> | Expr): Query<unknown>;
  dataPoint(values: {
    blobs: { [K in TBlobs[number]]: WAEDataPointValue };
    doubles: { [K in TDoubles[number]]: number };
    indexes: { [K in TIndexes[number]]: WAEDataPointValue };
  }): {
    blobs: WAEDataPointValue[];
    doubles: number[];
    indexes: WAEDataPointValue[];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeDateTime(value: unknown, name: string): Date {
  // Unzoned SQL timestamps are interpreted as UTC, never host-local time.
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?$/.test(value)) {
    throw new Error(`Invalid DateTime value for column: ${name}`);
  }
  const normalized = value.replace(" ", "T").replace(/Z$/, "");
  const [seconds, fraction = ""] = normalized.split(".");
  const iso = `${seconds}.${fraction.padEnd(3, "0")}Z`;
  const date = new Date(iso);
  // Reject calendar overflow (for example February 30), not just Invalid Date.
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) {
    throw new Error(`Invalid DateTime value for column: ${name}`);
  }
  return date;
}

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSQLNode(value: unknown): value is SQLNode {
  return typeof value === "object" && value !== null && "sql" in value;
}

function safeIdent(value: string) {
  if (!IDENTIFIER_REGEX.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }

  return value;
}

function safeInt(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value;
}

function safeOrderDirection(value: OrderDirection) {
  if (!ORDER_DIRECTIONS.has(value)) {
    throw new Error(`Invalid order direction: ${value}`);
  }

  return value;
}

function safeFormat(value: WAEFormat) {
  if (!WAE_FORMATS.has(value)) {
    throw new Error(`Invalid WAE format: ${value}`);
  }

  return value;
}

function safeIntervalUnit(value: IntervalUnit) {
  if (!INTERVAL_UNITS.has(value)) {
    throw new Error(`Invalid interval unit: ${value}`);
  }

  return value;
}

function validateFieldNames(kind: string, names: readonly string[]) {
  const seen = new Set<string>();

  for (const name of names) {
    safeIdent(name);
    if (seen.has(name)) {
      throw new Error(`Duplicate ${kind} field: ${name}`);
    }
    seen.add(name);
  }
}

function toSlot(columnName: string, prefix: "blob" | "double" | "index") {
  const slot = Number(columnName.slice(prefix.length));
  const maxSlot = prefix === "index" ? 1 : 20;
  if (!Number.isInteger(slot) || slot < 1 || slot > maxSlot) {
    throw new Error(`Invalid ${prefix} column: ${columnName}`);
  }

  return slot - 1;
}

function sqlOf(value: Selectable): string {
  return value.sql;
}

function sqlExpr<T = unknown>(sql: string): Expr<T> {
  return { sql };
}

export function wae<T = unknown>(
  strings: TemplateStringsArray,
  ...values: Array<Selectable | Scalar>
): Expr<T> {
  let out = strings[0] ?? "";

  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    out += isSQLNode(value) ? value.sql : lit(value);
    out += strings[i + 1] ?? "";
  }

  return sqlExpr<T>(out);
}

export namespace wae {
  export function raw(sql: string): Expr {
    return sqlExpr(sql);
  }
}

/**
 * @deprecated Use `wae.raw(sql)` instead.
 */
export function unsafeRaw(sql: string): Expr {
  return wae.raw(sql);
}

export function col<T = unknown, SQLName extends string = string>(
  sqlName: SQLName,
): Column<T, SQLName> {
  safeIdent(sqlName);
  return {
    kind: "column",
    name: sqlName,
    sql: sqlName,
  };
}

export function dataset<T extends Record<string, string>>(
  table: string,
  columns: T,
): Dataset<T> {
  safeIdent(table);

  const out = {
    table,
    select<TFields extends Record<string, Selectable>>(fields: TFields) {
      return new Query(table).select(fields);
    },
    where(expression: Expr<boolean> | Expr) {
      return new Query(table).where(expression);
    },
  } as unknown as Dataset<T>;

  for (const [name, sqlName] of Object.entries(columns)) {
    (out as Record<string, unknown>)[name] = col(sqlName);
  }

  return out;
}

export function defineDataset<
  const TBlobs extends WAEFieldNames = [],
  const TDoubles extends WAEFieldNames = [],
  const TIndexes extends WAEFieldNames = [],
>(
  definition: WAEDatasetDefinition<TBlobs, TDoubles, TIndexes>,
): DefinedDataset<TBlobs, TDoubles, TIndexes> {
  const blobs = (definition.blobs ?? []) as TBlobs;
  const doubles = (definition.doubles ?? []) as TDoubles;
  const indexes = (definition.indexes ?? []) as TIndexes;

  if (blobs.length > 20 || doubles.length > 20) {
    throw new Error("WAE supports up to 20 blobs and doubles per dataset");
  }
  if (indexes.length > 1) {
    throw new Error("WAE supports 1 index per dataset");
  }

  validateFieldNames("blobs", blobs);
  validateFieldNames("doubles", doubles);
  validateFieldNames("indexes", indexes);

  const columnsFlat: Record<string, string> = {};
  const blobColumns = {} as ColumnsForNames<TBlobs, WAEBlobColumnName, string>;
  const doubleColumns = {} as ColumnsForNames<TDoubles, WAEDoubleColumnName, number>;
  const indexColumns = {} as ColumnsForNames<TIndexes, WAEIndexColumnName, string>;

  blobs.forEach((name, i) => {
    const columnName = `blob${i + 1}` as WAEBlobColumnName;
    columnsFlat[`blobs_${name}`] = columnName;
  });
  doubles.forEach((name, i) => {
    const columnName = `double${i + 1}` as WAEDoubleColumnName;
    columnsFlat[`doubles_${name}`] = columnName;
  });
  indexes.forEach((name, i) => {
    const columnName = `index${i + 1}` as WAEIndexColumnName;
    columnsFlat[`indexes_${name}`] = columnName;
  });

  const baseDataset = dataset(definition.name, columnsFlat);
  const datasetColumn = col<string, "dataset">(WAE_BASE_COLUMNS.dataset);
  const timestamp = col<Date, "timestamp">(WAE_BASE_COLUMNS.timestamp);
  const sampleInterval = col<number, "_sample_interval">(
    WAE_BASE_COLUMNS.sampleInterval,
  );
  const sampled = {
    count: () => sampledCount(sampleInterval),
    sum: (value: Selectable) => sampledSum(value, sampleInterval),
    avg: (value: Selectable) => sampledAvg(value, sampleInterval),
    quantile: (quantile: number, value: Selectable) =>
      quantileExactWeighted(quantile, value, sampleInterval),
  } satisfies SampledHelpers;

  for (const name of blobs as readonly TBlobs[number][]) {
    blobColumns[name] = baseDataset[`blobs_${name}`] as Column<
      string,
      WAEBlobColumnName
    >;
  }
  for (const name of doubles as readonly TDoubles[number][]) {
    doubleColumns[name] = baseDataset[`doubles_${name}`] as Column<
      number,
      WAEDoubleColumnName
    >;
  }
  for (const name of indexes as readonly TIndexes[number][]) {
    indexColumns[name] = baseDataset[`indexes_${name}`] as Column<
      string,
      WAEIndexColumnName
    >;
  }

  return {
    name: definition.name,
    fields: { blobs, doubles, indexes },
    dataset: datasetColumn,
    timestamp,
    sampleInterval,
    sampled,
    blobs: blobColumns,
    doubles: doubleColumns,
    indexes: indexColumns,
    select(fields) {
      return baseDataset.select(fields);
    },
    where(expression) {
      return baseDataset.where(expression);
    },
    dataPoint(values) {
      const blobsOut: WAEDataPointValue[] = [];
      const doublesOut: number[] = [];
      const indexesOut: WAEDataPointValue[] = [];

      for (const name of blobs as readonly TBlobs[number][]) {
        const column = blobColumns[name];
        blobsOut[toSlot(column.name, "blob")] = values.blobs[name];
      }
      for (const name of doubles as readonly TDoubles[number][]) {
        const column = doubleColumns[name];
        doublesOut[toSlot(column.name, "double")] = values.doubles[name];
      }
      for (const name of indexes as readonly TIndexes[number][]) {
        const column = indexColumns[name];
        indexesOut[toSlot(column.name, "index")] = values.indexes[name];
      }

      return {
        blobs: blobsOut,
        doubles: doublesOut,
        indexes: indexesOut,
      };
    },
  };
}

export class Query<Row = unknown> {
  /** Type-only expected row. No runtime value or decoding is provided. */
  declare readonly $inferRow: Row;
  private selects: string[] = [];
  private wheres: string[] = [];
  private groups: string[] = [];
  private havings: string[] = [];
  private orders: string[] = [];
  private limitValue: number | "ALL" | undefined;
  private outputFormat: WAEFormat | undefined;

  constructor(private readonly table: string) {
    safeIdent(table);
  }

  private copy<NextRow = Row>(): Query<NextRow> {
    const query = new Query<NextRow>(this.table);
    query.selects = [...this.selects];
    query.wheres = [...this.wheres];
    query.groups = [...this.groups];
    query.havings = [...this.havings];
    query.orders = [...this.orders];
    query.limitValue = this.limitValue;
    query.outputFormat = this.outputFormat;
    return query;
  }

  select<T extends Record<string, Selectable>>(
    fields: T,
  ): Query<SelectedRow<T>> {
    const entries = Object.entries(fields);
    if (entries.length === 0) {
      throw new Error("select() requires at least one field");
    }

    const query = this.copy<SelectedRow<T>>();
    query.selects = entries.map(
      ([alias, value]) => `${sqlOf(value)} AS ${safeIdent(alias)}`,
    );
    return query;
  }

  where(expression: Expr<boolean> | Expr): Query<Row> {
    const query = this.copy();
    query.wheres.push(expression.sql);
    return query;
  }

  groupBy(...columns: Array<Column | Expr | string>): Query<Row> {
    const query = this.copy();
    query.groups.push(
      ...columns.map((column) =>
        typeof column === "string" ? safeIdent(column) : column.sql,
      ),
    );
    return query;
  }

  having(expression: Expr<boolean> | Expr): Query<Row> {
    const query = this.copy();
    query.havings.push(expression.sql);
    return query;
  }

  orderBy(
    expression: Column | Expr | Extract<keyof Row, string>,
    direction: OrderDirection = "ASC",
  ): Query<Row> {
    const expr =
      typeof expression === "string" ? safeIdent(expression) : expression.sql;
    const query = this.copy();
    query.orders.push(`${expr} ${safeOrderDirection(direction)}`);
    return query;
  }

  limit(value: number | "ALL"): Query<Row> {
    const query = this.copy();
    query.limitValue = value === "ALL" ? value : safeInt(value, "limit");
    return query;
  }

  format(value: WAEFormat): Query<Row> {
    const query = this.copy();
    query.outputFormat = safeFormat(value);
    return query;
  }

  /** Decode a parsed FORMAT JSON envelope. Only DateTime values are converted.
   * Other values retain the trusted Row contract; this is not row validation.
   */
  decodeJSON(payload: unknown): Row[] {
    if (!isRecord(payload) || !Array.isArray(payload.meta) || !Array.isArray(payload.data)) {
      throw new Error("Expected a FORMAT JSON response with meta and data arrays");
    }

    const names = new Set<string>();
    const dates: Array<{ name: string; nullable: boolean }> = [];
    for (const column of payload.meta) {
      if (!isRecord(column) || typeof column.name !== "string" ||
        typeof column.type !== "string" || names.has(column.name)) {
        throw new Error("Invalid FORMAT JSON column metadata");
      }
      names.add(column.name);
      const nullable = column.type.startsWith("Nullable(") && column.type.endsWith(")");
      const type = nullable ? column.type.slice(9, -1) : column.type;
      if (type === "DateTime" || type === "DateTime('UTC')" || type === "DateTime('Etc/UTC')") {
        dates.push({ name: column.name, nullable });
      } else if (type.startsWith("DateTime")) {
        throw new Error(`Unsupported DateTime metadata type: ${column.type}`);
      }
    }

    return payload.data.map((row: unknown) => {
      if (!isRecord(row)) {
        throw new Error("Expected a FORMAT JSON row object");
      }
      const decoded = { ...row };
      for (const { name, nullable } of dates) {
        if (!Object.hasOwn(row, name)) {
          throw new Error(`Missing DateTime column: ${name}`);
        }
        const value = row[name];
        // Define an own data property even for aliases such as __proto__.
        Object.defineProperty(decoded, name, {
          value: nullable && value === null ? null : decodeDateTime(value, name),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return decoded as Row;
    });
  }

  toSQL(format: WAEFormat = this.outputFormat ?? "JSON") {
    format = safeFormat(format);
    const select = this.selects.length ? this.selects.join(", ") : "*";

    return [
      `SELECT ${select}`,
      `FROM ${safeIdent(this.table)}`,
      this.wheres.length ? `WHERE ${this.wheres.join(" AND ")}` : "",
      this.groups.length ? `GROUP BY ${this.groups.join(", ")}` : "",
      this.havings.length ? `HAVING ${this.havings.join(" AND ")}` : "",
      this.orders.length ? `ORDER BY ${this.orders.join(", ")}` : "",
      this.limitValue === undefined ? "" : `LIMIT ${this.limitValue}`,
      `FORMAT ${format}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
}

export function ident(value: string) {
  return safeIdent(value);
}

export function lit(value: Scalar): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("SQL number literal must be finite");
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${value.replaceAll("'", "''")}'`;
}

export function eq(left: Selectable, right: ValueExpr): Expr<boolean> {
  return wae`${left} = ${right}`;
}

export function ne(left: Selectable, right: ValueExpr): Expr<boolean> {
  return wae`${left} != ${right}`;
}

export function gt(left: Selectable, right: ValueExpr): Expr<boolean> {
  return wae`${left} > ${right}`;
}

export function gte(left: Selectable, right: ValueExpr): Expr<boolean> {
  return wae`${left} >= ${right}`;
}

export function lt(left: Selectable, right: ValueExpr): Expr<boolean> {
  return wae`${left} < ${right}`;
}

export function lte(left: Selectable, right: ValueExpr): Expr<boolean> {
  return wae`${left} <= ${right}`;
}

export function and(
  ...expressions: Array<Expr<boolean> | Expr>
): Expr<boolean> {
  if (expressions.length === 0)
    throw new Error("and() requires at least one expression");
  return sqlExpr(
    `(${expressions.map((expression) => expression.sql).join(" AND ")})`,
  );
}

export function or(...expressions: Array<Expr<boolean> | Expr>): Expr<boolean> {
  if (expressions.length === 0)
    throw new Error("or() requires at least one expression");
  return sqlExpr(
    `(${expressions.map((expression) => expression.sql).join(" OR ")})`,
  );
}

export function like(left: Selectable, pattern: string): Expr<boolean> {
  return wae`${left} LIKE ${pattern}`;
}

export function ilike(left: Selectable, pattern: string): Expr<boolean> {
  return wae`${left} ILIKE ${pattern}`;
}

export function inList(left: Selectable, values: Scalar[]): Expr<boolean> {
  if (values.length === 0)
    throw new Error("inList() requires at least one value");
  return sqlExpr(`${left.sql} IN (${values.map(lit).join(", ")})`);
}

export function notInList(left: Selectable, values: Scalar[]): Expr<boolean> {
  if (values.length === 0)
    throw new Error("notInList() requires at least one value");
  return sqlExpr(`${left.sql} NOT IN (${values.map(lit).join(", ")})`);
}

export function intervalAgo(amount: number, unit: IntervalUnit): Expr<Date> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("intervalAgo() amount must be a positive number");
  }

  return sqlExpr(`NOW() - INTERVAL '${amount}' ${safeIntervalUnit(unit)}`);
}

export function sum(value: Selectable): Expr<number> {
  return wae`SUM(${value})`;
}

export function avg(value: Selectable): Expr<number> {
  return wae`AVG(${value})`;
}

export function count(value?: Selectable): Expr<number> {
  if (!value) return sqlExpr("COUNT()");
  return wae`COUNT(${value})`;
}

export function countDistinct(value: Selectable): Expr<number> {
  return wae`COUNT(DISTINCT ${value})`;
}

export function toStartOfInterval(
  value: Selectable,
  amount: number,
  unit: IntervalUnit,
  timezone?: string,
): Expr<Date> {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    throw new Error("toStartOfInterval() amount must be a positive integer");
  }

  const tz = timezone ? `, ${lit(timezone)}` : "";
  return sqlExpr(
    `toStartOfInterval(${value.sql}, INTERVAL '${amount}' ${safeIntervalUnit(unit)}${tz})`,
  );
}

export function formatDateTime(
  value: Selectable,
  format: string,
  timezone?: string,
): Expr<string> {
  if (!timezone) return wae`formatDateTime(${value}, ${format})`;
  return wae`formatDateTime(${value}, ${format}, ${timezone})`;
}

export function dateBucket(
  value: Selectable,
  unit: IntervalUnit,
  amount = 1,
  format = "%Y-%m-%d",
  timezone?: string,
): Expr<string> {
  return formatDateTime(
    toStartOfInterval(value, amount, unit, timezone),
    format,
    timezone,
  );
}

export function sampledCount(sampleInterval: Selectable): Expr<number> {
  return sum(sampleInterval);
}

export function sampledSum(
  value: Selectable,
  sampleInterval: Selectable,
): Expr<number> {
  return wae`SUM(${value} * ${sampleInterval})`;
}

export function sampledAvg(
  value: Selectable,
  sampleInterval: Selectable,
): Expr<number> {
  return wae`SUM(${value} * ${sampleInterval}) / SUM(${sampleInterval})`;
}

export function quantileExactWeighted(
  quantile: number,
  value: Selectable,
  weight: Selectable,
): Expr<number> {
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error("quantileExactWeighted() quantile must be between 0 and 1");
  }

  return sqlExpr(
    `quantileExactWeighted(${quantile})(${value.sql}, ${weight.sql})`,
  );
}
