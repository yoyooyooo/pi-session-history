import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  normalizeTranscript,
  type NormalizedRecord,
  type TrajectoryListing,
} from "@letta-ai/trajectory";

export type HistoryScope = "all" | "cwd";

export interface HistoryProgress {
  scanned: number;
  total: number;
}

export interface HistorySession {
  id: string;
  path: string;
  updatedAt?: string;
  sizeBytes?: number;
  cwd?: string;
  title: string;
  recordCount: number;
  diagnosticCount: number;
}

export interface HistorySearchHit extends HistorySession {
  score: number;
  matchedRecordCount: number;
  excerpts: string[];
}

export interface HistorySearchResult {
  hits: HistorySearchHit[];
  scanned: number;
  skipped: number;
  available: number;
}

export interface HistoryListResult {
  sessions: HistorySession[];
  scanned: number;
  skipped: number;
  available: number;
}

export interface HistoryReadResult {
  session: HistorySession;
  text: string;
  offset: number;
  returnedRecords: number;
  totalRecords: number;
  hasMore: boolean;
  recordTruncated: boolean;
}

interface CommonOptions {
  root?: string;
  currentSessionPath?: string;
  includeCurrent?: boolean;
  scope?: HistoryScope;
  cwd?: string;
  scanLimit?: number;
  signal?: AbortSignal;
  onProgress?: (progress: HistoryProgress) => void;
}

export interface SearchHistoryOptions extends CommonOptions {
  query: string;
  limit?: number;
}

export interface ListHistoryOptions extends CommonOptions {
  limit?: number;
}

export interface ReadHistoryOptions extends CommonOptions {
  session: string;
  offset?: number;
  recordLimit?: number;
  maxCharacters?: number;
}

const DEFAULT_SCAN_LIMIT = 1000;
const MAX_SCAN_LIMIT = 5000;
const DEFAULT_RESULT_LIMIT = 10;
const MAX_RESULT_LIMIT = 50;
const DEFAULT_RECORD_LIMIT = 80;
const MAX_RECORD_LIMIT = 200;
const DEFAULT_MAX_CHARACTERS = 30_000;
export const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;
export const MAX_TOOL_OUTPUT_LINES = 2000;
const NORMALIZATION_CHUNK_BYTES = 1024 * 1024;

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizedPath(path: string | undefined): string | undefined {
  return path ? resolve(path) : undefined;
}

function resolveAgentDir(root?: string): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return root ?? (configured || join(homedir(), ".pi", "agent"));
}

async function* readTranscriptChunks(
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<{ transcript: string; baseByteOffset: number }> {
  const stream = createReadStream(path, {
    encoding: "utf8",
    ...(signal ? { signal } : {}),
  });
  let pending = "";
  let lines: string[] = [];
  let chunkBytes = 0;
  let baseByteOffset = 0;

  const flush = ():
    { transcript: string; baseByteOffset: number } | undefined => {
    if (lines.length === 0) return undefined;
    const transcript = lines.join("");
    const chunk = { transcript, baseByteOffset };
    baseByteOffset += chunkBytes;
    lines = [];
    chunkBytes = 0;
    return chunk;
  };

  for await (const value of stream) {
    checkAbort(signal);
    pending += value;
    while (true) {
      const newlineAt = pending.indexOf("\n");
      if (newlineAt < 0) break;
      const line = pending.slice(0, newlineAt + 1);
      pending = pending.slice(newlineAt + 1);
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (
        chunkBytes > 0 &&
        chunkBytes + lineBytes > NORMALIZATION_CHUNK_BYTES
      ) {
        const chunk = flush();
        if (chunk) yield chunk;
      }
      lines.push(line);
      chunkBytes += lineBytes;
    }
  }

  if (pending) {
    const lineBytes = Buffer.byteLength(pending, "utf8");
    if (chunkBytes > 0 && chunkBytes + lineBytes > NORMALIZATION_CHUNK_BYTES) {
      const chunk = flush();
      if (chunk) yield chunk;
    }
    lines.push(pending);
    chunkBytes += lineBytes;
  }
  const chunk = flush();
  if (chunk) yield chunk;
}

function isCurrentSession(
  listing: TrajectoryListing,
  currentSessionPath: string | undefined,
): boolean {
  const current = normalizedPath(currentSessionPath);
  return current !== undefined && resolve(listing.path) === current;
}

export async function listPiSessionFiles(
  options: Pick<CommonOptions, "root" | "scanLimit" | "signal"> = {},
): Promise<TrajectoryListing[]> {
  const scanLimit = clampInteger(
    options.scanLimit,
    DEFAULT_SCAN_LIMIT,
    1,
    MAX_SCAN_LIMIT,
  );
  const agentDir = resolveAgentDir(options.root);
  const sessionsDir = join(agentDir, "sessions");
  const items: TrajectoryListing[] = [];

  checkAbort(options.signal);
  let projectEntries: Dirent[];
  try {
    projectEntries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const project of projectEntries) {
    checkAbort(options.signal);
    if (!project.isDirectory()) continue;
    const projectDir = join(sessionsDir, project.name);
    let sessionEntries: Dirent[];
    try {
      sessionEntries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of sessionEntries) {
      checkAbort(options.signal);
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(projectDir, entry.name);
      try {
        const facts = await stat(path);
        items.push({
          id: basename(entry.name, ".jsonl"),
          path,
          updatedAt: facts.mtime.toISOString(),
          sizeBytes: facts.size,
        });
      } catch {
        // A concurrently moved session is simply absent from this snapshot.
      }
    }
  }

  return items
    .sort(
      (left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
        right.id.localeCompare(left.id),
    )
    .slice(0, scanLimit);
}

function contentText(record: NormalizedRecord): string {
  switch (record.role) {
    case "meta":
      return [record.cwd, record.git_branch, record.model]
        .filter(Boolean)
        .join(" ");
    case "user":
    case "reasoning":
      return record.content;
    case "assistant":
      if (record.content !== null) return record.content;
      return record.tool_calls
        .map((call) => `${call.name} ${call.args}`)
        .join("\n");
    case "tool":
      return record.content;
  }
}

function compactLine(value: string, maxLength = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function characterCount(value: string): number {
  return [...value].length;
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

function fitsToolOutput(
  value: string,
  limits: { maxCharacters: number; maxBytes: number; maxLines: number },
): boolean {
  return (
    characterCount(value) <= limits.maxCharacters &&
    Buffer.byteLength(value, "utf8") <= limits.maxBytes &&
    lineCount(value) <= limits.maxLines
  );
}

export function limitToolOutput(
  value: string,
  options: {
    maxCharacters?: number;
    maxBytes?: number;
    maxLines?: number;
    marker?: string;
  } = {},
): { text: string; truncated: boolean } {
  const limits = {
    maxCharacters: options.maxCharacters ?? Number.MAX_SAFE_INTEGER,
    maxBytes: options.maxBytes ?? MAX_TOOL_OUTPUT_BYTES,
    maxLines: options.maxLines ?? MAX_TOOL_OUTPUT_LINES,
  };
  if (fitsToolOutput(value, limits)) return { text: value, truncated: false };

  const requestedMarker = options.marker ?? "\n… [output truncated]";
  let marker = requestedMarker;
  if (!fitsToolOutput(marker, limits)) {
    const markerCharacters = [...marker];
    let low = 0;
    let high = markerCharacters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fitsToolOutput(markerCharacters.slice(0, middle).join(""), limits))
        low = middle;
      else high = middle - 1;
    }
    marker = markerCharacters.slice(0, low).join("");
  }

  const characters = [...value];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${marker}`;
    if (fitsToolOutput(candidate, limits)) low = middle;
    else high = middle - 1;
  }
  return {
    text: `${characters.slice(0, low).join("")}${marker}`,
    truncated: true,
  };
}

interface TranscriptFacts {
  sessionId?: string;
  cwd?: string;
  sessionName?: string;
  hasMessages: boolean;
  malformedRows: number;
}

function transcriptFacts(transcript: string): TranscriptFacts {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let sessionName: string | undefined;
  let hasMessages = false;
  let malformedRows = 0;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: unknown;
        id?: unknown;
        cwd?: unknown;
        name?: unknown;
      };
      if (entry.type === "session") {
        if (typeof entry.id === "string" && entry.id) sessionId = entry.id;
        if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
      } else if (
        entry.type === "session_info" &&
        typeof entry.name === "string" &&
        entry.name.trim()
      ) {
        sessionName = entry.name.trim();
      } else if (entry.type === "message") {
        hasMessages = true;
      }
    } catch {
      malformedRows += 1;
    }
  }
  return { sessionId, cwd, sessionName, hasMessages, malformedRows };
}

function normalizePiTranscript(
  transcript: string,
  sourceContext: { partial: true; baseByteOffset: number; groupId?: string },
): ReturnType<typeof normalizeTranscript> {
  // trajectory's OpenClaw adapter consumes Pi's SessionManager JSONL format.
  return normalizeTranscript({
    source: "openclaw",
    transcript,
    sourceContext,
  });
}

async function scanSession(
  listing: TrajectoryListing,
  signal?: AbortSignal,
  onRecord?: (record: NormalizedRecord, index: number) => void,
): Promise<HistorySession> {
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let sessionName: string | undefined;
  let firstUser: string | undefined;
  let recordCount = 0;
  let diagnosticCount = 0;

  for await (const chunk of readTranscriptChunks(listing.path, signal)) {
    const facts = transcriptFacts(chunk.transcript);
    sessionId ??= facts.sessionId;
    cwd ??= facts.cwd;
    if (facts.sessionName) sessionName = facts.sessionName;
    if (!facts.hasMessages) {
      diagnosticCount += facts.malformedRows;
      continue;
    }
    const normalized = normalizePiTranscript(chunk.transcript, {
      partial: true,
      baseByteOffset: chunk.baseByteOffset,
      ...(sessionId ? { groupId: sessionId } : {}),
    });
    for (const record of normalized.records) {
      if (record.role === "meta") continue;
      if (firstUser === undefined && record.role === "user")
        firstUser = record.content;
      onRecord?.(record, recordCount);
      recordCount += 1;
    }
    diagnosticCount += normalized.diagnostics.length;
  }

  if (sessionId === undefined && recordCount === 0) {
    throw new Error(`Invalid Pi session transcript: ${listing.path}`);
  }

  return {
    id: listing.id,
    path: listing.path,
    ...(listing.updatedAt ? { updatedAt: listing.updatedAt } : {}),
    ...(listing.sizeBytes !== undefined
      ? { sizeBytes: listing.sizeBytes }
      : {}),
    ...(cwd ? { cwd } : {}),
    title: sessionName
      ? compactLine(sessionName, 100)
      : firstUser
        ? compactLine(firstUser, 100)
        : "(untitled session)",
    recordCount,
    diagnosticCount,
  };
}

function scopeMatches(
  session: HistorySession,
  scope: HistoryScope | undefined,
  cwd: string | undefined,
): boolean {
  if ((scope ?? "all") === "all") return true;
  if (!cwd || !session.cwd) return false;
  return resolve(session.cwd) === resolve(cwd);
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().split(/\s+/u).filter(Boolean))];
}

function excerptFor(text: string, terms: string[], maxLength = 280): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  const lower = compact.toLocaleLowerCase();
  const positions = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0);
  const matchAt = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, matchAt - Math.floor(maxLength / 3));
  const end = Math.min(compact.length, start + maxLength);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

function roleLabel(record: NormalizedRecord): string {
  if (record.role === "assistant" && record.content === null)
    return "assistant/tool-call";
  return record.role;
}

function recordTimestamp(record: NormalizedRecord): string | undefined {
  return record.role === "meta" ? undefined : record.timestamp;
}

async function searchSession(
  listing: TrajectoryListing,
  query: string,
  signal?: AbortSignal,
): Promise<HistorySearchHit | undefined> {
  const terms = queryTerms(query);
  if (terms.length === 0) return undefined;
  const exactQuery = query.trim().toLocaleLowerCase();
  const seenTerms = new Set<string>();
  const candidates: Array<{
    matchedTerms: number;
    user: boolean;
    index: number;
    excerpt: string;
  }> = [];
  let exactMatch = false;
  let recordScore = 0;
  let matchedRecordCount = 0;

  const session = await scanSession(listing, signal, (record, index) => {
    const text = contentText(record);
    const lower = text.toLocaleLowerCase();
    const matched = terms.filter((term) => lower.includes(term));
    for (const term of matched) seenTerms.add(term);
    if (exactQuery && lower.includes(exactQuery)) exactMatch = true;
    if (matched.length === 0) return;
    recordScore += matched.length;
    matchedRecordCount += 1;
    const timestamp = recordTimestamp(record);
    candidates.push({
      matchedTerms: matched.length,
      user: record.role === "user",
      index,
      excerpt: `${timestamp ? `[${timestamp}] ` : ""}${roleLabel(record)}: ${excerptFor(text, terms)}`,
    });
    candidates.sort(
      (left, right) =>
        right.matchedTerms - left.matchedTerms ||
        Number(right.user) - Number(left.user) ||
        left.index - right.index,
    );
    if (candidates.length > 3) candidates.length = 3;
  });

  const metadata = `${session.title} ${session.cwd ?? ""}`;
  const metadataLower = metadata.toLocaleLowerCase();
  for (const term of terms) {
    if (metadataLower.includes(term)) seenTerms.add(term);
  }
  if (exactQuery && metadataLower.includes(exactQuery)) exactMatch = true;
  if (!terms.every((term) => seenTerms.has(term))) return undefined;

  const excerpts = candidates.map((candidate) => candidate.excerpt);
  if (excerpts.length === 0)
    excerpts.push(`metadata: ${excerptFor(metadata, terms)}`);
  const titleBonus = terms.some((term) =>
    session.title.toLocaleLowerCase().includes(term),
  )
    ? 5
    : 0;
  return {
    ...session,
    score: recordScore + (exactMatch ? 20 : 0) + titleBonus,
    matchedRecordCount,
    excerpts,
  };
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new Error("Historical session operation cancelled.");
}

async function inspectListings<T>(
  listings: TrajectoryListing[],
  options: CommonOptions,
  inspect: (listing: TrajectoryListing) => Promise<T | undefined>,
  stopAfterValues?: number,
): Promise<{ values: T[]; scanned: number; skipped: number }> {
  const values: T[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const listing of listings) {
    checkAbort(options.signal);
    if (
      !options.includeCurrent &&
      isCurrentSession(listing, options.currentSessionPath)
    )
      continue;
    scanned += 1;
    try {
      const value = await inspect(listing);
      if (value !== undefined) values.push(value);
    } catch {
      if (options.signal?.aborted)
        throw new Error("Historical session operation cancelled.");
      skipped += 1;
    }
    if (stopAfterValues !== undefined && values.length >= stopAfterValues)
      break;
    if (scanned % 25 === 0) {
      options.onProgress?.({ scanned, total: listings.length });
    }
  }

  options.onProgress?.({ scanned, total: listings.length });
  return { values, scanned, skipped };
}

export async function searchHistoricalSessions(
  options: SearchHistoryOptions,
): Promise<HistorySearchResult> {
  if (!options.query.trim())
    throw new Error("query is required for historical session search.");
  const listings = await listPiSessionFiles(options);
  const inspected = await inspectListings(
    listings,
    options,
    async (listing) => {
      const hit = await searchSession(listing, options.query, options.signal);
      return hit && scopeMatches(hit, options.scope, options.cwd)
        ? hit
        : undefined;
    },
  );
  const limit = clampInteger(
    options.limit,
    DEFAULT_RESULT_LIMIT,
    1,
    MAX_RESULT_LIMIT,
  );
  const hits = inspected.values
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
    })
    .slice(0, limit);
  return {
    hits,
    scanned: inspected.scanned,
    skipped: inspected.skipped,
    available: listings.length,
  };
}

export async function listHistoricalSessions(
  options: ListHistoryOptions = {},
): Promise<HistoryListResult> {
  const listings = await listPiSessionFiles(options);
  const limit = clampInteger(
    options.limit,
    DEFAULT_RESULT_LIMIT,
    1,
    MAX_RESULT_LIMIT,
  );
  const inspected = await inspectListings(
    listings,
    options,
    async (listing) => {
      const session = await scanSession(listing, options.signal);
      return scopeMatches(session, options.scope, options.cwd)
        ? session
        : undefined;
    },
    limit,
  );
  return {
    sessions: inspected.values.slice(0, limit),
    scanned: inspected.scanned,
    skipped: inspected.skipped,
    available: listings.length,
  };
}

async function resolveExactHistoricalPath(
  options: ReadHistoryOptions,
): Promise<TrajectoryListing | undefined> {
  if (!options.session.endsWith(".jsonl")) return undefined;
  const requested = resolve(options.session);
  const sessionsRoot = join(resolveAgentDir(options.root), "sessions");
  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(sessionsRoot),
      realpath(requested),
    ]);
  } catch {
    return undefined;
  }
  const fromRoot = relative(canonicalRoot, canonicalPath);
  if (
    !fromRoot ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    fromRoot === ".." ||
    isAbsolute(fromRoot)
  ) {
    return undefined;
  }
  const facts = await stat(canonicalPath);
  if (!facts.isFile()) return undefined;
  return {
    id: basename(canonicalPath, ".jsonl"),
    path: canonicalPath,
    updatedAt: facts.mtime.toISOString(),
    sizeBytes: facts.size,
  };
}

async function resolveHistoricalSession(
  options: ReadHistoryOptions,
): Promise<TrajectoryListing> {
  const exact = await resolveExactHistoricalPath(options);
  if (exact) {
    if (
      !options.includeCurrent &&
      isCurrentSession(exact, options.currentSessionPath)
    ) {
      throw new Error(`Historical Pi session not found: ${options.session}`);
    }
    return exact;
  }

  const listings = await listPiSessionFiles(options);
  const candidates = listings.filter((listing) => {
    if (
      !options.includeCurrent &&
      isCurrentSession(listing, options.currentSessionPath)
    )
      return false;
    return (
      listing.id === options.session ||
      resolve(listing.path) === resolve(options.session)
    );
  });
  if (candidates.length === 0) {
    throw new Error(`Historical Pi session not found: ${options.session}`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Session id is ambiguous; use an exact path instead: ${options.session}`,
    );
  }
  return candidates[0]!;
}

function formatRecord(record: NormalizedRecord): string {
  const timestamp = recordTimestamp(record);
  const header = `${timestamp ? `[${timestamp}] ` : ""}${roleLabel(record)}`;
  if (record.role === "assistant" && record.content === null) {
    const calls = record.tool_calls
      .map((call) => `${call.name}(${call.args})`)
      .join("\n");
    return `${header}\n${calls}`;
  }
  return `${header}\n${contentText(record)}`;
}

function formatReadText(
  header: string,
  offset: number,
  totalRecords: number,
  formattedRecords: string[],
): string {
  const range =
    formattedRecords.length > 0
      ? `${offset}-${offset + formattedRecords.length - 1}`
      : "none";
  return [
    header,
    `records: ${range} of ${totalRecords}`,
    "",
    formattedRecords.join("\n\n"),
  ].join("\n");
}

export async function readHistoricalSession(
  options: ReadHistoryOptions,
): Promise<HistoryReadResult> {
  const listing = await resolveHistoricalSession(options);
  checkAbort(options.signal);
  const requestedOffset = clampInteger(
    options.offset,
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const recordLimit = clampInteger(
    options.recordLimit,
    DEFAULT_RECORD_LIMIT,
    1,
    MAX_RECORD_LIMIT,
  );
  const selectedRecords: NormalizedRecord[] = [];
  const session = await scanSession(
    listing,
    options.signal,
    (record, index) => {
      if (index >= requestedOffset && selectedRecords.length < recordLimit)
        selectedRecords.push(record);
    },
  );
  if (!scopeMatches(session, options.scope, options.cwd)) {
    throw new Error(
      `Session is outside the requested ${options.scope ?? "all"} scope: ${options.session}`,
    );
  }

  const offset = Math.min(requestedOffset, session.recordCount);
  const maxCharacters = clampInteger(
    options.maxCharacters,
    DEFAULT_MAX_CHARACTERS,
    1000,
    50_000,
  );
  const header = [
    `session: ${session.id}`,
    `path: ${session.path}`,
    `cwd: ${session.cwd ?? "unknown"}`,
    `title: ${session.title}`,
  ].join("\n");
  const formatted: string[] = [];
  let recordTruncated = false;
  let text: string | undefined;

  for (const record of selectedRecords) {
    const recordText = formatRecord(record);
    const candidate = [...formatted, recordText];
    const candidateText = formatReadText(
      header,
      offset,
      session.recordCount,
      candidate,
    );
    const bounded = limitToolOutput(candidateText, { maxCharacters });
    if (!bounded.truncated) {
      formatted.push(recordText);
      text = bounded.text;
      continue;
    }
    if (formatted.length === 0) {
      text = limitToolOutput(candidateText, {
        maxCharacters,
        marker:
          "\n… [record truncated; retry this offset with a larger maxCharacters value]",
      }).text;
      formatted.push(recordText);
      recordTruncated = true;
    }
    break;
  }

  const returnedRecords = formatted.length;
  text ??= limitToolOutput(
    formatReadText(header, offset, session.recordCount, formatted),
    { maxCharacters },
  ).text;

  return {
    session,
    text,
    offset,
    returnedRecords,
    totalRecords: session.recordCount,
    hasMore: offset + returnedRecords < session.recordCount,
    recordTruncated,
  };
}
