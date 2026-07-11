import { assert, it } from "@effect/vitest";
import { expect } from "vite-plus/test";

import {
  buildWindowsProcessRowsCommand,
  collectProcessTree,
  formatBytes,
  measureDesktopRuntime,
  parseMeasureDesktopRuntimeArgs,
  renderMeasurementMarkdown,
  summarizeProcessTree,
  type RuntimeProcessRow,
} from "./measure-desktop-runtime.ts";

const rows: ReadonlyArray<RuntimeProcessRow> = [
  {
    pid: 10,
    ppid: 1,
    processName: "T4Code",
    command: "T4Code.exe",
    privateBytes: 100,
    workingSetBytes: 150,
    mainWindowTitle: "T4Code",
  },
  {
    pid: 11,
    ppid: 10,
    processName: "node",
    command: "node server.js",
    privateBytes: 200,
    workingSetBytes: 250,
    mainWindowTitle: "",
  },
  {
    pid: 12,
    ppid: 11,
    processName: "powershell",
    command: "powershell diagnostics",
    privateBytes: 50,
    workingSetBytes: 75,
    mainWindowTitle: "",
  },
  {
    pid: 99,
    ppid: 1,
    processName: "unrelated",
    command: "other.exe",
    privateBytes: 999,
    workingSetBytes: 999,
    mainWindowTitle: "",
  },
];

it("collects a process tree rooted at the launched desktop process", () => {
  assert.deepStrictEqual(
    collectProcessTree(rows, 10).map((row) => row.pid),
    [10, 11, 12],
  );
});

it("ignores stale children that predate the launched desktop process", () => {
  const measuredRows: ReadonlyArray<RuntimeProcessRow> = [
    {
      pid: 10,
      ppid: 1,
      processName: "T4Code",
      command: "T4Code.exe",
      privateBytes: 100,
      workingSetBytes: 150,
      mainWindowTitle: "T4Code",
      startedAtEpochMs: 10_000,
    },
    {
      pid: 11,
      ppid: 10,
      processName: "node",
      command: "node server.js",
      privateBytes: 200,
      workingSetBytes: 250,
      mainWindowTitle: "",
      startedAtEpochMs: 11_000,
    },
    {
      pid: 12,
      ppid: 11,
      processName: "WebView2",
      command: "msedgewebview2.exe",
      privateBytes: 300,
      workingSetBytes: 350,
      mainWindowTitle: "",
      startedAtEpochMs: 12_000,
    },
    {
      pid: 20,
      ppid: 10,
      processName: "stale-child",
      command: "old.exe",
      privateBytes: 999,
      workingSetBytes: 999,
      mainWindowTitle: "",
      startedAtEpochMs: 1_000,
    },
  ];

  assert.deepStrictEqual(
    collectProcessTree(measuredRows, 10).map((row) => row.pid),
    [10, 11, 12],
  );
});

it("summarizes private and working-set memory for a desktop process tree", () => {
  const summary = summarizeProcessTree({
    label: "tauri-win",
    rootPid: 10,
    rows,
    sampledAt: "2026-07-09T08:00:00.000Z",
    startupMs: 1_250,
    idleMs: 30_000,
  });

  assert.deepStrictEqual(summary.processIds, [10, 11, 12]);
  assert.equal(summary.processCount, 3);
  assert.equal(summary.totalPrivateBytes, 350);
  assert.equal(summary.totalWorkingSetBytes, 475);
  assert.equal(summary.topProcesses[0]?.pid, 11);
  assert.equal(summary.startupMs, 1_250);
});

it("parses runtime measurement CLI flags with repeated args and environment entries", () => {
  assert.deepStrictEqual(
    parseMeasureDesktopRuntimeArgs([
      "--label",
      "tauri-win",
      "--command",
      "T4Code.exe",
      "--arg",
      "--inspect",
      "--arg",
      "value",
      "--cwd",
      "X:/repo",
      "--ready-url",
      "http://127.0.0.1:3773/.well-known/t4code/environment",
      "--window-title",
      "T4Code",
      "--idle-ms",
      "5000",
      "--timeout-ms",
      "60000",
      "--env",
      "T4CODE_HOME=X:/tmp/t4code",
      "--keep-running",
      "--json-out",
      "out/runtime.json",
      "--markdown-out",
      "out/runtime.md",
    ]),
    {
      label: "tauri-win",
      command: "T4Code.exe",
      args: ["--inspect", "value"],
      cwd: "X:/repo",
      readyUrl: "http://127.0.0.1:3773/.well-known/t4code/environment",
      windowTitle: "T4Code",
      idleMs: 5_000,
      timeoutMs: 60_000,
      env: { T4CODE_HOME: "X:/tmp/t4code" },
      keepRunning: true,
      jsonOut: "out/runtime.json",
      markdownOut: "out/runtime.md",
    },
  );
});

it("builds a PowerShell process sampler command without invalid hash literals", () => {
  const command = buildWindowsProcessRowsCommand();

  assert.equal(/@\{;/.test(command), false);
  assert.equal(/\{\s*;/.test(command), false);
  assert.equal(/\[pscustomobject\]@\{/.test(command), true);
  assert.equal(command.includes("CreationTimeIso"), true);
});

it("formats measurement summaries for baseline documentation", () => {
  const summary = summarizeProcessTree({
    label: "tauri-win",
    rootPid: 10,
    rows,
    sampledAt: "2026-07-09T08:00:00.000Z",
    startupMs: 1_250,
    idleMs: 30_000,
  });

  assert.equal(formatBytes(45_395_200), "43.3 MiB");
  assert.include(renderMeasurementMarkdown(summary), "| Total private bytes | 350 bytes |");
  assert.include(renderMeasurementMarkdown(summary), "| Startup readiness | 1.25 s |");
  assert.include(renderMeasurementMarkdown(summary), "node server.js");
});

it("reports missing desktop commands as measurement errors", async () => {
  await expect(
    measureDesktopRuntime({
      label: "missing-command",
      command: "t4code-missing-desktop-command-for-test",
      args: [],
      idleMs: 1,
      timeoutMs: 1,
      env: {},
      keepRunning: false,
    }),
  ).rejects.toThrow("Failed to start desktop process 't4code-missing-desktop-command-for-test'");
});
