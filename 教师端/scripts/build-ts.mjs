#!/usr/bin/env node
/**
 * build-ts.mjs · TypeScript 构建（容忍预存类型错误基线，阻断新增）
 * ----------------------------------------------------------------
 * 背景：仓库 src/**\/*.ts 在 strict:true 下存在历史遗留的类型错误（2026-10 审计基线：
 *   renderer-sandbox 67 / renderer-app 571 / renderer-shell 41 / main 1，共 680）。
 *   tsc 遇类型错误时退出码非零，会让 `npm start`（build:ts && electron .）直接中断，
 *   但产物其实仍会生成（noEmitOnError 默认 false）。
 *
 * 本脚本顺序编译四个项目（照常生成产物到 electron/ 与 teacher-agent-sandbox/js/），
 * 各项目错误数与 BASELINE 比较：
 *   - 未超过基线：通过（预存问题不阻断开发/启动）
 *   - 超过基线：失败并打印新增错误明细（防止引入新类型错误）
 *
 * 修复一批历史错误后，可把对应基线数字调低（配 typecheck 脚本做全量严格检查）。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 预存类型错误基线（2026-10-12 全仓审计测得，TS 5.4.5，无 node_modules） */
const BASELINE = {
  "tsconfig.renderer-sandbox.json": 67,
  "tsconfig.renderer-app.json": 571,
  "tsconfig.renderer-shell.json": 41,
  "tsconfig.main.json": 1,
};

const PROJECTS = Object.keys(BASELINE);

/** 解析 tsc 可执行文件：本地 node_modules 优先，其次 PATH/全局；都不可用则明确失败 */
function resolveTsc() {
  const local = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (existsSync(local)) return { cmd: local, args: [] };
  if (process.platform === "win32" && process.env.APPDATA) {
    // Windows 全局 npm 目录（npm i -g typescript 的落点，不一定在 PATH 中）
    const globalTsc = path.join(process.env.APPDATA, "npm", "tsc.cmd");
    if (existsSync(globalTsc)) return { cmd: globalTsc, args: [] };
  }
  try {
    execFileSync("tsc", ["--version"], { encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    return { cmd: "tsc", args: [] };
  } catch {
    /* PATH 中也不可用 */
  }
  return null;
}

const tscBin = resolveTsc();
if (!tscBin) {
  console.error("[build:ts] 找不到 TypeScript 编译器：请先在 教师端/ 执行 npm install（devDependencies 含 typescript）。");
  process.exit(1);
}
const { cmd, args: preArgs } = tscBin;
const useShell = process.platform === "win32";
let hasRegression = false;
const summary = [];

function countErrors(output) {
  return (output.match(/error TS\d+/g) || []).length;
}

for (const project of PROJECTS) {
  let output = "";
  try {
    output = execFileSync(cmd, [...preArgs, "-p", project], {
      cwd: root,
      encoding: "utf8",
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // tsc 有类型错误时退出码非零：stdout/stderr 是错误明细，产物仍会生成。
    // 但"编译器本身没跑起来"（ENOENT / npm error 等）必须与"编译有错误"区分，
    // 绝不能当作 0 错误放过（否则构建假通过）。
    const out = String(e.stdout || "") + String(e.stderr || "");
    const notReallyRun = e.code === "ENOENT" || !out.trim() || /npm error|could not determine executable/i.test(out);
    if (notReallyRun) {
      console.error(`[build:ts] tsc 未能执行（${cmd}）：请先 npm install（devDependencies 含 typescript）。`);
      console.error(out.split(/\r?\n/).slice(0, 5).join("\n"));
      process.exit(1);
    }
    output = out;
  }
  const n = countErrors(output);
  const base = BASELINE[project];
  const ok = n <= base;
  if (!ok) hasRegression = true;
  summary.push({ project, n, base, ok });
  console.log(
    `[build:ts] ${project}: ${n} 个类型错误（基线 ${base}）${ok ? "✓" : "✗ 超出基线，存在新增错误"}`
  );
  if (!ok) {
    const lines = output.split(/\r?\n/).filter((l) => /error TS/.test(l));
    console.log(lines.slice(0, 50).join("\n"));
    if (lines.length > 50) console.log(`…… 其余 ${lines.length - 50} 条略（跑 npm run typecheck 查看全部）`);
  } else if (n > 0) {
    console.log(`[build:ts]   （预存错误不阻断构建；产物已生成。修复后可下调 ${project} 的基线）`);
  }
}

if (hasRegression) {
  console.error("\n[build:ts] 失败：类型错误数超过预存基线，请修复新增错误（或确认后更新 BASELINE）。");
  process.exit(1);
}
console.log("\n[build:ts] 完成：四个项目编译通过（未超过预存基线）。");
