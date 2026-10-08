# wae-query

> ## ⚠️ v1.0.0 is a breaking change — read before upgrading
>
> v1 drops the legacy per-account HTTP endpoint
> (`https://api.cloudflare.com/client/v4/accounts/{id}/analytics_engine/sql`)
> and its `FORMAT`/`meta` dialect entirely. It targets only the Cloudflare
> [Analytics SQL binding](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)
> (`env.ANALYTICS_SQL.query()`). There is no dialect flag and no compatibility
> mode — if you need the legacy HTTP endpoint, stay on `0.x`.
>
> What changed, API by API:
>
> | | v0.x (legacy HTTP) | v1 (binding) |
> | --- | --- | --- |
> | `toSQL()` | appended `FORMAT <fmt>`, took an optional format arg | never emits `FORMAT`; no args |
> | `Query.format(fmt)` | set the output format | **removed** |
> | `decodeJSON(payload)` | required `payload.meta`, inferred DateTime columns from it | `decodeJSON(payload, dateColumns)`: no `meta` requirement, you name which columns to decode as `Date` |
> | dataset/table names | bare identifier only (`dataset("events", ...)`) | bare **or** schema-qualified (`dataset('events.analyticsEngine."my-dataset"', ...)`) |
> | column names/aliases | bare identifier | unchanged — still bare, never qualified |
>
> Migration: delete every `.format(...)` call and any explicit `FORMAT` arg to
> `toSQL()`; it's a no-op now. Every `decodeJSON(payload)` call needs a second
> argument listing the DateTime columns you expect (previously inferred from
> `meta`, which the binding doesn't return).
>
> **Unverified:** `decodeJSON`'s DateTime parsing logic is carried over
> unchanged from the `FORMAT JSON`/`meta` dialect and assumes the binding
> serializes `DateTime` values as the same string format. This has not been
> confirmed against a live `env.ANALYTICS_SQL.query()` response — see
> [Decode timestamp results](#decode-timestamp-results) below before relying on
> it in production.

A small TypeScript query builder for the Cloudflare [Analytics SQL binding](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)
(`env.ANALYTICS_SQL.query()`), targeting Workers Analytics Engine datasets.

It focuses on the parts that are easy to get wrong by hand:

- stable column names for `blob1`-`blob20`, `double1`-`double20`, `index1`, `timestamp`, and `_sample_interval`
- typed dataset definitions, including schema-qualified binding paths such as `events.analyticsEngine."my-dataset"`
- safe identifier and literal handling for common query patterns
- helpers for sampled aggregations using `_sample_interval`

This package builds SQL strings for `env.ANALYTICS_SQL.query({ query })` and can
decode declared `DateTime` columns from the binding's response. It does not call
the binding itself and does not target the legacy per-account HTTP endpoint or
its `FORMAT`/`meta` dialect.

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
values a caller promises to produce from the binding's response, not a parsed
and re-verified response. The library retains no runtime selection type
metadata. The optional `decodeJSON()` method converts explicitly named
DateTime columns; it does not infer types.

A caller wrapping `env.ANALYTICS_SQL.query({ query: Query<Row>.toSQL() })` owns
these requirements before trusting `Row[]`:

- The binding returns `{ data, rows, statistics }` directly (parsed, not a
  string) and throws on failure, with a `retryable` boolean on the error. There
  is no HTTP status or envelope to check.
- Do not include `accountTag`/`zoneTag` predicates in SQL; the binding supplies
  account scope itself and the API rejects a query that also specifies tenancy.
- Normalize supported SQL types explicitly. JSON parsing does not create `Date`
  objects: pass every DateTime column name to `decodeJSON()`, or cast to string
  in SQL and treat it as opaque. There is no `meta` array to infer types from,
  so nothing is decoded unless you name the column. SQL boolean representations
  also need a deliberate conversion policy.
- Verify numeric wire behavior before converting. Quoted numeric values must
  not be returned as `number` without conversion. Reject unsafe integer
  conversions and non-finite numbers rather than silently losing precision.
- Reject unexpected nulls or incompatible values under the built-in non-null
  contract. Empty aggregates and division by zero must not be assumed to
  produce finite numbers. Do not silently turn null into zero.

[Binding docs](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)
document the response shape and the `retryable` error property, but do not
specify the exact wire representation of a `DateTime` value in the no-`meta`
response (unverified against a live binding; the documented example response
has no DateTime column). Treat declared DateTime columns as the same
`YYYY-MM-DD HH:mm:ss[.fff]` / ISO-UTC string `decodeJSON()` already parses; if a
live binding returns something else, that is a bug report, not a guess made here.

`FORMAT` is not supported: do not add a `FORMAT` clause to a binding query, and
`toSQL()` never emits one.

### Decode timestamp results

Call `query.decodeJSON(payload, dateColumns)` with the binding's parsed response
and the list of selected column names that should become `Date` objects. The
binding response has no column metadata, so nothing is inferred: omit
`dateColumns` (or pass `[]`) and every value passes through unchanged.

```ts
import type { Query } from "wae-query";

interface Env {
  ANALYTICS_SQL: AnalyticsSQLBinding;
}

async function query<Row>(env: Env, q: Query<Row>, dateColumns: (keyof Row & string)[] = []): Promise<Row[]> {
  const response = await env.ANALYTICS_SQL.query({ query: q.toSQL() });
  return q.decodeJSON(response, dateColumns);
}

// const rows = await query(env, visits.select({ recordedAt: visits.timestamp }), ["recordedAt"]);
```

`dateBucket()` and `formatDateTime()` return SQL strings and should not be
passed as date columns.

The decoder's policy is deliberately narrow:

- Accept `YYYY-MM-DD HH:mm:ss` or the `T`-separated form, optionally ending in
  `Z`, with up to three fractional-second digits. Unzoned strings are interpreted
  as UTC, never the machine's local timezone.
- Reject invalid dates, calendar overflow, numeric date values, and timezone
  offsets other than UTC.
- `null` in a declared date column is passed through as `null`, not rejected
  or coerced (there is no `meta` to distinguish `Nullable` from non-nullable).
- Throw if a declared date column is missing from a row. Return new row objects
  without mutating the input or query. Empty results work.

**This is date decoding, not complete row validation.** Other SQL types pass
through unchanged, including numeric strings. The caller still owns numeric
and boolean normalization and checks for unexpected nulls described above.
Arbitrary `wae<T>` annotations remain trusted.

`decodeJSON()` takes the binding's full `{ data, ... }` response object, not
`response.data` alone. Unselected queries still return `unknown[]` even though
named dates are converted at runtime.

### Immutable chaining

Every query-builder method returns a new query. Always use its return value:

```ts
const base = visits.select({ visitor: visits.blobs.visitor_id });
const limited = base.limit(10); // base has no limit
const counts = base.select({ total: visits.sampled.count() });
// base and limited still select visitor; counts selects total.
```

`query.limit(10)` on its own does not update `query`. Clause arrays are copied,
so branches are independent. Reselecting retains other clauses; the builder
does not rewrite old grouping or ordering references to removed aliases. Keep
those clauses valid for the new selection.

Explicit `Query<"alias">` annotations must become row-shaped annotations such as
`Query<{ alias: number }>`, or preferably be removed and inferred. Chaining
returns `Query<Row>`, not a polymorphic subclass `this`.

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

## Dataset identifiers

`dataset(table, columns)` and `defineDataset({ name, ... })` accept either a
bare table name or a schema-qualified binding path. Quote any segment that
needs characters outside `[A-Za-z0-9_]`:

```ts
dataset("events", { status: "status" });
dataset('events.analyticsEngine."my-dataset"', { status: "status" });
```

Column names and aliases (`col()`, `select()` keys, `groupBy`/`orderBy` string
arguments) are always bare identifiers; they are never schema-qualified.

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
