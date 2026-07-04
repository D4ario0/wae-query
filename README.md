# wae-query

A small TypeScript query builder for Cloudflare Workers Analytics Engine SQL.

It focuses on the parts of Workers Analytics Engine that are easy to get wrong by hand:

- stable column names for `blob1`-`blob20`, `double1`-`double20`, `index1`, `timestamp`, and `_sample_interval`
- typed dataset definitions
- safe identifier and literal handling for common query patterns
- helpers for sampled aggregations using `_sample_interval`

This package only builds SQL strings. It does not send requests to Cloudflare.

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
analytics.orderBy(analytics.timestamp, "DESC");
analytics.orderBy(analytics.sampled.count(), "DESC");
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
pnpm test
pnpm run build
```

## License

MIT
