#!/usr/bin/env node
// scripts/check-env-isolation.mjs — 安全测试 env 隔离 footgun 守护（2026-08-06 审查测试-P2-7）
//
// 背景：test/helpers/path-isolation.ts:11-13 自述 footgun——
//   vi.stubEnv 只记录 stubEnv 调用的键，restore 的 unstubAllEnvs 只恢复这些键；
//   若 it 内用 process.env.X = 'true'（直接赋值而非 stubEnv），afterEach restore 不会清该赋值，
//   跨 it 残留依赖下个 beforeEach 的 stubEnv 覆盖。
//
// 本守护扫描 test/ 下所有文件，检测是否存在"直接赋值危险 env"模式（绕过 stubEnv）：
//   process.env.GODOT_MCP_UNRESTRICTED = '...'   ← 检测
//   process.env.GODOT_MCP_DISABLE_SAFETY = '...' ← 检测
//   process.env.GODOT_MCP_SANDBOX = '...'        ← 检测
//   process.env.GODOT_MCP_ALLOW_UNSAFE = '...'   ← 检测
//
// 例外白名单：test/setup.js（全局设 UNRESTRICTED=true 是有意行为）+ test/helpers/path-isolation.ts
// 自身的 asUnrestrictedPath（封装好的 unrestricted 入口，内部 stubEnv 正确）。
//
// 严重度：warn（exit 0）— 首版非阻断。现有代码 60+ 处直接赋值（多为「保存 orig → 设值 →
// afterEach 还原 orig」正确模式），纯按"直接赋值"报错误报过多。本守护先建立检测能力
// 可视化，逐批迁移到 stubEnv 后再升 error。
// TODO（升 error 前）：实现作用域分析——只报「it 内赋值但所在 describe 无 afterEach 还原」的真 footgun。
//
// 详见：D:\workspace\Obsidian\GodotMCP\开发日志\2026-08-06 审查测试覆盖缺口与可信度.md finding 测试-P2-7
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const TEST_DIR = join(PROJECT_ROOT, 'test');

// 检测模式：直接赋值危险 env（非 stubEnv）
// 匹配 process.env.GODOT_MCP_<X> = '...'（允许任意空白 + 引号/无引号）
const DANGEROUS_DIRECT_ASSIGN = /process\.env\.(GODOT_MCP_UNRESTRICTED|GODOT_MCP_DISABLE_SAFETY|GODOT_MCP_SANDBOX|GODOT_MCP_ALLOW_UNSAFE|GODOT_MCP_ALLOW_UNSAFE_CONFIRM)\s*=/g;

// 白名单：这些文件内允许直接赋值（有意行为或封装入口）
const ALLOWLIST = new Set([
  'test/setup.js',                    // 全局 UNRESTRICTED=true 是有意，afterEach 不依赖此清
  'test/helpers/path-isolation.ts',   // asUnrestrictedPath 用 stubEnv 正确，本文件是封装入口
]);

// 收集 test/ 下所有 .ts/.js 文件
function walkTestFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = full.replace(/\\/g, '/').replace(PROJECT_ROOT.replace(/\\/g, '/') + '/', '');
    if (statSync(full).isDirectory()) {
      walkTestFiles(full, acc);
    } else if (/\.(ts|js|mjs)$/.test(entry) && !ALLOWLIST.has(rel)) {
      acc.push({ rel, full });
    }
  }
  return acc;
}

function main() {
  const files = walkTestFiles(TEST_DIR);
  const violations = [];
  for (const { rel, full } of files) {
    const src = readFileSync(full, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      // 跳过注释行
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      // 跳过 stubEnv 调用（不是直接赋值）
      if (/\bstubEnv\s*\(/.test(line)) return;
      const m = line.match(DANGEROUS_DIRECT_ASSIGN);
      if (m) {
        violations.push({
          file: rel,
          line: idx + 1,
          code: trimmed,
          env: m.map(mm => mm.match(/GODOT_MCP_\w+/)?.[0]).join(', '),
        });
      }
    });
  }

  if (violations.length === 0) {
    console.log('[env-isolation] ✓ %d 文件扫描，零危险 env 直接赋值（footgun 守护通过）', files.length);
    return;
  }

  // warn-only（首版）：可视化但不阻断。逐批迁移到 stubEnv 后再升 error。
  console.warn('[env-isolation] ⚠ %d 条危险 env 直接赋值（首版 warn 非阻断；逐批迁移到 stubEnv 后升 error）：', violations.length);
  for (const v of violations.slice(0, 10)) {  // 只展示前 10 条避免日志淹没
    console.warn('  %s:%d  [%s]', v.file, v.line, v.env);
    console.warn('    %s', v.code);
  }
  if (violations.length > 10) {
    console.warn('  ... 其余 %d 条省略', violations.length - 10);
  }
  console.warn('[env-isolation] 背景：test/helpers/path-isolation.ts:11-13 footgun 自述；修复用 vi.stubEnv');
}

main();
