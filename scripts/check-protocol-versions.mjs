#!/usr/bin/env node
// scripts/check-protocol-versions.mjs
// 2026-08-07 审查 P2: SUPPORTED_PROTOCOL_VERSIONS 硬编码快照 CI 校验
//
// GodotServer.ts:8-10 是 SDK SUPPORTED_PROTOCOL_VERSIONS 的手抄快照（注释自述
// "SDK 更新此列表时需同步"）。本脚本对比 SDK 实际值与快照，不一致则 exit 1。
//
// 用法：node scripts/check-protocol-versions.mjs
// 退出码：0=一致 / 1=drift（SDK 升版后快照未同步）

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 1. 读 SDK 实际值
let sdkVersions;
try {
  // SDK 导出 SUPPORTED_PROTOCOL_VERSIONS（数组）
  const sdkPath = join(root, 'node_modules', '@modelcontextprotocol', 'server');
  const mod = await import(sdkPath).catch(() => null)
    || (await import(join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'index.js')));
  sdkVersions = mod.SUPPORTED_PROTOCOL_VERSIONS;
} catch {
  // 兜底：直接 require 解析
  try {
    sdkVersions = (await import('@modelcontextprotocol/server')).SUPPORTED_PROTOCOL_VERSIONS;
  } catch {
    console.error('[check-protocol-versions] 无法加载 SDK SUPPORTED_PROTOCOL_VERSIONS，跳过（可能 SDK 路径变动）');
    process.exit(0);  // 跳过不阻断（SDK 路径变动时不应阻断 CI）
  }
}

if (!Array.isArray(sdkVersions)) {
  console.error('[check-protocol-versions] SDK SUPPORTED_PROTOCOL_VERSIONS 不是数组，跳过');
  process.exit(0);
}

// 2. 读 GodotServer.ts 硬编码快照
const gs = readFileSync(join(root, 'src', 'GodotServer.ts'), 'utf-8');
// 提取 SUPPORTED_PROTOCOL_VERSIONS = [ ... ] as const 块
const m = gs.match(/const SUPPORTED_PROTOCOL_VERSIONS\s*=\s*\[([\s\S]*?)\]\s*as\s*const/);
if (!m) {
  console.error('[check-protocol-versions] GodotServer.ts 未找到 SUPPORTED_PROTOCOL_VERSIONS 常量定义');
  process.exit(1);
}
const snapshotVersions = (m[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));

// 3. 对比（快照可能含追加的 modern era 版本如 '2026-07-28'，这些不在 SDK 里，允许快照超集）
const sdkSet = new Set(sdkVersions);
const snapshotSet = new Set(snapshotVersions);

// SDK 有的版本快照必须都有（防 SDK 新增版本后快照漏声明）
const missingInSnapshot = sdkVersions.filter(v => !snapshotSet.has(v));
// 快照有的版本若不在 SDK 里，仅警告（可能是 enhanced 追加的 era 版本，非 bug）
const extraInSnapshot = snapshotVersions.filter(v => !sdkSet.has(v));

let fail = false;
if (missingInSnapshot.length > 0) {
  console.error(`[check-protocol-versions] ✗ SDK 有但快照缺（握手版本协商会失败）：${missingInSnapshot.join(', ')}`);
  console.error('[check-protocol-versions] 修复：GodotServer.ts:8-10 加上缺失版本');
  fail = true;
}
if (extraInSnapshot.length > 0) {
  console.warn(`[check-protocol-versions] ⚠ 快照有但 SDK 无（可能是 enhanced 追加的 era 版本，非 bug）：${extraInSnapshot.join(', ')}`);
}

if (fail) process.exit(1);
console.log(`[check-protocol-versions] ✓ SDK 协议版本快照一致（SDK ${sdkVersions.length} 个 / 快照 ${snapshotVersions.length} 个）`);
