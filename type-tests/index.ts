import {
  Query, col, count, dataset, dateBucket, defineDataset, eq, formatDateTime,
  gt, intervalAgo, toStartOfInterval, wae,
  type InferRow,
} from "../dist/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// External executor signature. No explicit generic at any call site below.
declare const executor: { query<Row>(query: Query<Row>): Promise<Row[]> };
const visits = defineDataset({
  name: "EVENT_PAGE_VISITS",
  blobs: ["visitor_id"], doubles: ["latency"], indexes: ["event_id"],
});
const selected = visits.select({
  date: dateBucket(visits.timestamp, "DAY"),
  visit_count: visits.sampled.count(),
  visitor: visits.blobs.visitor_id,
  latency: visits.doubles.latency,
  event: visits.indexes.event_id,
  timestamp: visits.timestamp,
  dataset: visits.dataset,
  sampleInterval: visits.sampleInterval,
  matches: eq(visits.indexes.event_id, "event"),
});
const chained = selected
  .where(eq(visits.indexes.event_id, "event"))
  .groupBy("date", visits.blobs.visitor_id)
  .having(gt(count(), 0))
  .orderBy("visit_count", "DESC")
  .limit(10);
const result = executor.query(chained);
type Expected = {
  date: string; visit_count: number; visitor: string; latency: number;
  event: string; timestamp: Date; dataset: string; sampleInterval: number;
  matches: boolean;
};
type Inferred = Expect<Equal<Awaited<typeof result>, Expected[]>>;
type Preserved = Expect<Equal<InferRow<typeof selected>, InferRow<typeof chained>>>;

async function assignments() {
  const rows = await executor.query(chained);
  const date: string | undefined = rows[0]?.date;
  const count: number | undefined = rows[0]?.visit_count;
  // @ts-expect-error numeric result is not a string
  const wrongCount: string | undefined = rows[0]?.visit_count;
  // @ts-expect-error string result is not a number
  const wrongDate: number | undefined = rows[0]?.date;
  // @ts-expect-error not selected
  rows[0]?.missing;
}
// @ts-expect-error undeclared ordering alias
chained.orderBy("missing");
chained.orderBy(visits.timestamp);

const first = visits.select({ first: visits.blobs.visitor_id });
const second = first.select({ second: visits.sampled.count() });
type First = Expect<Equal<InferRow<typeof first>, { first: string }>>;
type Second = Expect<Equal<InferRow<typeof second>, { second: number }>>;
// @ts-expect-error replaced alias is not selected
second.orderBy("first");

const unselected = visits.where(eq(visits.indexes.event_id, "event"));
const bare = new Query("events");
type Unselected = Expect<Equal<InferRow<typeof unselected>, unknown>>;
type Bare = Expect<Equal<Awaited<ReturnType<typeof executor.query>>, unknown[]>>;
const bareResult = executor.query(bare);
type BareResult = Expect<Equal<Awaited<typeof bareResult>, unknown[]>>;
// @ts-expect-error no known aliases before selection
unselected.orderBy("event_id");
const afterWhere = unselected.select({ count: count() });
type AfterWhere = Expect<Equal<InferRow<typeof afterWhere>, { count: number }>>;

const legacy = dataset("events", { name: "blob1" });
const unknowns = legacy.select({
  name: legacy.name, raw: wae.raw("blob2"), template: wae`blob3`, column: col("blob4"),
});
type Unknowns = Expect<Equal<InferRow<typeof unknowns>, {
  name: unknown; raw: unknown; template: unknown; column: unknown;
}>>;
const legacyUnselected = legacy.where(wae`true`);
type LegacyUnselected = Expect<Equal<InferRow<typeof legacyUnselected>, unknown>>;
const annotated = legacy.select({ asserted: wae<string | null>`blob1`, typed: col<number>("double1") });
type Annotated = Expect<Equal<InferRow<typeof annotated>, { asserted: string | null; typed: number }>>;

const helpers = visits.select({
  sum: visits.sampled.sum(visits.doubles.latency),
  avg: visits.sampled.avg(visits.doubles.latency),
  quantile: visits.sampled.quantile(0.95, visits.doubles.latency),
  formatted: formatDateTime(visits.timestamp, "%Y"),
  start: toStartOfInterval(visits.timestamp, 1, "DAY"),
  ago: intervalAgo(1, "DAY"),
});
type Helpers = Expect<Equal<InferRow<typeof helpers>, {
  sum: number; avg: number; quantile: number; formatted: string; start: Date; ago: Date;
}>>;

const json = chained.format("JSON");
const lines = chained.format("JSONEachRow");
const tsv = chained.format("TabSeparated");
type JSONRow = Expect<Equal<InferRow<typeof json>, Expected>>;
type LinesRow = Expect<Equal<InferRow<typeof lines>, Expected>>;
type TSVRow = Expect<Equal<InferRow<typeof tsv>, Expected>>;
// Formats describe serialization, not a decoder. A JSON executor overrides them.
json.toSQL("JSON"); lines.toSQL("JSON"); tsv.toSQL("JSON");
// @ts-expect-error unsupported format
chained.format("CSV");

const point = visits.dataPoint({
  blobs: { visitor_id: new ArrayBuffer(1) },
  doubles: { latency: 5 }, indexes: { event_id: null },
});
type Point = Expect<Equal<typeof point, {
  blobs: (string | ArrayBuffer | null)[]; doubles: number[];
  indexes: (string | ArrayBuffer | null)[];
}>>;
visits.dataPoint({
  blobs: { visitor_id: "visitor" }, indexes: { event_id: "event" },
  // @ts-expect-error write doubles still require numbers
  doubles: { latency: "slow" },
});

// Decoding preserves inference through a real generic executor implementation.
async function decodingExecutor<Row>(query: Query<Row>): Promise<Row[]> {
  const response = await fetch("https://example.invalid/sql", {
    method: "POST", body: query.toSQL("JSON"),
  });
  if (!response.ok) throw new Error("SQL request failed");
  return query.decodeJSON(await response.json());
}
const decoded = selected.decodeJSON({ meta: [], data: [] });
type Decoded = Expect<Equal<typeof decoded, Expected[]>>;
const executedDecoded = decodingExecutor(selected);
type ExecutedDecoded = Expect<Equal<Awaited<typeof executedDecoded>, Expected[]>>;
const decodedUnknown = unselected.decodeJSON({ meta: [], data: [] });
type DecodedUnknown = Expect<Equal<typeof decodedUnknown, unknown[]>>;
// @ts-expect-error decoded Date is not a string
const invalidTimestamp: string | undefined = decoded[0]?.timestamp;
