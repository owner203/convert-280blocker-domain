#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const SOURCE_TIME_ZONE = "Asia/Tokyo";
const SOURCE_BASE_URL = "https://280blocker.net/files/";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
// The dashboard counts the CSV header against its 1,000-row upload limit.
const CHUNK_SIZE = 999;
const MAX_CSV_BYTES = 2 * 1024 * 1024;

function currentYearMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SOURCE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}${values.month}`;
}

async function downloadSource(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "text/plain" },
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Failed to download ${url}: ${error.message}`, { cause: error });
  }

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  if (new URL(response.url).protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS redirect target: ${response.url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/plain(?:;|$)/i.test(contentType)) {
    throw new Error(`Unexpected Content-Type from ${response.url}: ${contentType || "missing"}`);
  }

  const declaredBytes = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_SOURCE_BYTES) {
    throw new Error(`Downloaded source exceeds ${MAX_SOURCE_BYTES} bytes`);
  }

  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length === 0) throw new Error(`Downloaded source is empty: ${response.url}`);
  if (raw.length > MAX_SOURCE_BYTES) {
    throw new Error(`Downloaded source exceeds ${MAX_SOURCE_BYTES} bytes`);
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/^\uFEFF/, "");
  } catch (error) {
    throw new Error(`Downloaded source is not valid UTF-8: ${response.url}`, { cause: error });
  }

  return {
    text,
    metadata: {
      effectiveUrl: response.url,
      contentType,
      bytes: raw.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    },
  };
}

const sourceMonth = currentYearMonth();
const sourceName = `280blocker_domain_${sourceMonth}.txt`;
const sourceUrl = new URL(sourceName, SOURCE_BASE_URL).href;
const outputDir = resolve(process.argv[2] ?? `cloudflare-280blocker-domain-${sourceMonth}`);
const outputPrefix = sourceName.replace(/\.txt$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "-");

function normalizeDomain(value) {
  const candidate = value.trim().replace(/\.$/, "").toLowerCase();
  const ascii = domainToASCII(candidate);

  if (!ascii) return { reason: "invalid IDNA domain" };
  if (isIP(ascii)) return { reason: `IPv${isIP(ascii)} address` };
  if (ascii.length > 253) return { reason: "domain exceeds 253 characters" };

  const labels = ascii.split(".");
  if (labels.length < 2) return { reason: "domain has no dot" };
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return { reason: "invalid hostname label" };
  }

  return { domain: ascii };
}

const download = await downloadSource(sourceUrl);
const source = download.text;
const sourceHeader = source.slice(0, 2_048);
if (!sourceHeader.includes("# 280blocker domain filter")) {
  throw new Error(`Downloaded file does not contain the expected 280blocker header: ${sourceUrl}`);
}
const lastUpdateMatch = sourceHeader.match(/^# Lastupdate:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
if (!lastUpdateMatch) {
  throw new Error(`Downloaded file does not contain a valid Lastupdate header: ${sourceUrl}`);
}
const sourceLastUpdate = lastUpdateMatch[1];
const sourceLastUpdateDate = new Date(`${sourceLastUpdate}T00:00:00Z`);
if (
  Number.isNaN(sourceLastUpdateDate.getTime()) ||
  sourceLastUpdateDate.toISOString().slice(0, 10) !== sourceLastUpdate
) {
  throw new Error(`Downloaded file contains an invalid Lastupdate date: ${sourceLastUpdate}`);
}

const lines = source.split(/\r?\n/);
const domains = [];
const seen = new Set();
const skipped = [];
let commentLines = 0;
let blankLines = 0;
let duplicatesRemoved = 0;

for (const [index, originalLine] of lines.entries()) {
  const value = originalLine.trim();
  if (!value) {
    blankLines += 1;
    continue;
  }
  if (value.startsWith("#")) {
    commentLines += 1;
    continue;
  }

  const normalized = normalizeDomain(value);
  if (!normalized.domain) {
    skipped.push({ line: index + 1, value, reason: normalized.reason });
    continue;
  }
  if (seen.has(normalized.domain)) {
    duplicatesRemoved += 1;
    continue;
  }

  seen.add(normalized.domain);
  domains.push(normalized.domain);
}

if (domains.length === 0) {
  throw new Error(`No valid domains found in ${sourceName}`);
}
if (domains.length < 1_000) {
  throw new Error(`Downloaded source contains only ${domains.length} valid domains`);
}

const missingTestDomains = ["domain.dummy280280.net", "check.dummy280280.net"].filter(
  (domain) => !seen.has(domain),
);
if (missingTestDomains.length > 0) {
  throw new Error(`Downloaded source is missing test domains: ${missingTestDomains.join(", ")}`);
}

const invalidSkipped = skipped.filter(({ reason }) => !/^IPv[46] address$/.test(reason));
if (invalidSkipped.length > 0) {
  const first = invalidSkipped[0];
  throw new Error(`Unexpected source entry at line ${first.line}: ${first.value} (${first.reason})`);
}

const generatedChunks = [];

for (let offset = 0; offset < domains.length; offset += CHUNK_SIZE) {
  const items = domains.slice(offset, offset + CHUNK_SIZE);
  const sequence = String(generatedChunks.length + 1).padStart(3, "0");
  const file = `${outputPrefix}_cloudflare_${sequence}.csv`;
  const rows = ["value", ...items];
  const csv = `${rows.join("\n")}\n`;
  const bytes = Buffer.byteLength(csv);

  if (items.length > CHUNK_SIZE) throw new Error(`${file} exceeds ${CHUNK_SIZE} entries`);
  if (bytes >= MAX_CSV_BYTES) throw new Error(`${file} is not smaller than 2 MB`);

  generatedChunks.push({ file, entries: items.length, bytes, csv });
}

await mkdir(outputDir, { recursive: true });
await Promise.all(
  generatedChunks.map(({ file, csv }) => writeFile(join(outputDir, file), csv, "utf8")),
);

const expectedFiles = new Set(generatedChunks.map(({ file }) => file));
const chunkFilePattern = new RegExp(`^${outputPrefix}_cloudflare_\\d{3}\\.csv$`);
const staleChunkFiles = (await readdir(outputDir)).filter(
  (file) => chunkFilePattern.test(file) && !expectedFiles.has(file),
);
await Promise.all(staleChunkFiles.map((file) => unlink(join(outputDir, file))));

const chunks = generatedChunks.map(({ csv: _csv, ...chunk }) => chunk);

const report = {
  source: sourceName,
  sourceUrl,
  sourceMonth,
  sourceLastUpdate,
  sourceTimeZone: SOURCE_TIME_ZONE,
  download: download.metadata,
  listType: "DOMAIN",
  policySelector: "Domain",
  chunkSize: CHUNK_SIZE,
  validUniqueDomains: domains.length,
  duplicatesRemoved,
  commentLines,
  blankLines,
  skipped,
  staleChunkFilesRemoved: staleChunkFiles,
  chunks,
};

await writeFile(
  join(outputDir, "conversion-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify(report, null, 2));
