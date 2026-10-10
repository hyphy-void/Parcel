#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareAPI } from "./deploy-v3.mjs";
export async function exportSnapshot(config, api) {
  const settings = await api.request(
      `/workers/scripts/${config.name}/settings`,
    ),
    bindings = settings.bindings || [];
  const variable = (name) =>
    bindings.find((b) => b.name === name && b.type === "plain_text")?.text;
  if (variable("ACTIVE") !== "false")
    throw new Error("Freeze V3 requests and Cron before exporting authority");
  const now = Math.floor(Date.now() / 1000),
    since = Number(variable("MAINTENANCE_SINCE"));
  if (!Number.isSafeInteger(since) || since <= 0 || since > now - 960)
    throw new Error(
      "Wait 16 minutes after maintenance deployment so prior requests/Cron finish",
    );
  const query = async (sql, params = []) => {
    const result = await api.request(
      `/d1/database/${config.d1_databases[0].database_id}/query`,
      "POST",
      { sql, params },
    );
    if (!Array.isArray(result) || result.some((r) => !r.success))
      throw new Error("D1 snapshot query failed");
    return result[0].results;
  };
  const busy = await query(
    "SELECT count(*) AS n FROM uploads WHERE state NOT IN ('completed','cleaned') OR lease_until>?",
    [now],
  );
  if (busy[0].n)
    throw new Error(
      "Finish or cancel V3 uploads before maintenance; pending uploads cannot be rolled back",
    );
  if (
    (
      await query("SELECT count(*) AS n FROM shares WHERE lease_until>?", [now])
    )[0].n
  )
    throw new Error("Wait for cleanup leases to expire");
  const rows = {};
  for (const table of [
    "uploads",
    "shares",
    "share_grants",
    "download_sessions",
  ]) {
    rows[table] = [];
    const primary =
      table === "uploads" || table === "shares" ? "id" : "token_hash";
    for (let offset = 0; offset <= 100000; offset += 100) {
      const items = await query(
        `SELECT * FROM ${table} ORDER BY ${primary} LIMIT 100 OFFSET ?`,
        [offset],
      );
      rows[table].push(...items);
      if (items.length < 100) break;
      if (offset === 100000) throw new Error("Snapshot row limit exceeded");
    }
  }
  const [usage] = await query(
    "SELECT used,reserved FROM storage_usage WHERE id=1",
  );
  const payload = JSON.stringify({
    format: 1,
    source: "d1-v3",
    bucket: config.r2_buckets[0].bucket_name,
    exported: now,
    rows,
    usage: { used: usage.used, reserved: usage.reserved },
  });
  return {
    payload,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}
async function main() {
  const [configPath, output] = process.argv.slice(2);
  if (!configPath || !output)
    throw new Error("Usage: export-d1-v3.mjs GENERATED_WRANGLER_CONFIG OUTPUT");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!process.env.CLOUDFLARE_API_TOKEN)
    throw new Error("Set CLOUDFLARE_API_TOKEN locally");
  const envelope = await exportSnapshot(
    config,
    new CloudflareAPI(config.account_id, process.env.CLOUDFLARE_API_TOKEN),
  );
  await writeFile(output, JSON.stringify(envelope), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({ output, sha256: envelope.sha256 }));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
