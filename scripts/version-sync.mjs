#!/usr/bin/env node
// scripts/version-sync.mjs
// 版本漂移根治:package.json version 作单一真相源,同步到 A 类元数据文件,
// --check 模式校验全部文件版本一致(CI 门禁)。
//
// 风格遵循 scripts/check-rules-version-bump.mjs(shebang/0-1 退出码/修复指引),
// 但比对方式不同:本脚本用 readFileSync 读工作区文件(CI 有效),不依赖 git
// (范本的 git diff 在 CI checkout 后工作区==HEAD 会失效,仅本地有效)。
//
// 用法:
//   node scripts/version-sync.mjs            # 写入:同步 A 类文件到 package.json version
//   node scripts/version-sync.mjs --check    # 校验:全文件一致 exit 0,否则 exit 1
//   node scripts/version-sync.mjs --root <dir>  # 指定项目根(默认 cwd;测试用)
// 退出码:0=成功/一致,1=失败/漂移

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 逻辑名 → 相对项目根的路径
const TARGET_FILES = {
  packageJson: 'package.json',
  manifest: 'manifest.json',
  pluginCfg: 'addons/godot_mcp_server/plugin.cfg',
  serverJson: 'server.json',
  dockerfile: 'Dockerfile',
  guide: 'docs/使用指南.md',
  changelog: 'CHANGELOG.md',
  readme: 'README.md',
  bridgeGd: 'src/scripts/mcp_bridge.gd',
};

// A 类:写入目标(当前版本单值)
const WRITE_TARGETS = ['manifest', 'pluginCfg', 'serverJson', 'dockerfile', 'guide', 'bridgeGd'];
// B 类:仅校验(版本历史,首条版本号)
const CHECK_ONLY = ['changelog', 'readme'];

class AnchorError extends Error {
  constructor(filepath, message) {
    super(`${filepath}: ${message}`);
    this.name = 'AnchorError';
  }
}

// 从单个文件提取版本号(校验/写入幂等判断共用)
function readVersionFromFile(filepath, logicalName) {
  if (!existsSync(filepath)) {
    throw new AnchorError(filepath, '文件不存在');
  }
  const content = readFileSync(filepath, 'utf-8');
  switch (logicalName) {
    case 'packageJson':
    case 'manifest':
    case 'serverJson': {
      const obj = JSON.parse(content);
      if (typeof obj?.version !== 'string' || !obj.version) {
        throw new AnchorError(filepath, 'JSON 缺 version 字段');
      }
      return obj.version;
    }
    case 'pluginCfg': {
      const m = content.match(/^version="([^"\r]*)"/m);
      if (!m) throw new AnchorError(filepath, '未找到 version="..." 字段(格式可能被改动)');
      return m[1];
    }
    case 'dockerfile': {
      // Dockerfile: godot-mcp-enhanced@<version>(npm install -g 行);支持 prerelease 后缀(如 0.20.0-rc.1)
      const m = content.match(/godot-mcp-enhanced@([0-9][0-9.\w-]*)/);
      if (!m) throw new AnchorError(filepath, '未找到 godot-mcp-enhanced@<version>(格式可能被改动)');
      return m[1];
    }
    case 'guide': {
      const m = content.match(/\*\*版本\*\*：([^\s｜\r]+)/);
      if (!m) throw new AnchorError(filepath, '未找到 **版本**：... 字段(格式可能被改动)');
      return m[1];
    }
    case 'changelog': {
      // 首个带日期段,天然跳过 [Unreleased]
      const m = content.match(/^## \[(.+?)\] - \d{4}-\d{2}-\d{2}/m);
      if (!m) throw new AnchorError(filepath, '未找到 ## [x.y.z] - 日期 段(可能全是 [Unreleased] 或格式改动)');
      return m[1];
    }
    case 'readme': {
      const m = content.match(/^\| \*\*v([^*\r]+?)\*\*/m);
      if (!m) throw new AnchorError(filepath, '未找到版本表 | **vx.y.z** 行(格式可能被改动)');
      return m[1];
    }
    case 'bridgeGd': {
      // A2 (2026-09-16 反馈批): bridge 脚本分发版本指纹,与 package.json 同步防漂移
      const m = content.match(/^const BRIDGE_SCRIPT_VERSION := "([^"\r]*)"/m);
      if (!m) throw new AnchorError(filepath, '未找到 const BRIDGE_SCRIPT_VERSION := "..." 行(格式可能被改动)');
      return m[1];
    }
    default:
      throw new Error(`未知逻辑名: ${logicalName}`);
  }
}

// 写入单个 A 类文件的版本字段(最小正则替换,保行尾/格式/字段顺序)
function writeVersionToFile(filepath, logicalName, version) {
  const content = readFileSync(filepath, 'utf-8');
  let updated;
  switch (logicalName) {
    case 'manifest':
      updated = content.replace(/"version"\s*:\s*"[^"\r]*"/, `"version": "${version}"`);
      break;
    case 'pluginCfg':
      updated = content.replace(/^version="[^"\r]*"/m, `version="${version}"`);
      break;
    case 'serverJson': {
      // server.json 有两处 version:顶层 version + packages[0].version,全替换
      const before = content;
      let next = content.replace(/"version"\s*:\s*"[^"\r]*"/g, `"version": "${version}"`);
      updated = next;
      break;
    }
    case 'dockerfile':
      updated = content.replace(/(godot-mcp-enhanced@)[0-9.]+/, `$1${version}`);
      break;
    case 'guide':
      updated = content.replace(/(\*\*版本\*\*：)[^\s｜\r]+/, `$1${version}`);
      break;
    case 'bridgeGd':
      updated = content.replace(/(^const BRIDGE_SCRIPT_VERSION := ")[^"\r]*(")/m, `$1${version}$2`);
      break;
    default:
      throw new Error(`不可写的目标: ${logicalName}`);
  }
  if (updated === content) {
    return false; // 幂等:无变化,不写
  }
  writeFileSync(filepath, updated, 'utf-8');
  return true;
}

// 写入模式:同步 A 类 3 文件到 package.json version
function writeVersions(root) {
  const expected = readVersionFromFile(join(root, TARGET_FILES.packageJson), 'packageJson');
  const results = [];
  for (const name of WRITE_TARGETS) {
    const filepath = join(root, TARGET_FILES[name]);
    const before = readVersionFromFile(filepath, name);
    const changed = writeVersionToFile(filepath, name, expected);
    results.push({ file: TARGET_FILES[name], before, after: expected, changed });
  }
  return { version: expected, results };
}

// 校验模式:5 文件版本号全 == package.json version
function checkConsistency(root) {
  const expected = readVersionFromFile(join(root, TARGET_FILES.packageJson), 'packageJson');
  const mismatches = [];
  for (const name of [...WRITE_TARGETS, ...CHECK_ONLY]) {
    const actual = readVersionFromFile(join(root, TARGET_FILES[name]), name);
    if (actual !== expected) {
      mismatches.push({ file: TARGET_FILES[name], expected, actual });
    }
  }
  return { consistent: mismatches.length === 0, version: expected, mismatches };
}

function parseArgs(argv) {
  const args = { check: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--root') {
      const v = argv[i + 1];
      if (!v || v.startsWith('-')) {
        console.error('✗ --root 需要一个参数值');
        process.exit(1);
      }
      args.root = argv[++i];
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root);

  if (args.check) {
    let result;
    try {
      result = checkConsistency(root);
    } catch (e) {
      console.error(`✗ 版本元数据校验失败: ${e.message}`);
      console.error('  某文件缺失或格式被改动。检查上述文件后重试。');
      process.exit(1);
    }
    if (!result.consistent) {
      console.error(`✗ 版本元数据漂移(期望 ${result.version}):`);
      for (const m of result.mismatches) {
        console.error(`  ${m.file}: ${m.actual} ≠ ${m.expected}`);
      }
      console.error('  修复:npm run version-sync(同步 A 类 manifest/plugin.cfg/server.json/Dockerfile/使用指南)');
      console.error('       + 手动补 CHANGELOG.md / README.md 版本表(B 类,描述需人写)');
      process.exit(1);
    }
    console.log(`✓ 版本元数据一致 (${result.version})`);
    process.exit(0);
  }

  // 默认(写入)模式
  let result;
  try {
    result = writeVersions(root);
  } catch (e) {
    console.error(`✗ 版本同步失败: ${e.message}`);
    console.error('  某文件缺失或格式被改动。检查上述文件后重试。');
    process.exit(1);
  }
  for (const r of result.results) {
    const arrow = r.changed ? `${r.before} → ${r.after}` : `(已是 ${r.after},跳过)`;
    console.log(`  ${r.file}: ${arrow}`);
  }
  console.log(`✓ A 类元数据已同步到 ${result.version}`);
  console.error('  提醒:B 类(CHANGELOG.md / README.md 版本表)需手动追加,描述是人写。');
  process.exit(0);
}

main();
