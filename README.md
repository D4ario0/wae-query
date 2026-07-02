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

```ts
import { dataset, eq, count } from "wae-query";

const events = dataset("events", {
  status: "blob1",
  duration: "double1",
});

const sql = events
  .select({
    status: events.status,
    total: count(),
  })
  .where(eq(events.status, "ok"))
  .groupBy(events.status)
  .toSQL();

console.log(sql);
```

Outputs:

```sql
SELECT blob1 AS status, COUNT() AS total
FROM events
WHERE blob1 = 'ok'
GROUP BY blob1
FORMAT JSON
```

## Define a Workers Analytics Engine dataset

Use `defineDataset` when you want logical field names mapped to WAE slots.

```ts
import { defineDataset } from "wae-query";

const analytics = defineDataset({
  name: "analytics",
  blobs: ["path", "colo"],
  doubles: ["requests", "latency"],
  indexes: ["tenant"],
});

analytics.blobs.path.sql; // "blob1"
analytics.blobs.colo.sql; // "blob2"
analytics.doubles.requests.sql; // "double1"
analytics.doubles.latency.sql; // "double2"
analytics.indexes.tenant.sql; // "index1"
analytics.timestamp.sql; // "timestamp"
analytics.sampleInterval.sql; // "_sample_interval"
```

## Query a defined dataset

```ts
import { defineDataset, gt, intervalAgo, sampledCount } from "wae-query";

const analytics = defineDataset({
  name: "analytics",
  indexes: ["tenant"],
});

const sql = analytics
  .select({
    tenant: analytics.indexes.tenant,
    requests: sampledCount(analytics.sampleInterval),
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

This package includes helpers for common sampled aggregations:

```ts
import {
  sampledCount,
  sampledSum,
  sampledAvg,
  quantileExactWeighted,
} from "wae-query";

sampledCount(analytics.sampleInterval);
// SUM(_sample_interval)

sampledSum(analytics.doubles.requests, analytics.sampleInterval);
// SUM(double1 * _sample_interval)

sampledAvg(analytics.doubles.latency, analytics.sampleInterval);
// SUM(double2 * _sample_interval) / SUM(_sample_interval)

quantileExactWeighted(0.95, analytics.doubles.latency, analytics.sampleInterval);
// quantileExactWeighted(0.95)(double2, _sample_interval)
```

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

For unsupported SQL, use `unsafeRaw` deliberately:

```ts
import { unsafeRaw } from "wae-query";

const expr = unsafeRaw("toStartOfHour(timestamp)");
```

Do not pass untrusted input to `unsafeRaw`.

## Development

```sh
pnpm install
pnpm test
pnpm run build
```

## License

ISC
