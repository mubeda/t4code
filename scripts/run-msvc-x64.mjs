#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/run-msvc-x64.mjs <command> [...args]");
  process.exit(2);
}

function run(command, commandArgs, options = {}) {
  return (
    NodeChildProcess.spawnSync(command, commandArgs, {
      stdio: "inherit",
      shell: false,
      ...options,
    }).status ?? 1
  );
}

function discoverVcVarsAll() {
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (!programFilesX86) {
    return null;
  }

  const vswhere = NodePath.join(
    programFilesX86,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (NodeFS.existsSync(vswhere)) {
    const result = NodeChildProcess.spawnSync(
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
      if (NodeFS.existsSync(candidate)) {
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
  return NodeFS.existsSync(fallback) ? fallback : null;
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

const vcvarsall = discoverVcVarsAll();
if (!vcvarsall) {
  process.exit(run(args[0], args.slice(1)));
}

const comspec = process.env.ComSpec ?? "cmd.exe";
const scriptPath = NodePath.join(
  NodeOS.tmpdir(),
  `t4code-msvc-x64-${process.pid}-${Date.now()}.cmd`,
);
NodeFS.writeFileSync(
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

const status = run(comspec, ["/d", "/c", scriptPath]);
try {
  NodeFS.rmSync(scriptPath, { force: true });
} catch {}
process.exit(status);
