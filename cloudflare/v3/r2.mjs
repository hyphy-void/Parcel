import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";

// Cache only derived signing keys in isolate memory; aws4fetch includes the
// credential secret and UTC date in each cache key. Bound retained entries.
const signingCache = new Map();
export const PART_BYTES = 16 << 20,
  URL_TTL = 300;
export class R2Unavailable extends Error {
  constructor(notFound = false) {
    super("R2 暂时不可用，请稍后重试");
    this.notFound = notFound;
  }
}
export class R2Store {
  constructor(
    env,
    now = () => Math.floor(Date.now() / 1000),
    outbound = (...args) => fetch(...args),
  ) {
    this.env = env;
    this.now = now;
    this.fetch = outbound;
    if (signingCache.size > 4) signingCache.clear();
    this.signer = new AwsClient({
      cache: signingCache,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    });
  }
  async sign(method, key, query = {}, headers = {}) {
    const path = key.split("/").map(encodeURIComponent).join("/");
    const url = new URL(
      `${this.env.R2_ENDPOINT}/${encodeURIComponent(this.env.R2_BUCKET_NAME)}/${path}`,
    );
    for (const [k, v] of Object.entries(query))
      url.searchParams.set(k, String(v));
    url.searchParams.set("X-Amz-Expires", String(URL_TTL));
    // Include browser-generated Content-Length for multipart PUTs. A different
    // size cannot reuse the signature, and no file content goes through Worker.
    const signed = await this.signer.sign(url, {
      method,
      headers,
      aws: {
        signQuery: true,
        allHeaders: true,
        datetime: new Date(this.now() * 1000)
          .toISOString()
          .replace(/[:-]|\.\d{3}/g, ""),
      },
    });
    return signed.url;
  }
  signPart(u, n, size) {
    return this.sign(
      "PUT",
      u.storage_key,
      { uploadId: u.multipart_id, partNumber: n },
      { "Content-Length": String(size) },
    );
  }
  signGet(s) {
    return this.sign("GET", s.storage_key, {
      "response-content-disposition": 'attachment; filename="encrypted.parcel"',
      "response-content-type": "application/octet-stream",
      "response-cache-control": "private, no-store",
    });
  }
  async create(u) {
    try {
      return (
        await this.env.FILES.createMultipartUpload(u.storage_key, {
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: { "parcel-upload": u.id },
        })
      ).uploadId;
    } catch {
      throw new R2Unavailable();
    }
  }
  async parts(u) {
    const parts = [];
    let marker = 0;
    for (let page = 0; page < 10; page++) {
      let response;
      try {
        response = await this.fetch(
          await this.sign("GET", u.storage_key, {
            uploadId: u.multipart_id,
            "max-parts": 1000,
            ...(marker ? { "part-number-marker": marker } : {}),
          }),
          { signal: AbortSignal.timeout(20000), redirect: "manual" },
        );
      } catch {
        throw new R2Unavailable();
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new R2Unavailable(response.status === 404);
      }
      const reader = response.body.getReader();
      let length = 0;
      const chunks = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 2 << 20) throw new R2Unavailable();
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const xml = new TextDecoder().decode(bytes);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new R2Unavailable();
      let result;
      try {
        result = new XMLParser({
          ignoreAttributes: true,
          removeNSPrefix: true,
          parseTagValue: false,
        }).parse(xml).ListPartsResult;
      } catch {
        throw new R2Unavailable();
      }
      if (
        !result ||
        (!Array.isArray(result.Part) &&
          result.Part != null &&
          typeof result.Part !== "object")
      )
        throw new R2Unavailable();
      const entries =
        result.Part == null
          ? []
          : Array.isArray(result.Part)
            ? result.Part
            : [result.Part];
      for (const p of entries) {
        const number = Number(p.PartNumber),
          size = Number(p.Size);
        if (
          !Number.isSafeInteger(number) ||
          number < 1 ||
          number > 10000 ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          typeof p.ETag !== "string" ||
          !p.ETag ||
          p.ETag.length > 256
        )
          throw new R2Unavailable();
        if (number <= (parts.at(-1)?.number || 0)) throw new R2Unavailable();
        parts.push({ number, size, etag: p.ETag });
      }
      if (result.IsTruncated === "false") return parts;
      const next = Number(result.NextPartNumberMarker);
      if (
        result.IsTruncated !== "true" ||
        !Number.isSafeInteger(next) ||
        next <= marker
      )
        throw new R2Unavailable();
      marker = next;
    }
    throw new R2Unavailable();
  }
  async head(key) {
    try {
      return await this.env.FILES.head(key);
    } catch {
      throw new R2Unavailable();
    }
  }
  async complete(u, parts) {
    try {
      await this.env.FILES.resumeMultipartUpload(
        u.storage_key,
        u.multipart_id,
      ).complete(
        parts.map((p) => ({
          partNumber: p.number,
          etag: p.etag.replace(/^"(.*)"$/, "$1"),
        })),
      );
    } catch {
      throw new R2Unavailable();
    }
  }
  async abort(u) {
    if (!u.multipart_id) return;
    try {
      await this.env.FILES.resumeMultipartUpload(
        u.storage_key,
        u.multipart_id,
      ).abort();
    } catch {
      // R2 binding abort can report a missing upload after a previous abort.
      try {
        await this.parts(u);
      } catch (e) {
        if (e.notFound) return;
      }
      throw new R2Unavailable();
    }
  }
  async delete(key) {
    try {
      await this.env.FILES.delete(key);
    } catch {
      throw new R2Unavailable();
    }
  }
}
