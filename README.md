# wae-query

A small TypeScript query builder for Cloudflare Workers Analytics Engine SQL.

It focuses on the parts of Workers Analytics Engine that are easy to get wrong by hand:

- stable column names for `blob1`-`blob20`, `double1`-`double20`, `index1`, `timestamp`, and `_sample_interval`
- typed dataset definitions
- safe identifier and literal handling for common query patterns
- helpers for sampled aggregations using `_sample_interval`

This package builds SQL strings and can decode DateTime columns in JSON results.
It does not send requests to Cloudflare.

## Install

```sh
pnpm add wae-query
```

```sh
bun add wae-query
```

```sh
npm install wae-query
```

## Basic usage

Use `defineDataset` to map your logical field names to Workers Analytics Engine slots.

```ts
import { defineDataset, gt, intervalAgo } from "wae-query";

const analytics = defineDataset({
  name: "analytics",
  blobs: ["path", "colo"],
  doubles: ["requests", "latency"],
  indexes: ["tenant"],
});

const sql = analytics
  .select({
    tenant: analytics.indexes.tenant,
    requests: analytics.sampled.count(),
  })
  .where(gt(analytics.timestamp, intervalAgo(7, "DAY")))
  .groupBy(analytics.indexes.tenant)
  .orderBy("requests", "DESC")
  .limit(100)
  .toSQL();

console.log(sql);
```

Outputs:

```sql
SELECT index1 AS tenant, SUM(_sample_interval) AS requests
FROM analytics
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY index1
ORDER BY requests DESC
LIMIT 100
FORMAT JSON
```

The dataset object exposes WAE slots through the names you define:

```ts
analytics.blobs.path.sql; // "blob1"
analytics.blobs.colo.sql; // "blob2"
analytics.doubles.requests.sql; // "double1"
analytics.doubles.latency.sql; // "double2"
analytics.indexes.tenant.sql; // "index1"
analytics.timestamp.sql; // "timestamp"
analytics.sampleInterval.sql; // "_sample_interval"
```

## Query a dataset

```ts
import { defineDataset, gt, intervalAgo } from "wae-query";

const analytics = defineDataset({
  name: "analytics",
  indexes: ["tenant"],
});

const sql = analytics
  .select({
    tenant: analytics.indexes.tenant,
    requests: analytics.sampled.count(),
  })
  .where(gt(analytics.timestamp, intervalAgo(7, "DAY")))
  .groupBy(analytics.indexes.tenant)
  .orderBy("requests", "DESC")
  .limit(100)
  .toSQL();
```

Outputs:

```sql
SELECT index1 AS tenant, SUM(_sample_interval) AS requests
FROM analytics
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY index1
ORDER BY requests DESC
LIMIT 100
FORMAT JSON
```

## Inferred result rows

`Query<Row>` carries the selected expression types. An external executor can infer
its return type without generics or interfaces at the call site:

```ts
import { defineDataset, dateBucket, eq, type Query } from "wae-query";

// Signature of your external executor, not an implementation supplied by wae-query.
declare const executor: {
  query<Row>(query: Query<Row>): Promise<Row[]>;
};

const visits = defineDataset({
  name: "EVENT_PAGE_VISITS",
  blobs: ["visitor_id"],
  indexes: ["event_id"],
});

const result = await executor.query(
  visits.select({
    date: dateBucket(visits.timestamp, "DAY"),
    visit_count: visits.sampled.count(),
  }).where(eq(visits.indexes.event_id, "event-123")),
);

result[0]?.date; // string | undefined
result[0]?.visit_count; // number | undefined
```

`SelectedRow<Fields>` maps selections to their expected application values.
`Query<Row>["$inferRow"]` is type-only; it does not exist at runtime. Optional
`InferRow<typeof query>` extracts the same row type, but executors do not need it.
Filtering, grouping, having, ordering, limits, and formats preserve that type.

Defined dataset read types are:

| Expression | Expected application type |
| --- | --- |
| Named blobs, indexes, and `dataset` | `string` |
| Named doubles, `sampleInterval`, aggregate helpers | `number` |
| `timestamp`, `intervalAgo`, `toStartOfInterval` | `Date` |
| `dateBucket`, `formatDateTime` | `string` |
| Comparison expressions | `boolean` |

Legacy `dataset(table, columns)` columns and unannotated raw expressions remain
`unknown`. Queries without a selection emit `SELECT *` and infer `unknown`, not
logical field names. `wae<T>` and `col<T>` are caller assertions, not proof of SQL
behavior. Write-side `dataPoint()` types are unchanged, including nullable/binary
blob and index inputs; these are not read-result types.

### Executor contract and wire values

This is **trusted inference**, not runtime validation. The types describe the
values an executor promises to return, not the unmodified Analytics Engine HTTP
response. The library retains no runtime selection type metadata. The optional
`decodeJSON()` method converts dates using response metadata instead.

An executor adopting `query<Row>(query: Query<Row>): Promise<Row[]>` owns these
requirements before its centralized assertion:

- Compile with `query.toSQL("JSON")` if it expects the JSON `data` envelope.
  Validate the response status and envelope independently of row typing.
- Normalize supported SQL types using response metadata or its own explicit
  policy. JSON parsing does not create `Date` objects. Date conversion requires
  a known timestamp format/timezone and must reject invalid dates. `decodeJSON()`
  handles the UTC formats described below. SQL boolean
  representations also need a deliberate conversion policy.
- Verify numeric wire behavior before converting. Quoted numeric values must
  not be returned as `number` without conversion. Reject unsafe integer
  conversions and non-finite numbers rather than silently losing precision.
  Already-rounded JSON numbers cannot be recovered after parsing; use a
  lossless parsing strategy or reject them when exact integers are required.
- Reject unexpected nulls or incompatible values under the built-in non-null
  contract. Empty aggregates and division by zero must not be assumed to
  produce finite numbers. Do not silently turn null into zero. Applications
  that need nullable results can use explicitly annotated expressions and an
  executor policy that supports them.

Cloudflare documents the [column types](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
and [output formats](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/),
but those pages do not establish all numeric serialization or empty-aggregate
behaviors. No live HTTP responses were verified for this change. Inference
cannot guarantee SQL validity, finite aggregates, exact arithmetic, or that
arbitrary annotations match the response. An envelope-only check followed by
`as Row[]` does not establish this normalization contract.

`JSONEachRow` and `TabSeparated` remain supported SQL output formats. They do not
change the expected application row type or add parsing. An executor using them
must supply a matching parser and normalization policy; a JSON-envelope executor
should override the configured format with `toSQL("JSON")`.

### Decode timestamp results

Call `query.decodeJSON(payload)` with the parsed `FORMAT JSON` envelope to get
inferred rows with SQL `DateTime` values converted into JavaScript `Date` objects.
The external executor still owns HTTP execution and error handling:

```ts
import type { Query } from "wae-query";

// transport sends SQL and checks HTTP status before returning parsed JSON.
function createExecutor(transport: (sql: string) => Promise<unknown>) {
  return {
    async query<Row>(query: Query<Row>): Promise<Row[]> {
      return query.decodeJSON(await transport(query.toSQL("JSON")));
    },
  };
}
```

For example, selecting `{ recordedAt: visits.timestamp }` returns a `Date` under
`recordedAt` when its response metadata type is `DateTime`. A string column named
`timestamp` stays a string. `dateBucket()` and `formatDateTime()` return SQL
strings and are not converted.

The decoder's policy is deliberately narrow:

- Accept `DateTime`, `DateTime('UTC')`, and `DateTime('Etc/UTC')` metadata.
- Accept `YYYY-MM-DD HH:mm:ss` or the `T`-separated form, optionally ending in
  `Z`, with up to three fractional-second digits. Unzoned strings are interpreted
  as UTC, never the machine's local timezone. This is an explicit decoding
  policy, not a live-verified guarantee about every Cloudflare response.
- Reject invalid dates, calendar overflow, missing date columns, numeric date
  values, timezone offsets, other named timezones, and `DateTime64` metadata.
  Unsupported precision is rejected, not silently truncated.
- For `Nullable(DateTime...)`, preserve null. Non-nullable date columns reject
  null. Nullable expression annotations must match that contract; metadata does
  not change the compile-time row type.
- Require `meta` and `data` arrays, valid unique column metadata, and row objects.
  Return new row objects without mutating the input or query. Empty results work.

**This is date decoding, not complete row validation.** Other SQL types pass
through unchanged, including numeric strings. The executor still owns numeric
and boolean normalization and checks for unexpected nulls described above.
Arbitrary `wae<T>` annotations remain trusted. Metadata is not checked against
selection types, and unsupported non-DateTime types are not decoded.

`decodeJSON()` takes the entire parsed envelope, not `payload.data`, a JSON
string, JSONEachRow, or tab-separated text. It does not inspect the query's
configured output format; compile with `toSQL("JSON")` when using it. Unselected
queries still return `unknown[]` even though metadata-identified dates are
converted at runtime.

### Immutable chaining and migration

Every query-builder method returns a new query. Always use its return value:

```ts
const base = visits.select({ visitor: visits.blobs.visitor_id });
const limited = base.limit(10); // base has no limit
const counts = base.select({ total: visits.sampled.count() });
// base and limited still select visitor; counts selects total.
```

This changes the previous mutable behavior: `query.limit(10)` on its own no
longer updates `query`. Clause arrays are copied, so branches are independent.
Reselecting retains other clauses; the builder does not rewrite old grouping or
ordering references to removed aliases. Keep those clauses valid for the new
selection.

Explicit `Query<"alias">` annotations must become row-shaped annotations such as
`Query<{ alias: number }>`, or preferably be removed and inferred. Chaining
returns `Query<Row>`, not a polymorphic subclass `this`. There is no package
version bump or publication associated with this source change.

## Sampling helpers

Workers Analytics Engine may sample data. Cloudflare exposes the sampling rate in `_sample_interval`.

Defined datasets include `sampled` helpers bound to their `_sample_interval` column:

```ts
analytics.sampled.count();
// SUM(_sample_interval)

analytics.sampled.sum(analytics.doubles.requests);
// SUM(double1 * _sample_interval)

analytics.sampled.avg(analytics.doubles.latency);
// SUM(double2 * _sample_interval) / SUM(_sample_interval)

analytics.sampled.quantile(0.95, analytics.doubles.latency);
// quantileExactWeighted(0.95)(double2, _sample_interval)
```

Standalone helpers such as `sampledCount`, `sampledSum`, `sampledAvg`, and `quantileExactWeighted` are also exported for lower-level use.

## Creating data points

`dataPoint` converts logical field names into the array shape used when writing Workers Analytics Engine datapoints.

```ts
const point = analytics.dataPoint({
  blobs: {
    path: "/api/users",
    colo: "SFO",
  },
  doubles: {
    requests: 1,
    latency: 42.5,
  },
  indexes: {
    tenant: "acme",
  },
});

// {
//   blobs: ["/api/users", "SFO"],
//   doubles: [1, 42.5],
//   indexes: ["acme"]
// }
```

You can pass those arrays to `writeDataPoint` in a Worker.

```ts
export default {
  async fetch(request, env) {
    env.ANALYTICS.writeDataPoint(point);
    return new Response("ok");
  },
};
```

## Expressions

```ts
import { and, eq, gt, inList, like } from "wae-query";

const filter = and(
  eq(analytics.indexes.tenant, "acme"),
  gt(analytics.doubles.latency, 100),
  like(analytics.blobs.path, "/api/%"),
);

const sql = analytics.where(filter).toSQL();
```

For custom expressions, use the `wae` tagged template. Columns and expressions are inserted as SQL; scalar values are escaped as literals.

```ts
import { wae } from "wae-query";

const filter = wae`${analytics.blobs.path} LIKE ${"/api/%"}`;
const bucket = wae`toStartOfHour(${analytics.timestamp})`;

const sql = analytics
  .select({
    hour: bucket,
    requests: analytics.sampled.count(),
  })
  .where(filter)
  .groupBy("hour")
  .toSQL();
```

## Ordering

After `select`, string-based `orderBy` values are typed as selected aliases.

```ts
analytics
  .select({
    tenant: analytics.indexes.tenant,
    requests: analytics.sampled.count(),
  })
  .orderBy("requests", "DESC");
```

You can also order by a column or expression directly:

```ts
analytics.select({ timestamp: analytics.timestamp }).orderBy(analytics.timestamp, "DESC");
analytics.select({ requests: analytics.sampled.count() }).orderBy(analytics.sampled.count(), "DESC");
```

Supported directions are `"ASC"` and `"DESC"`.

## Date helpers

```ts
import { dateBucket, intervalAgo, gt, avg } from "wae-query";

const sql = analytics
  .select({
    day: dateBucket(analytics.timestamp, "DAY", 1, "%Y-%m-%d", "UTC"),
    latency: avg(analytics.doubles.latency),
  })
  .where(gt(analytics.timestamp, intervalAgo(30, "DAY")))
  .groupBy("day")
  .toSQL();
```

## Output formats

The default format is `JSON`.

```ts
query.toSQL(); // FORMAT JSON
query.format("JSONEachRow").toSQL(); // FORMAT JSONEachRow
query.toSQL("TabSeparated"); // FORMAT TabSeparated
```

Supported formats are:

- `JSON`
- `JSONEachRow`
- `TabSeparated`

## Safety notes

Identifiers are validated and string literals are escaped for the helpers provided by this package.

Prefer `wae``...`` for custom expressions that include scalar values:

```ts
const filter = wae`${analytics.blobs.path} = ${"/api/users"}`;
// blob1 = '/api/users'
```

For unsupported SQL fragments that should be inserted exactly as written, use `wae.raw` deliberately:

```ts
import { wae } from "wae-query";

const expr = wae.raw("toStartOfHour(timestamp)");
```

Do not pass untrusted input to `wae.raw`.

`unsafeRaw` is still exported as a deprecated alias for compatibility.

## Development

```sh
pnpm install
pnpm test # build, compile-time assertions, and Node runtime tests
pnpm run check
pnpm run build
```

## License

MIT
