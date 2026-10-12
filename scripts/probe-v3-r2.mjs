import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { AwsClient } from "../cloudflare/node_modules/aws4fetch/dist/aws4fetch.esm.mjs";
import { XMLParser } from "../cloudflare/node_modules/fast-xml-parser/src/fxp.js";
import { R2Store, PART_BYTES } from "../cloudflare/v3/r2.mjs";
import { loadCredentials } from "./v3-credentials.mjs";

// Explicit opt-in: this performs real S3 requests and creates a temporary object.
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const endpoint = value("--endpoint"),
  bucket = value("--bucket");
if (
  !args.includes("--live") ||
  !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(
    endpoint || "",
  ) ||
  !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || "")
) {
  console.error(
    "Usage: node scripts/probe-v3-r2.mjs --live --endpoint https://ACCOUNT.r2.cloudflarestorage.com --bucket BUCKET [--credentials-file PRIVATE_FILE] [--result PRIVATE_JSON]",
  );
  process.exit(2);
}
const path = value("--credentials-file");
let credentials;
try {
  credentials = await loadCredentials({
    path,
    allowLegacyR2: Boolean(path),
    required: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
  });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const accessKeyId = credentials.R2_ACCESS_KEY_ID,
  secretAccessKey = credentials.R2_SECRET_ACCESS_KEY;
const resultPath = value("--result");
// Create result file exclusively before any account mutation: never overwrite an existing secret.
let resultFile;
if (resultPath) {
  try {
    resultFile = fs.openSync(resultPath, "wx", 0o600);
  } catch {
    console.error("Result path must be a new file in an existing directory");
    process.exit(2);
  }
}
const id = randomUUID();
const key = `parcel/v3/probes/${id}`;
const base = `${endpoint}/${bucket}/${key}`;
const client = new AwsClient({
  accessKeyId,
  secretAccessKey,
  service: "s3",
  region: "auto",
  retries: 0,
});
const store = new R2Store({
  R2_ENDPOINT: endpoint,
  R2_BUCKET_NAME: bucket,
  R2_ACCESS_KEY_ID: accessKeyId,
  R2_SECRET_ACCESS_KEY: secretAccessKey,
});
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });
const result = {
  at: new Date().toISOString(),
  bucket,
  partBytes: PART_BYTES,
  nativeWorkerBindingTested: false,
  checks: [],
};
let multipartId, failure;
function pass(check) {
  result.checks.push(check);
  console.log(`PASS ${check}`);
}
async function control(method, query = {}, body, headers = {}) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const signed = await client.sign(url, { method, headers, body });
  return fetch(signed, {
    redirect: "manual",
    signal: AbortSignal.timeout(90000),
  });
}
try {
  const created = await control("POST", { uploads: "" }, undefined, {
    "x-amz-meta-parcel-upload": id,
    "Content-Type": "application/octet-stream",
  });
  assert.equal(created.status, 200, "create multipart status");
  multipartId = parser.parse(await created.text()).InitiateMultipartUploadResult
    ?.UploadId;
  assert.ok(multipartId, "multipart ID");
  const upload = { id, storage_key: key, multipart_id: multipartId };
  const blocks = [
    Buffer.alloc(PART_BYTES, 0x37),
    Buffer.from([0x21, 0x43, 0x65]),
  ];
  const invalid = await fetch(await store.signPart(upload, 2, 3), {
    method: "PUT",
    body: Buffer.alloc(2),
    signal: AbortSignal.timeout(20000),
  });
  const invalidCode = parser.parse(await invalid.text()).Error?.Code;
  assert.equal(invalid.status, 403, "wrong size must fail");
  assert.equal(
    invalidCode,
    "SignatureDoesNotMatch",
    "wrong size signature check",
  );
  pass("R2 rejects a multipart URL reused with the wrong Content-Length");
  for (const [index, block] of blocks.entries()) {
    const response = await fetch(
      await store.signPart(upload, index + 1, block.length),
      { method: "PUT", body: block, signal: AbortSignal.timeout(125000) },
    );
    assert.equal(response.status, 200, `part ${index + 1} status`);
    await response.body?.cancel();
    pass(`live signed part ${index + 1}: ${block.length} bytes`);
  }
  const parts = await store.parts(upload);
  assert.deepEqual(
    parts.map(({ number, size }) => ({ number, size })),
    [
      { number: 1, size: PART_BYTES },
      { number: 2, size: 3 },
    ],
  );
  pass("production ListParts parser confirms both sizes and ETags");
  const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.number}</PartNumber><ETag>${p.etag.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  const completed = await control("POST", { uploadId: multipartId }, xml, {
    "Content-Type": "application/xml",
  });
  assert.equal(completed.status, 200, "complete status");
  assert.ok(
    parser.parse(await completed.text()).CompleteMultipartUploadResult,
    "complete response",
  );
  pass("live multipart completion");
  const download = await fetch(
    await store.signGet({ storage_key: key, name: "V3分块签名验证.bin" }),
    { signal: AbortSignal.timeout(90000) },
  );
  assert.equal(download.status, 200, "download status");
  assert.match(
    download.headers.get("Content-Disposition"),
    /filename\*=UTF-8''/,
  );
  assert.match(download.headers.get("Cache-Control"), /no-store/);
  const bytes = Buffer.from(await download.arrayBuffer());
  const digest = (v) => createHash("sha256").update(v).digest("hex");
  assert.equal(bytes.length, PART_BYTES + 3);
  assert.equal(digest(bytes), digest(Buffer.concat(blocks)));
  result.bytes = bytes.length;
  result.sha256 = digest(bytes);
  pass(
    "signed download preserves Unicode filename, no-store, size and SHA-256",
  );
} catch {
  failure = true;
  console.error(
    "FAIL live R2 probe (details withheld to protect signed URLs and credentials)",
  );
} finally {
  try {
    if (multipartId) {
      const aborted = await control("DELETE", { uploadId: multipartId });
      assert.ok([204, 404].includes(aborted.status), "abort cleanup status");
      await aborted.body?.cancel();
    }
    const deleted = await control("DELETE");
    assert.equal(deleted.status, 204, "delete cleanup status");
    await deleted.body?.cancel();
    const head = await control("HEAD");
    assert.equal(head.status, 404, "object absent after cleanup");
    await head.body?.cancel();
    result.cleaned = true;
    pass("temporary multipart upload and object removed; HEAD confirms 404");
  } catch {
    failure = true;
    result.cleaned = false;
    console.error(`FAIL cleanup needs retry for temporary key ${key}`);
  }
  result.passed = !failure;
  if (resultFile !== undefined) {
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + "\n");
    fs.closeSync(resultFile);
  }
}
if (failure) process.exitCode = 1;
