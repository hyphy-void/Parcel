#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareAPI } from "./deploy-v3.mjs";

const tables = ["uploads", "shares", "share_grants", "download_sessions"];
export function manifest(raw) {
  if (Buffer.byteLength(raw) > 64 << 20)
    throw new Error("Snapshot exceeds 64 MiB import limit");
  const envelope = JSON.parse(raw);
  if (
    typeof envelope.payload !== "string" ||
    createHash("sha256").update(envelope.payload).digest("hex") !==
      envelope.sha256
  )
    throw new Error("Snapshot checksum mismatch");
  const data = JSON.parse(envelope.payload);
  if (
    data.format !== 1 ||
    data.source !== "go-sqlite-schema3" ||
    !data.bucket ||
    !data.rows ||
    !tables.every((k) => Array.isArray(data.rows[k]))
  )
    throw new Error("Unsupported snapshot format");
  if (Object.keys(data.rows).some((k) => !tables.includes(k)))
    throw new Error("Unexpected snapshot table");
  if (
    data.rows.uploads.some((u) => !["completed", "cleaned"].includes(u.state))
  )
    throw new Error("Snapshot contains unfinished uploads");
  return { ...data, fingerprint: envelope.sha256 };
}
export async function importSnapshot(data, query) {
  const q = async (sql, params = []) => (await query([{ sql, params }]))[0];
  await q(
    "CREATE TABLE IF NOT EXISTS parcel_import(id INTEGER PRIMARY KEY CHECK(id=1),fingerprint TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0)",
  );
  const marker = (await q("SELECT * FROM parcel_import WHERE id=1")).results[0];
  if (marker && marker.fingerprint !== data.fingerprint)
    throw new Error(
      "D1 contains another import; refusing to merge authorities",
    );
  if (!marker) {
    const counts = await query(
      tables.map((table) => ({
        sql: `SELECT count(*) AS n FROM ${table}`,
        params: [],
      })),
    );
    if (counts.some((r) => r.results[0].n))
      throw new Error(
        "Target must be empty or contain the same resumable import",
      );
    await q("INSERT INTO parcel_import(id,fingerprint) VALUES(1,?)", [
      data.fingerprint,
    ]);
  }
  await q("UPDATE parcel_import SET complete=0 WHERE id=1 AND fingerprint=?", [
    data.fingerprint,
  ]);
  // Resuming uses the same immutable snapshot. Existing rows must match below;
  // INSERT OR IGNORE never overwrites writes made after a mistaken activation.
  for (const table of tables) {
    const columns = (await q(`PRAGMA table_info(${table})`)).results.map(
      (r) => r.name,
    );
    for (let offset = 0; offset < data.rows[table].length; offset += 100) {
      const queries = data.rows[table]
        .slice(offset, offset + 100)
        .map((row) => {
          const keys = Object.keys(row);
          if (!keys.length || keys.some((k) => !columns.includes(k)))
            throw new Error("Unexpected snapshot column");
          return {
            sql: `INSERT OR IGNORE INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
            params: keys.map((k) => row[k]),
          };
        });
      await query(queries);
    }
    const count = (await q(`SELECT count(*) AS n FROM ${table}`)).results[0].n;
    if (count !== data.rows[table].length)
      throw new Error(`Import count mismatch: ${table}`);
    const actual = [];
    for (let offset = 0; offset < count; offset += 100)
      actual.push(
        ...(
          await q(`SELECT * FROM ${table} ORDER BY 1 LIMIT 100 OFFSET ?`, [
            offset,
          ])
        ).results,
      );
    const primary =
        table === "uploads" || table === "shares" ? "id" : "token_hash",
      byId = new Map(actual.map((row) => [row[primary], row]));
    for (const expected of data.rows[table]) {
      const row = byId.get(expected[primary]);
      if (!row || Object.entries(expected).some(([k, v]) => row[k] !== v))
        throw new Error(
          `Import content mismatch: ${table}; target remains in maintenance`,
        );
    }
  }
  const usage = (await q("SELECT used,reserved FROM storage_usage WHERE id=1"))
    .results[0];
  if (usage.used !== data.usage.used || usage.reserved !== data.usage.reserved)
    throw new Error("Quota ledger mismatch");
  await q("UPDATE parcel_import SET complete=1 WHERE id=1 AND fingerprint=?", [
    data.fingerprint,
  ]);
  return {
    fingerprint: data.fingerprint,
    counts: Object.fromEntries(tables.map((t) => [t, data.rows[t].length])),
    usage,
  };
}
async function main() {
  const [path, configPath, confirmation] = process.argv.slice(2);
  if (!path || !configPath || confirmation !== "--writers-frozen")
    throw new Error(
      "Usage: import-v3.mjs SNAPSHOT GENERATED_WRANGLER_CONFIG --writers-frozen",
    );
  const data = manifest(await readFile(path, "utf8")),
    config = JSON.parse(await readFile(configPath, "utf8"));
  if (
    config.vars.ACTIVE !== "false" ||
    config.r2_buckets?.[0]?.bucket_name !== data.bucket
  )
    throw new Error(
      "Import requires a maintenance Worker bound to the source bucket",
    );
  if (!process.env.CLOUDFLARE_API_TOKEN)
    throw new Error("Set CLOUDFLARE_API_TOKEN locally");
  const api = new CloudflareAPI(
    config.account_id,
    process.env.CLOUDFLARE_API_TOKEN,
  );
  const settings = await api.request(
    `/workers/scripts/${config.name}/settings`,
  );
  if (
    !settings.bindings?.some(
      (b) =>
        b.name === "ACTIVE" && b.type === "plain_text" && b.text === "false",
    )
  )
    throw new Error("Remote Worker is not in maintenance; import refused");
  const result = await importSnapshot(data, async (queries) => {
    const results = await api.request(
      `/d1/database/${config.d1_databases[0].database_id}/query`,
      "POST",
      { batch: queries },
    );
    if (!Array.isArray(results) || results.some((r) => !r.success))
      throw new Error(
        "D1 import transaction failed; resume the same snapshot while in maintenance",
      );
    return results;
  });
  console.log(JSON.stringify(result));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
