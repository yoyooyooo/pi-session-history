import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import extension, { formatHistorySearch } from "../src/index.ts";
import {
  limitToolOutput,
  listHistoricalSessions,
  listPiSessionFiles,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_OUTPUT_LINES,
  readHistoricalSession,
  searchHistoricalSessions,
} from "../src/history.ts";

const root = resolve(import.meta.dirname, "fixtures/agent");
const sessionA = join(
  root,
  "sessions/--workspace-project-a/2026-01-02_session-a.jsonl",
);
const sessionB = join(
  root,
  "sessions/--workspace-project-b/2026-01-03_session-b.jsonl",
);
const outsideSession = resolve(root, "../outside.jsonl");
const symlinkEscape = join(root, "sessions/--workspace-project-a/escape.jsonl");

test("lists Pi sessions newest first", async () => {
  const listings = await listPiSessionFiles({ root });
  assert.equal(listings.length, 2);
  assert.equal(listings[0]?.path, sessionB);
  assert.equal(listings[1]?.path, sessionA);
});

test("searches normalized historical content across projects", async () => {
  const result = await searchHistoricalSessions({
    root,
    query: "database migration",
    limit: 10,
  });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.path, sessionA);
  assert.equal(result.hits[0]?.title, "Customer database migration");
  assert.match(
    result.hits[0]?.excerpts.join("\n") ?? "",
    /database migration/i,
  );

  const crossRecord = await searchHistoricalSessions({
    root,
    query: "reversible checkpoint",
  });
  assert.deepEqual(
    crossRecord.hits.map((hit) => hit.path),
    [sessionA],
  );
});

test("supports cwd scope, bounded listing, and active-session exclusion", async () => {
  const scoped = await listHistoricalSessions({
    root,
    scope: "cwd",
    cwd: "/workspace/project-b",
    limit: 10,
  });
  assert.deepEqual(
    scoped.sessions.map((session) => session.path),
    [sessionB],
  );

  const bounded = await listHistoricalSessions({ root, limit: 1 });
  assert.equal(bounded.sessions.length, 1);
  assert.equal(bounded.scanned, 1);

  const excluded = await listHistoricalSessions({
    root,
    currentSessionPath: sessionB,
    limit: 10,
  });
  assert.deepEqual(
    excluded.sessions.map((session) => session.path),
    [sessionA],
  );
});

test("reads a normalized transcript range with pagination metadata", async () => {
  const result = await readHistoricalSession({
    root,
    session: sessionA,
    recordLimit: 2,
  });
  assert.equal(result.returnedRecords, 2);
  assert.equal(result.totalRecords, 3);
  assert.equal(result.hasMore, true);
  assert.match(result.text, /Plan the database migration/);
  assert.match(result.text, /reversible rollout/);
});

test("exact-path reads bypass scanLimit but cannot escape the sessions root", async () => {
  const result = await readHistoricalSession({
    root,
    session: sessionA,
    scanLimit: 1,
  });
  assert.equal(result.session.path, sessionA);

  await assert.rejects(
    readHistoricalSession({ root, session: outsideSession }),
    /Historical Pi session not found/,
  );
  await assert.rejects(
    readHistoricalSession({ root, session: symlinkEscape }),
    /Historical Pi session not found/,
  );
});

test("honors cancellation during discovery and before transcript scanning", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    listPiSessionFiles({ root, signal: controller.signal }),
    /cancelled/,
  );
  await assert.rejects(
    searchHistoricalSessions({
      root,
      query: "database",
      signal: controller.signal,
    }),
    /cancelled/,
  );
});

test("bounds Tool output by UTF-8 bytes, lines, and requested characters", () => {
  const bounded = limitToolOutput(
    `${"中".repeat(30_000)}\n${"line\n".repeat(3_000)}`,
    {
      maxCharacters: 30_000,
    },
  );
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= MAX_TOOL_OUTPUT_BYTES);
  assert.ok(bounded.text.split("\n").length <= MAX_TOOL_OUTPUT_LINES);
  assert.ok([...bounded.text].length <= 30_000);

  const searchText = formatHistorySearch(
    {
      hits: Array.from({ length: 50 }, (_, index) => ({
        id: `session-${index}`,
        path: `/workspace/${"深".repeat(500)}/session-${index}.jsonl`,
        cwd: `/workspace/${"中".repeat(500)}`,
        title: "历史会话".repeat(100),
        recordCount: 100,
        diagnosticCount: 0,
        score: 1,
        matchedRecordCount: 1,
        excerpts: ["匹配内容".repeat(200)],
      })),
      scanned: 50,
      skipped: 0,
      available: 50,
    },
    "历史",
  );
  assert.ok(Buffer.byteLength(searchText, "utf8") <= MAX_TOOL_OUTPUT_BYTES);
  assert.ok(searchText.split("\n").length <= MAX_TOOL_OUTPUT_LINES);
});

test("registers the pi_history tool and history command", () => {
  const tools: Array<{ name: string }> = [];
  const commands: string[] = [];
  extension({
    registerTool(tool: { name: string }) {
      tools.push(tool);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
  } as never);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["pi_history"],
  );
  assert.deepEqual(commands, ["history"]);
});

test("executes /history preview, agent handoff, and resume actions", async () => {
  let registeredCommand:
    { handler: (args: string, ctx: any) => Promise<void> } | undefined;
  extension({
    registerTool() {},
    registerCommand(
      _name: string,
      command: { handler: (args: string, ctx: any) => Promise<void> },
    ) {
      registeredCommand = command;
    },
  } as never);
  assert.ok(registeredCommand);

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    for (const action of [
      "Preview normalized transcript",
      "Ask agent about this session",
      "Resume this session",
    ]) {
      const statuses: Array<string | undefined> = [];
      let editorContent = "";
      let agentPrompt = "";
      let switchedPath = "";
      let resumedNotice = "";
      let selectionCount = 0;
      await registeredCommand.handler("", {
        hasUI: true,
        cwd: "/workspace/project-a",
        sessionManager: { getSessionFile: () => sessionA },
        ui: {
          input: async () => "",
          select: async (_title: string, options: string[]) => {
            selectionCount += 1;
            return selectionCount === 1 ? options[0] : action;
          },
          notify() {},
          setStatus: (_key: string, value: string | undefined) =>
            statuses.push(value),
          editor: async (_title: string, content: string) => {
            editorContent = content;
          },
          setEditorText: (value: string) => {
            agentPrompt = value;
          },
          confirm: async () => true,
        },
        waitForIdle: async () => {},
        switchSession: async (
          path: string,
          options: { withSession: (ctx: any) => Promise<void> },
        ) => {
          switchedPath = path;
          await options.withSession({
            ui: {
              notify: (message: string) => {
                resumedNotice = message;
              },
            },
          });
          return { cancelled: false };
        },
      });

      assert.equal(statuses[0], "Searching history…");
      assert.equal(statuses.at(-1), undefined);
      if (action === "Preview normalized transcript")
        assert.match(editorContent, /cache invalidation bug/);
      if (action === "Ask agent about this session")
        assert.match(agentPrompt, /pi_history action=read/);
      if (action === "Resume this session") {
        assert.equal(switchedPath, sessionB);
        assert.equal(resumedNotice, "Resumed historical Pi session");
      }
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("executes the registered pi_history search action", async () => {
  let registeredTool: { execute: (...args: any[]) => Promise<any> } | undefined;
  extension({
    registerTool(tool: { execute: (...args: any[]) => Promise<any> }) {
      registeredTool = tool;
    },
    registerCommand() {},
  } as never);
  assert.ok(registeredTool);

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const result = await registeredTool.execute(
      "test-call",
      { action: "search", query: "database migration", limit: 5 },
      new AbortController().signal,
      undefined,
      {
        cwd: "/workspace/project-a",
        sessionManager: { getSessionFile: () => sessionB },
      },
    );
    assert.equal(result.details.action, "search");
    assert.deepEqual(
      result.details.hits.map((hit: { path: string }) => hit.path),
      [sessionA],
    );
    assert.match(result.content[0].text, /Customer database migration/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
