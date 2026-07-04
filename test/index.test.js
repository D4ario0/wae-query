import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  and,
  avg,
  col,
  count,
  countDistinct,
  dataset,
  dateBucket,
  defineDataset,
  eq,
  formatDateTime,
  gt,
  gte,
  ident,
  ilike,
  inList,
  intervalAgo,
  like,
  lit,
  lt,
  lte,
  ne,
  notInList,
  or,
  quantileExactWeighted,
  sampledAvg,
  sampledCount,
  sampledSum,
  sum,
  toStartOfInterval,
  unsafeRaw,
  wae,
  WAE_BASE_COLUMNS,
  WAE_BLOB_COLUMNS,
  WAE_DOUBLE_COLUMNS,
  WAE_INDEX_COLUMNS,
} from "../dist/index.js";

describe("literals and identifiers", () => {
  it("escapes scalar SQL literals", () => {
    assert.equal(lit(null), "NULL");
    assert.equal(lit(42), "42");
    assert.equal(lit(true), "true");
    assert.equal(lit(false), "false");
    assert.equal(lit("can't"), "'can''t'");
  });

  it("rejects invalid numeric literals", () => {
    assert.throws(() => lit(Number.NaN), /finite/);
    assert.throws(() => lit(Infinity), /finite/);
  });

  it("rejects invalid column identifiers", () => {
    assert.throws(() => col("bad-name"), /Invalid SQL identifier/);
  });
});

describe("expressions", () => {
  const status = col("status");
  const duration = col("duration");

  it("builds comparison expressions", () => {
    assert.equal(eq(status, "ok").sql, "status = 'ok'");
    assert.equal(ne(status, "ok").sql, "status != 'ok'");
    assert.equal(gt(duration, 10).sql, "duration > 10");
    assert.equal(gte(duration, 10).sql, "duration >= 10");
    assert.equal(lt(duration, 10).sql, "duration < 10");
    assert.equal(lte(duration, 10).sql, "duration <= 10");
  });

  it("builds boolean and list expressions", () => {
    assert.equal(and(eq(status, "ok"), gt(duration, 10)).sql, "(status = 'ok' AND duration > 10)");
    assert.equal(or(eq(status, "ok"), eq(status, "error")).sql, "(status = 'ok' OR status = 'error')");
    assert.equal(like(status, "2%" ).sql, "status LIKE '2%'");
    assert.equal(ilike(status, "ok%" ).sql, "status ILIKE 'ok%'");
    assert.equal(inList(status, ["ok", "error"]).sql, "status IN ('ok', 'error')");
    assert.equal(notInList(status, ["debug"]).sql, "status NOT IN ('debug')");
  });

  it("rejects empty boolean/list expressions", () => {
    assert.throws(() => and(), /requires at least one expression/);
    assert.throws(() => or(), /requires at least one expression/);
    assert.throws(() => inList(status, []), /requires at least one value/);
    assert.throws(() => notInList(status, []), /requires at least one value/);
  });
});

describe("query builder", () => {
  it("builds a complete SQL query", () => {
    const events = dataset("events", {
      status: "status",
      duration: "duration",
    });

    const sql = events
      .select({
        status: events.status,
        total: count(),
        avgDuration: avg(events.duration),
      })
      .where(eq(events.status, "ok"))
      .groupBy(events.status)
      .having(gt(count(), 1))
      .orderBy("total", "DESC")
      .limit(10)
      .format("JSONEachRow")
      .toSQL();

    assert.equal(
      sql,
      [
        "SELECT status AS status, COUNT() AS total, AVG(duration) AS avgDuration",
        "FROM events",
        "WHERE status = 'ok'",
        "GROUP BY status",
        "HAVING COUNT() > 1",
        "ORDER BY total DESC",
        "LIMIT 10",
        "FORMAT JSONEachRow",
      ].join("\n"),
    );
  });

  it("supports raw expressions and explicit output format", () => {
    const sql = dataset("events", {}).where(wae.raw("status = 'ok'")).toSQL("TabSeparated");

    assert.equal(sql, ["SELECT *", "FROM events", "WHERE status = 'ok'", "FORMAT TabSeparated"].join("\n"));
  });

  it("keeps unsafeRaw as a deprecated alias for wae.raw", () => {
    assert.equal(unsafeRaw("status = 'ok'").sql, wae.raw("status = 'ok'").sql);
  });

  it("validates query inputs", () => {
    const events = dataset("events", { status: "status" });

    assert.throws(() => dataset("bad-name", {}), /Invalid SQL identifier/);
    assert.throws(() => events.select({}), /select\(\) requires at least one field/);
    assert.throws(() => events.select({ "bad-alias": events.status }), /Invalid SQL identifier/);
    assert.throws(() => events.select({ status: events.status }).orderBy("status", "DOWN"), /Invalid order direction/);
    assert.throws(() => events.select({ status: events.status }).limit(-1), /non-negative integer/);
    assert.throws(() => events.select({ status: events.status }).format("CSV"), /Invalid WAE format/);
  });
});

describe("WAE dataset definitions", () => {
  it("maps logical fields to WAE slots and creates data points", () => {
    const analytics = defineDataset({
      name: "analytics",
      blobs: ["path", "colo"],
      doubles: ["requests", "latency"],
      indexes: ["tenant"],
    });

    assert.equal(analytics.blobs.path.name, "blob1");
    assert.equal(analytics.blobs.colo.name, "blob2");
    assert.equal(analytics.doubles.requests.name, "double1");
    assert.equal(analytics.doubles.latency.name, "double2");
    assert.equal(analytics.indexes.tenant.name, "index1");

    assert.deepEqual(
      analytics.dataPoint({
        blobs: { path: "/", colo: "SFO" },
        doubles: { requests: 5, latency: 12.5 },
        indexes: { tenant: "acme" },
      }),
      {
        blobs: ["/", "SFO"],
        doubles: [5, 12.5],
        indexes: ["acme"],
      },
    );
  });

  it("validates WAE dataset definitions", () => {
    assert.throws(() => defineDataset({ name: "x", blobs: ["bad-name"] }), /Invalid SQL identifier/);
    assert.throws(() => defineDataset({ name: "x", blobs: ["a", "a"] }), /Duplicate blobs field/);
    assert.throws(() => defineDataset({ name: "x", indexes: ["a", "b"] }), /supports 1 index/);
    assert.throws(
      () => defineDataset({ name: "x", blobs: Array.from({ length: 21 }, (_, i) => `b${i}`) }),
      /supports up to 20 blobs and doubles/,
    );
  });
});

describe("ClickHouse helpers", () => {
  const duration = col("duration");
  const sampleInterval = col("_sample_interval");
  const timestamp = col("timestamp");

  it("builds aggregation helpers", () => {
    assert.equal(sum(duration).sql, "SUM(duration)");
    assert.equal(avg(duration).sql, "AVG(duration)");
    assert.equal(count().sql, "COUNT()");
    assert.equal(count(duration).sql, "COUNT(duration)");
    assert.equal(countDistinct(duration).sql, "COUNT(DISTINCT duration)");
    assert.equal(sampledCount(sampleInterval).sql, "SUM(_sample_interval)");
    assert.equal(sampledSum(duration, sampleInterval).sql, "SUM(duration * _sample_interval)");
    assert.equal(sampledAvg(duration, sampleInterval).sql, "SUM(duration * _sample_interval) / SUM(_sample_interval)");
    assert.equal(quantileExactWeighted(0.95, duration, sampleInterval).sql, "quantileExactWeighted(0.95)(duration, _sample_interval)");
  });

  it("builds date/time helpers", () => {
    assert.equal(intervalAgo(5, "MINUTE").sql, "NOW() - INTERVAL '5' MINUTE");
    assert.equal(toStartOfInterval(timestamp, 1, "DAY", "UTC").sql, "toStartOfInterval(timestamp, INTERVAL '1' DAY, 'UTC')");
    assert.equal(formatDateTime(timestamp, "%Y-%m-%d", "UTC").sql, "formatDateTime(timestamp, '%Y-%m-%d', 'UTC')");
    assert.equal(dateBucket(timestamp, "HOUR", 2, "%H", "UTC").sql, "formatDateTime(toStartOfInterval(timestamp, INTERVAL '2' HOUR, 'UTC'), '%H', 'UTC')");
  });

  it("validates helper inputs", () => {
    assert.throws(() => intervalAgo(0, "MINUTE"), /positive number/);
    assert.throws(() => toStartOfInterval(timestamp, 1.5, "DAY"), /positive integer/);
    assert.throws(() => quantileExactWeighted(2, duration, sampleInterval), /between 0 and 1/);
  });
});

describe("additional public API behavior", () => {
  it("accepts valid identifiers through ident()", () => {
    assert.equal(ident("valid_name_123"), "valid_name_123");
  });

  it("rejects invalid identifiers through ident()", () => {
    assert.throws(() => ident("123_invalid"), /Invalid SQL identifier/);
  });

  it("creates columns with stable SQL and name metadata", () => {
    const column = col("request_count");

    assert.deepEqual(column, {
      kind: "column",
      name: "request_count",
      sql: "request_count",
    });
  });

  it("creates datasets with column accessors", () => {
    const events = dataset("events", {
      status: "status",
      durationMs: "duration_ms",
    });

    assert.equal(events.table, "events");
    assert.equal(events.status.sql, "status");
    assert.equal(events.durationMs.name, "duration_ms");
  });

  it("rejects invalid dataset column SQL names", () => {
    assert.throws(
      () => dataset("events", { bad: "bad-name" }),
      /Invalid SQL identifier/,
    );
  });

  it("renders an unselected dataset query as SELECT star", () => {
    assert.equal(dataset("events", {}).where(eq(col("status"), "ok")).toSQL(), [
      "SELECT *",
      "FROM events",
      "WHERE status = 'ok'",
      "FORMAT JSON",
    ].join("\n"));
  });

  it("combines multiple where clauses with AND", () => {
    const events = dataset("events", { status: "status", duration: "duration" });

    assert.equal(events
      .where(eq(events.status, "ok"))
      .where(gt(events.duration, 100))
      .toSQL(), [
      "SELECT *",
      "FROM events",
      "WHERE status = 'ok' AND duration > 100",
      "FORMAT JSON",
    ].join("\n"));
  });

  it("supports grouping by alias strings and raw expressions", () => {
    const events = dataset("events", { timestamp: "timestamp" });

    assert.equal(events
      .select({ bucket: unsafeRaw("toStartOfHour(timestamp)") })
      .groupBy("bucket", unsafeRaw("timezone"))
      .toSQL(), [
      "SELECT toStartOfHour(timestamp) AS bucket",
      "FROM events",
      "GROUP BY bucket, timezone",
      "FORMAT JSON",
    ].join("\n"));
  });

  it("supports ordering by expression objects", () => {
    const events = dataset("events", { duration: "duration" });

    assert.equal(events
      .select({ total: sum(events.duration) })
      .orderBy(sum(events.duration), "DESC")
      .toSQL(), [
      "SELECT SUM(duration) AS total",
      "FROM events",
      "ORDER BY SUM(duration) DESC",
      "FORMAT JSON",
    ].join("\n"));
  });

  it("supports LIMIT ALL", () => {
    const events = dataset("events", { status: "status" });

    assert.equal(events.select({ status: events.status }).limit("ALL").toSQL(), [
      "SELECT status AS status",
      "FROM events",
      "LIMIT ALL",
      "FORMAT JSON",
    ].join("\n"));
  });

  it("allows toSQL() to override a previously configured format", () => {
    const events = dataset("events", { status: "status" });

    assert.equal(events.select({ status: events.status }).format("JSONEachRow").toSQL("TabSeparated"), [
      "SELECT status AS status",
      "FROM events",
      "FORMAT TabSeparated",
    ].join("\n"));
  });

  it("creates empty arrays for datasets without mapped fields", () => {
    const analytics = defineDataset({ name: "analytics" });

    assert.deepEqual(analytics.fields, { blobs: [], doubles: [], indexes: [] });
    assert.deepEqual(analytics.dataPoint({ blobs: {}, doubles: {}, indexes: {} }), {
      blobs: [],
      doubles: [],
      indexes: [],
    });
  });

  it("validates duplicate double and index field names", () => {
    assert.throws(
      () => defineDataset({ name: "analytics", doubles: ["value", "value"] }),
      /Duplicate doubles field/,
    );
    assert.throws(
      () => defineDataset({ name: "analytics", indexes: ["tenant", "tenant"] }),
      /supports 1 index/,
    );
  });

  it("keeps nullable and binary WAE datapoint values in slot order", () => {
    const bytes = new ArrayBuffer(2);
    const analytics = defineDataset({
      name: "analytics",
      blobs: ["body", "optional"],
    });

    assert.deepEqual(analytics.dataPoint({
      blobs: { body: bytes, optional: null },
      doubles: {},
      indexes: {},
    }), {
      blobs: [bytes, null],
      doubles: [],
      indexes: [],
    });
  });
});

describe("Cloudflare Workers Analytics Engine documented behavior", () => {
  it("exports the documented WAE base column names", () => {
    assert.equal(WAE_BASE_COLUMNS.dataset, "dataset");
    assert.equal(WAE_BASE_COLUMNS.timestamp, "timestamp");
    assert.equal(WAE_BASE_COLUMNS.sampleInterval, "_sample_interval");
    assert.equal(WAE_INDEX_COLUMNS.index, "index1");
    assert.equal(WAE_BLOB_COLUMNS.blob20, "blob20");
    assert.equal(WAE_DOUBLE_COLUMNS.double20, "double20");
  });

  it("exposes all documented base columns on defined datasets", () => {
    const analytics = defineDataset({ name: "analytics", indexes: ["tenant"] });

    assert.equal(analytics.dataset.sql, "dataset");
    assert.equal(analytics.timestamp.sql, "timestamp");
    assert.equal(analytics.sampleInterval.sql, "_sample_interval");
    assert.equal(analytics.indexes.tenant.sql, "index1");
  });

  it("accepts Cloudflare's maximum of exactly 20 blobs and 20 doubles", () => {
    const blobs = Array.from({ length: 20 }, (_, i) => `blob_${i + 1}`);
    const doubles = Array.from({ length: 20 }, (_, i) => `double_${i + 1}`);
    const analytics = defineDataset({ name: "analytics", blobs, doubles });

    assert.equal(analytics.blobs.blob_1.sql, "blob1");
    assert.equal(analytics.blobs.blob_20.sql, "blob20");
    assert.equal(analytics.doubles.double_1.sql, "double1");
    assert.equal(analytics.doubles.double_20.sql, "double20");
  });

  it("places maximum-slot datapoint values in documented blob20 and double20 positions", () => {
    const blobs = Array.from({ length: 20 }, (_, i) => `blob_${i + 1}`);
    const doubles = Array.from({ length: 20 }, (_, i) => `double_${i + 1}`);
    const analytics = defineDataset({ name: "analytics", blobs, doubles });

    const point = analytics.dataPoint({
      blobs: Object.fromEntries(blobs.map((name, i) => [name, `b${i + 1}`])),
      doubles: Object.fromEntries(doubles.map((name, i) => [name, i + 1])),
      indexes: {},
    });

    assert.equal(point.blobs.length, 20);
    assert.equal(point.doubles.length, 20);
    assert.equal(point.blobs[19], "b20");
    assert.equal(point.doubles[19], 20);
  });

  it("builds Cloudflare's sampled count query pattern", () => {
    const temperatures = defineDataset({
      name: "temperatures",
      indexes: ["location_id"],
    });

    assert.equal(temperatures
      .select({
        location_id: temperatures.indexes.location_id,
        n_readings: sampledCount(temperatures.sampleInterval),
      })
      .where(gt(temperatures.timestamp, intervalAgo(7, "DAY")))
      .groupBy(temperatures.indexes.location_id)
      .toSQL(), [
      "SELECT index1 AS location_id, SUM(_sample_interval) AS n_readings",
      "FROM temperatures",
      "WHERE timestamp > NOW() - INTERVAL '7' DAY",
      "GROUP BY index1",
      "FORMAT JSON",
    ].join("\n"));
  });

  it("builds Cloudflare's sampled average query pattern", () => {
    const temperatures = defineDataset({
      name: "temperatures",
      doubles: ["inside_temp"],
      indexes: ["location_id"],
    });

    assert.equal(temperatures
      .select({
        location_id: temperatures.indexes.location_id,
        average_temp: sampledAvg(temperatures.doubles.inside_temp, temperatures.sampleInterval),
      })
      .where(gt(temperatures.timestamp, intervalAgo(7, "DAY")))
      .groupBy(temperatures.indexes.location_id)
      .toSQL(), [
      "SELECT index1 AS location_id, SUM(double1 * _sample_interval) / SUM(_sample_interval) AS average_temp",
      "FROM temperatures",
      "WHERE timestamp > NOW() - INTERVAL '7' DAY",
      "GROUP BY index1",
      "FORMAT JSON",
    ].join("\n"));
  });

  it("builds weighted quantiles with WAE sample interval as weight", () => {
    const analytics = defineDataset({
      name: "analytics",
      doubles: ["latency"],
    });

    assert.equal(
      quantileExactWeighted(0.99, analytics.doubles.latency, analytics.sampleInterval).sql,
      "quantileExactWeighted(0.99)(double1, _sample_interval)",
    );
  });

  it("escapes quoted patterns in LIKE helpers", () => {
    assert.equal(like(col("blob1"), "can't%").sql, "blob1 LIKE 'can''t%'");
    assert.equal(ilike(col("blob1"), "O'Reilly%").sql, "blob1 ILIKE 'O''Reilly%'");
  });

  it("supports LIMIT 0", () => {
    const events = dataset("events", { status: "status" });

    assert.equal(events.select({ status: events.status }).limit(0).toSQL(), [
      "SELECT status AS status",
      "FROM events",
      "LIMIT 0",
      "FORMAT JSON",
    ].join("\n"));
  });

  it("rejects invalid interval amounts and units at runtime", () => {
    const timestamp = col("timestamp");

    assert.throws(() => intervalAgo(Number.NaN, "DAY"), /positive number/);
    assert.throws(() => intervalAgo(Infinity, "DAY"), /positive number/);
    assert.throws(() => intervalAgo(-1, "DAY"), /positive number/);
    assert.throws(() => intervalAgo(1, "WEEK"), /Invalid interval unit/);
    assert.throws(() => toStartOfInterval(timestamp, 1, "WEEK"), /Invalid interval unit/);
  });
});

describe("dataset-bound sampled helpers", () => {
  it("binds sampled count, sum, avg, and quantile to the dataset sample interval", () => {
    const analytics = defineDataset({
      name: "analytics",
      doubles: ["requests", "latency"],
    });

    assert.equal(analytics.sampled.count().sql, "SUM(_sample_interval)");
    assert.equal(analytics.sampled.sum(analytics.doubles.requests).sql, "SUM(double1 * _sample_interval)");
    assert.equal(
      analytics.sampled.avg(analytics.doubles.latency).sql,
      "SUM(double2 * _sample_interval) / SUM(_sample_interval)",
    );
    assert.equal(
      analytics.sampled.quantile(0.95, analytics.doubles.latency).sql,
      "quantileExactWeighted(0.95)(double2, _sample_interval)",
    );
  });

  it("uses dataset-bound sampled helpers in queries", () => {
    const analytics = defineDataset({
      name: "analytics",
      doubles: ["latency"],
      indexes: ["tenant"],
    });

    assert.equal(analytics
      .select({
        tenant: analytics.indexes.tenant,
        requests: analytics.sampled.count(),
        avg_latency: analytics.sampled.avg(analytics.doubles.latency),
      })
      .groupBy(analytics.indexes.tenant)
      .toSQL(), [
      "SELECT index1 AS tenant, SUM(_sample_interval) AS requests, SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avg_latency",
      "FROM analytics",
      "GROUP BY index1",
      "FORMAT JSON",
    ].join("\n"));
  });
});
