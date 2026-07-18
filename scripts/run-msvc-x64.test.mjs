import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  defaultWindowsCargoRunner,
  discoverVcVarsAll,
  quoteCmdArg,
  run,
  runMsvcX64,
} from "./run-msvc-x64.mjs";

describe("run-msvc-x64", () => {
  it("quotes only command arguments that require cmd escaping", () => {
    expect(quoteCmdArg("safe/path:value-1")).toBe("safe/path:value-1");
    expect(quoteCmdArg('two words "quoted"')).toBe('"two words \\"quoted\\""');
  });

  it("builds a quoted Cargo target runner command", () => {
    expect(
      defaultWindowsCargoRunner({
        command: "custom-node",
        repoRoot: "C:/repo root",
      }),
    ).toBe('custom-node "C:\\repo root\\scripts\\run-windows-cargo-target.mjs"');
  });

  it("normalizes missing child statuses", () => {
    expect(run("tool", [], {}, () => ({ status: 7 }))).toBe(7);
    expect(run("tool", [], {}, () => ({ status: null }))).toBe(1);
  });

  it("discovers vcvarsall through vswhere or the Build Tools fallback", () => {
    expect(discoverVcVarsAll({ programFilesX86: "" })).toBeNull();

    const root = "C:/Program Files (x86)";
    const vswhere = NodePath.join(root, "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const install = "C:/Visual Studio";
    const candidate = NodePath.join(install, "VC", "Auxiliary", "Build", "vcvarsall.bat");
    expect(
      discoverVcVarsAll({
        programFilesX86: root,
        existsSync: (path) => path === vswhere || path === candidate,
        spawnSync: () => ({ stdout: `\r\n${install}\r\n` }),
      }),
    ).toBe(candidate);

    const fallback = NodePath.join(
      root,
      "Microsoft Visual Studio",
      "2022",
      "BuildTools",
      "VC",
      "Auxiliary",
      "Build",
      "vcvarsall.bat",
    );
    expect(
      discoverVcVarsAll({
        programFilesX86: root,
        existsSync: (path) => path === fallback,
      }),
    ).toBe(fallback);
    expect(discoverVcVarsAll({ programFilesX86: root, existsSync: () => false })).toBeNull();
    expect(
      discoverVcVarsAll({
        programFilesX86: root,
        existsSync: (path) => path === vswhere,
        spawnSync: () => ({ stdout: "\n" }),
      }),
    ).toBeNull();
    expect(
      discoverVcVarsAll({
        programFilesX86: root,
        existsSync: (path) => path === vswhere,
        spawnSync: () => ({ stdout: `${install}\n` }),
      }),
    ).toBeNull();
  });

  it("runs directly without Visual Studio and reports missing commands", () => {
    const consoleError = vi.fn();
    expect(runMsvcX64([], { consoleError })).toBe(2);
    expect(consoleError).toHaveBeenCalledOnce();

    const spawnSync = vi.fn(() => ({ status: 4 }));
    expect(
      runMsvcX64(["cargo", "test"], {
        programFilesX86: "C:/missing",
        existsSync: () => false,
        spawnSync,
      }),
    ).toBe(4);
    expect(spawnSync).toHaveBeenCalledWith(
      "cargo",
      ["test"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("writes, runs, and removes an MSVC wrapper even when cleanup fails", () => {
    const writeFileSync = vi.fn();
    const rmSync = vi.fn(() => {
      throw new Error("already removed");
    });
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ stdout: "C:/Visual Studio\n" })
      .mockReturnValueOnce({ status: 0 });

    expect(
      runMsvcX64(["cargo", "test name"], {
        programFilesX86: "C:/Program Files (x86)",
        existsSync: () => true,
        spawnSync,
        comspec: "custom-cmd.exe",
        tmpdir: "C:/tmp",
        pid: 12,
        now: () => 34,
        writeFileSync,
        rmSync,
      }),
    ).toBe(0);
    expect(writeFileSync).toHaveBeenCalledWith(
      NodePath.join("C:/tmp", "t4code-msvc-x64-12-34.cmd"),
      expect.stringContaining('cargo "test name"'),
    );
    expect(spawnSync).toHaveBeenLastCalledWith(
      "custom-cmd.exe",
      ["/d", "/c", NodePath.join("C:/tmp", "t4code-msvc-x64-12-34.cmd")],
      expect.objectContaining({
        env: expect.objectContaining({
          CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER: expect.stringContaining(
            "run-windows-cargo-target.mjs",
          ),
        }),
      }),
    );
    expect(rmSync).toHaveBeenCalledOnce();
  });

  it("uses platform defaults for wrapper paths and filesystem cleanup", () => {
    const originalComspec = process.env.ComSpec;
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ stdout: "C:/Visual Studio\n" })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ stdout: "C:/Visual Studio\n" })
      .mockReturnValueOnce({ status: 0 });
    try {
      process.env.ComSpec = "true";
      expect(
        runMsvcX64(["cargo", "test"], {
          programFilesX86: "C:/Program Files (x86)",
          existsSync: () => true,
          spawnSync,
        }),
      ).toBe(0);

      delete process.env.ComSpec;
      expect(
        runMsvcX64(["cargo", "test"], {
          programFilesX86: "C:/Program Files (x86)",
          existsSync: () => true,
          spawnSync,
        }),
      ).toBe(0);
    } finally {
      if (originalComspec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComspec;
      }
    }
  });
});
