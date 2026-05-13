#!/usr/bin/env node
/**
 * generate-doc-db.js
 * 从 docs/api/extension_api.json 生成 data/godot-classes.json
 *
 * 流程：
 *   1. 优先读取已有的 docs/api/extension_api.json（直接转换格式）
 *   2. 如果不存在，尝试用 godot --headless --doctool 生成
 *   3. 输出到 data/godot-classes.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INPUT_PATH = join(ROOT, 'docs', 'api', 'extension_api.json');
const OUTPUT_DIR = join(ROOT, 'data');
const OUTPUT_PATH = join(OUTPUT_DIR, 'godot-classes.json');

// ── 查找 Godot 二进制 ──────────────────────────────────
function findGodotBinary() {
  const envPath = process.env.GODOT_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${which} godot`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const candidates = result.split('\n').map(s => s.trim()).filter(Boolean);
    if (candidates.length > 0) return candidates[0];
  } catch {
    // 不在 PATH 中
  }

  return null;
}

// ── 获取 Godot 版本 ────────────────────────────────────
function getGodotVersion(godotBin) {
  try {
    return execSync(`"${godotBin}" --version`, { encoding: 'utf-8' }).trim();
  } catch (err) {
    console.warn('警告: 无法获取 Godot 版本:', err.message);
    return null;
  }
}

// ── 尝试用 doctool 生成文档 ─────────────────────────────
function generateWithDoctool(godotBin) {
  const outputDir = join(ROOT, 'docs', 'api');
  console.log(`尝试用 godot --doctool 生成文档到 ${outputDir} ...`);

  try {
    execSync(`"${godotBin}" --headless --doctool "${outputDir}"`, {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: 'pipe',
    });
    if (existsSync(INPUT_PATH)) {
      console.log('doctool 生成成功');
      return true;
    }
  } catch (err) {
    console.error('doctool 失败:', err.message?.split('\n')[0] || err.message);
  }
  return false;
}

// ── 主流程 ──────────────────────────────────────────────
function main() {
  console.log('=== Godot 文档数据库生成器 ===\n');

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 路径 1：直接使用已有的 extension_api.json
  if (existsSync(INPUT_PATH)) {
    console.log('找到 docs/api/extension_api.json，直接转换格式');
  } else {
    // 路径 2：用 Godot 生成
    console.log('未找到 docs/api/extension_api.json');

    const godotBin = findGodotBinary();
    if (!godotBin) {
      console.error(
        '\n错误: 找不到 Godot 二进制文件。\n' +
        '请执行以下任一操作：\n' +
        '  1. 设置 GODOT_PATH 环境变量指向 Godot 可执行文件\n' +
        '  2. 将 Godot 添加到系统 PATH\n' +
        '  3. 手动将 extension_api.json 放到 docs/api/ 目录'
      );
      process.exit(1);
    }

    console.log('使用 Godot:', godotBin);
    if (!generateWithDoctool(godotBin)) {
      console.error('错误: doctool 生成失败且无 extension_api.json 可用');
      process.exit(1);
    }
  }

  // 读取并解析
  console.log('读取', INPUT_PATH);
  let apiData;
  try {
    apiData = JSON.parse(readFileSync(INPUT_PATH, 'utf-8'));
  } catch (err) {
    console.error('错误: 无法解析 extension_api.json:', err.message);
    process.exit(1);
  }

  if (!apiData.classes || !Array.isArray(apiData.classes)) {
    console.error('错误: extension_api.json 缺少有效的 classes 数组');
    process.exit(1);
  }

  // 获取版本信息
  let godotVersion = null;
  const godotBin = findGodotBinary();
  if (godotBin) {
    godotVersion = getGodotVersion(godotBin);
  }
  if (!godotVersion && apiData.header) {
    godotVersion = apiData.header.version_full_name || null;
  }

  // 构建输出
  const output = {
    godot_version: godotVersion,
    generated_at: new Date().toISOString(),
    header: apiData.header || null,
    classes: apiData.classes,
  };

  // 写入
  try {
    writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    const sizeMB = (Buffer.byteLength(JSON.stringify(output)) / 1024 / 1024).toFixed(1);
    console.log(`\n输出: ${OUTPUT_PATH}`);
    console.log(`  版本: ${output.godot_version || '未知'}`);
    console.log(`  类数量: ${output.classes.length}`);
    console.log(`  文件大小: ~${sizeMB} MB`);
    console.log('\n完成!');
  } catch (err) {
    console.error('错误: 无法写入输出文件:', err.message);
    process.exit(1);
  }
}

main();
