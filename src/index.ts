import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  limitToolOutput,
  listHistoricalSessions,
  readHistoricalSession,
  searchHistoricalSessions,
  type HistoryListResult,
  type HistorySearchHit,
  type HistorySearchResult,
  type HistorySession,
} from "./history.ts";

const PiHistoryParameters = Type.Object({
  action: StringEnum(["list", "search", "read"] as const, {
    description:
      "list recent historical sessions, search their normalized contents, or read one transcript range",
  }),
  query: Type.Optional(
    Type.String({
      description:
        "Search query. Required for action=search; whitespace-separated terms use AND semantics.",
    }),
  ),
  session: Type.Optional(
    Type.String({
      description:
        "Session id or exact path returned by list/search. Required for action=read.",
    }),
  ),
  scope: Type.Optional(
    StringEnum(["all", "cwd"] as const, {
      description:
        "Search all Pi projects (default) or only sessions whose cwd equals the current Pi cwd.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: "Maximum list/search results (default 10).",
    }),
  ),
  scanLimit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5000,
      description: "Maximum newest sessions to inspect (default 1000).",
    }),
  ),
  includeCurrent: Type.Optional(
    Type.Boolean({
      description: "Include the active session file; defaults to false.",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Record offset for action=read (default 0).",
    }),
  ),
  recordLimit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 200,
      description: "Normalized records returned by action=read (default 80).",
    }),
  ),
  maxCharacters: Type.Optional(
    Type.Integer({
      minimum: 1000,
      maximum: 50000,
      description:
        "Maximum characters returned by action=read (default 30000).",
    }),
  ),
});

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function sessionHeader(session: HistorySession, index?: number): string[] {
  return [
    `${index === undefined ? "" : `${index}. `}${session.title}`,
    `   id: ${session.id}`,
    `   path: ${session.path}`,
    `   cwd: ${session.cwd ?? "unknown"}`,
    `   updated: ${session.updatedAt ?? "unknown"} | size: ${formatBytes(session.sizeBytes)} | records: ${session.recordCount}`,
  ];
}

export function formatHistoryList(result: HistoryListResult): string {
  if (result.sessions.length === 0) {
    return `No historical Pi sessions found. Scanned ${result.scanned}; skipped ${result.skipped}.`;
  }
  const text = [
    `Historical Pi sessions (${result.sessions.length} returned; ${result.scanned} scanned; ${result.skipped} skipped):`,
    "",
    ...result.sessions.flatMap((session, index) => [
      ...sessionHeader(session, index + 1),
      "",
    ]),
  ]
    .join("\n")
    .trimEnd();
  return limitToolOutput(text).text;
}

export function formatHistorySearch(
  result: HistorySearchResult,
  query: string,
): string {
  if (result.hits.length === 0) {
    return `No historical Pi sessions matched ${JSON.stringify(query)}. Scanned ${result.scanned}; skipped ${result.skipped}.`;
  }
  const text = [
    `Historical Pi search for ${JSON.stringify(query)} (${result.hits.length} returned; ${result.scanned} scanned; ${result.skipped} skipped):`,
    "",
    ...result.hits.flatMap((hit, index) => [
      ...sessionHeader(hit, index + 1),
      `   matched records: ${hit.matchedRecordCount}`,
      ...hit.excerpts.map((excerpt) => `   - ${excerpt}`),
      "",
    ]),
  ]
    .join("\n")
    .trimEnd();
  return limitToolOutput(text).text;
}

function selectionLabel(
  hit: HistorySearchHit | HistorySession,
  index: number,
): string {
  const date = hit.updatedAt?.slice(0, 10) ?? "unknown-date";
  const cwd = hit.cwd ?? "unknown cwd";
  const title =
    hit.title.length > 72 ? `${hit.title.slice(0, 71)}…` : hit.title;
  return `${index + 1}. ${date} | ${title} | ${cwd}`;
}

export default function piSessionHistory(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pi_history",
    label: "Pi Session History",
    description:
      "List, lexically search, and read normalized historical Pi session transcripts across projects. " +
      "Search uses case-insensitive AND terms and returns excerpts plus stable session paths. " +
      "Read is paginated by normalized record offset. The active session is excluded unless includeCurrent=true.",
    promptSnippet: "Search and read historical Pi sessions from this machine",
    promptGuidelines: [
      "Use pi_history when earlier Pi sessions may contain decisions, implementations, failures, or context relevant to the current task.",
      "Use pi_history action=search first, then action=read with the returned exact path; paginate read with offset when hasMore is true.",
    ],
    parameters: PiHistoryParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const common = {
        currentSessionPath: ctx.sessionManager.getSessionFile(),
        includeCurrent: params.includeCurrent ?? false,
        scope: params.scope ?? "all",
        cwd: ctx.cwd,
        scanLimit: params.scanLimit,
        signal,
        onProgress: ({
          scanned,
          total,
        }: {
          scanned: number;
          total: number;
        }) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Inspecting historical Pi sessions: ${scanned}/${total}`,
              },
            ],
            details: { action: params.action, scanned, total },
          });
        },
      };

      if (params.action === "list") {
        const result = await listHistoricalSessions({
          ...common,
          limit: params.limit,
        });
        return {
          content: [{ type: "text", text: formatHistoryList(result) }],
          details: {
            action: "list",
            scanned: result.scanned,
            skipped: result.skipped,
            sessions: result.sessions.map(({ id, path }) => ({ id, path })),
          },
        };
      }

      if (params.action === "search") {
        const query = params.query?.trim();
        if (!query) throw new Error("pi_history action=search requires query.");
        const result = await searchHistoricalSessions({
          ...common,
          query,
          limit: params.limit,
        });
        return {
          content: [{ type: "text", text: formatHistorySearch(result, query) }],
          details: {
            action: "search",
            query,
            scanned: result.scanned,
            skipped: result.skipped,
            hits: result.hits.map(({ id, path, matchedRecordCount }) => ({
              id,
              path,
              matchedRecordCount,
            })),
          },
        };
      }

      const session = params.session?.trim();
      if (!session) throw new Error("pi_history action=read requires session.");
      const result = await readHistoricalSession({
        ...common,
        session,
        offset: params.offset,
        recordLimit: params.recordLimit,
        maxCharacters: params.maxCharacters,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          action: "read",
          id: result.session.id,
          path: result.session.path,
          offset: result.offset,
          returnedRecords: result.returnedRecords,
          totalRecords: result.totalRecords,
          hasMore: result.hasMore,
          recordTruncated: result.recordTruncated,
          nextOffset: result.hasMore
            ? result.offset + result.returnedRecords
            : undefined,
        },
      };
    },
  });

  pi.registerCommand("history", {
    description: "Search historical Pi sessions, preview them, or resume one",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const entered =
        args.trim() ||
        (await ctx.ui.input(
          "Search historical Pi sessions",
          "Leave empty for recent sessions",
        )) ||
        "";
      const common = {
        currentSessionPath: ctx.sessionManager.getSessionFile(),
        includeCurrent: false,
        scope: "all" as const,
        cwd: ctx.cwd,
        scanLimit: 1000,
      };
      ctx.ui.setStatus("pi-session-history", "Searching history…");
      let sessionSwitchStarted = false;
      try {
        const result = entered.trim()
          ? await searchHistoricalSessions({
              ...common,
              query: entered.trim(),
              limit: 30,
            })
          : await listHistoricalSessions({ ...common, limit: 30 });
        const sessions = "hits" in result ? result.hits : result.sessions;
        if (sessions.length === 0) {
          ctx.ui.notify(
            entered.trim()
              ? `No historical sessions matched: ${entered.trim()}`
              : "No historical sessions found",
            "warning",
          );
          return;
        }

        const labels = sessions.map(selectionLabel);
        const selected = await ctx.ui.select("Historical Pi sessions", labels);
        if (!selected) return;
        const selectedIndex = labels.indexOf(selected);
        const session = sessions[selectedIndex];
        if (!session) return;

        const action = await ctx.ui.select("Session action", [
          "Preview normalized transcript",
          "Ask agent about this session",
          "Resume this session",
        ]);
        if (action === "Preview normalized transcript") {
          const preview = await readHistoricalSession({
            ...common,
            session: session.path,
            recordLimit: 120,
            maxCharacters: 40_000,
          });
          await ctx.ui.editor(`History: ${session.title}`, preview.text);
          return;
        }
        if (action === "Ask agent about this session") {
          ctx.ui.setEditorText(
            `Use pi_history action=read to inspect and analyze this historical session: ${session.path}`,
          );
          return;
        }
        if (action === "Resume this session") {
          const confirmed = await ctx.ui.confirm(
            "Resume historical session?",
            `${session.title}\n${session.path}`,
          );
          if (!confirmed) return;
          await ctx.waitForIdle();
          // switchSession tears down this extension instance. Clear UI state
          // before replacement and never touch the captured old ctx afterward.
          ctx.ui.setStatus("pi-session-history", undefined);
          sessionSwitchStarted = true;
          await ctx.switchSession(session.path, {
            withSession: async (nextCtx) => {
              nextCtx.ui.notify("Resumed historical Pi session", "info");
            },
          });
        }
      } finally {
        if (!sessionSwitchStarted)
          ctx.ui.setStatus("pi-session-history", undefined);
      }
    },
  });
}
