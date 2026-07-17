#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export function run(command, commandArgs, options = {}, spawnSync = NodeChildProcess.spawnSync) {
  return (
    spawnSync(command, commandArgs, {
      stdio: "inherit",
      shell: false,
      ...options,
    }).status ?? 1
  );
}

export function discoverVcVarsAll(options = {}) {
  const programFilesX86 = options.programFilesX86 ?? process.env["ProgramFiles(x86)"];
  const existsSync = options.existsSync ?? NodeFS.existsSync;
  const spawnSync = options.spawnSync ?? NodeChildProcess.spawnSync;
  if (!programFilesX86) {
    return null;
  }

  const vswhere = NodePath.join(
    programFilesX86,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (existsSync(vswhere)) {
    const result = spawnSync(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const installationPath = result.stdout.trim().split(/\r?\n/).at(0);
    if (installationPath) {
      const candidate = NodePath.join(
        installationPath,
        "VC",
        "Auxiliary",
        "Build",
        "vcvarsall.bat",
      );
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const fallback = NodePath.join(
    programFilesX86,
    "Microsoft Visual Studio",
    "2022",
    "BuildTools",
    "VC",
    "Auxiliary",
    "Build",
    "vcvarsall.bat",
  );
  return existsSync(fallback) ? fallback : null;
}

export function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function runMsvcX64(args, options = {}) {
  const consoleError = options.consoleError ?? console.error;
  const spawnSync = options.spawnSync ?? NodeChildProcess.spawnSync;
  if (args.length === 0) {
    consoleError("Usage: node scripts/run-msvc-x64.mjs <command> [...args]");
    return 2;
  }

  const vcvarsall = discoverVcVarsAll({
    programFilesX86: options.programFilesX86,
    existsSync: options.existsSync,
    spawnSync,
  });
  if (!vcvarsall) {
    return run(args[0], args.slice(1), {}, spawnSync);
  }

  const comspec = options.comspec ?? process.env.ComSpec ?? "cmd.exe";
  const scriptPath = NodePath.join(
    options.tmpdir ?? NodeOS.tmpdir(),
    `t4code-msvc-x64-${options.pid ?? process.pid}-${options.now?.() ?? Date.now()}.cmd`,
  );
  const writeFileSync = options.writeFileSync ?? NodeFS.writeFileSync;
  const rmSync = options.rmSync ?? NodeFS.rmSync;
  writeFileSync(
    scriptPath,
    [
      "@echo off",
      `call "${vcvarsall}" x64`,
      "if errorlevel 1 exit /b %errorlevel%",
      args.map(quoteCmdArg).join(" "),
      "exit /b %errorlevel%",
      "",
    ].join("\r\n"),
  );

  const status = run(comspec, ["/d", "/c", scriptPath], {}, spawnSync);
  try {
    rmSync(scriptPath, { force: true });
  } catch {}
  return status;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  process.exit(runMsvcX64(process.argv.slice(2)));
}
