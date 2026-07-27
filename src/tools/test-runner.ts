// src/tools/test-runner.ts
// 测试框架产品化：聚合 generate→run→report 闭环，强依赖 GUT addon。
// 复用：runtime.ts 的 GUT spawn、script.ts 的 generate_test 推导、issue-formatter 的双轨输出。
// 设计：测试套件 = 项目 test/*.gd 文件（GUT 格式），本工具不发明新数据结构。

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import { requireProjectPath, buildSafeEnv } from '../helpers.js';
import { resolveWithinRoot, normalizeUserProjectPath } from '../core/path-utils.js';
import { scanFiles } from '../core/file-scanner.js';
import { forceKillTree, acquireShortRunningSlot, releaseShortRunningSlot } from '../core/process-state.js';
import { gdEscape } from './shared.js';
import { dualTrackOutput, formatIssues } from './shared/issue-formatter.js';
import type { NormalizedIssue } from './shared/issue-formatter.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';

// ─── Constants ─────────────────────────────────────────────────────────────

const TOOL_NAMES = ['test_runner'] as const;

const ACTIONS = ['check_gut', 'list_suites', 'run', 'generate'] as const;

export { TOOL_NAMES, ACTIONS };

const GUT_INSTALL_HINT = `To install GUT:
1. Download from: https://github.com/bitwes/Gut/releases
2. Extract to <project>/addons/gut
3. Or use the Godot Asset Library: https://godotengine.org/asset-library/asset/282`;

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'test_runner',
    description:
      '测试框架产品化（强依赖 GUT addon）。check_gut: 检查 GUT 安装状态。' +
      'list_suites: 列出 test/ 目录的测试文件及 test_ 函数。' +
      'run: 运行指定测试文件（或全量），结构化报告。' +
      'generate: 为指定脚本生成 GUT 测试骨架并落盘到 test/scripts/。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_path: { type: 'string', description: 'Godot 项目目录路径' },
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: '操作类型',
        },
        test_script: {
          type: 'string',
          description: 'run: 测试文件 res:// 路径（如 res://test/scripts/test_player.gd），不传则全量运行 res://test/',
        },
        script_path: {
          type: 'string',
          description: 'generate: 要为之生成测试的目标脚本路径（如 scripts/player.gd）',
        },
        timeout: { type: 'number', description: 'run: 超时秒数（默认 120）' },
      },
      required: ['action'],
    },
  }];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** 检查 GUT addon 是否安装 */
function checkGutInstalled(projectPath: string): { installed: boolean; path: string } {
  const gutPath = join(projectPath, 'addons', 'gut');
  return { installed: existsSync(gutPath), path: gutPath };
}

/** 从 .gd 文件提取 test_ 函数名（GUT 约定） */
function extractTestFunctions(source: string): string[] {
  const tests: string[] = [];
  const re = /^func\s+(test_\w+)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    tests.push(m[1]!);
  }
  return tests;
}

/** 解析 GUT 输出为结构化数字（修复 runtime.ts:337 字符串数组 bug） */
function parseGutOutput(output: string): { total: number; failed: number; passing: number } {
  // GUT 输出格式示例：
  //   Tests: 6
  //   Failed: 1
  //   Passing: 5
  const totalMatch = output.match(/Tests:\s*(\d+)/);
  const failedMatch = output.match(/Failed:\s*(\d+)/);
  const passingMatch = output.match(/Passing:\s*(\d+)/);
  return {
    total: totalMatch ? parseInt(totalMatch[1]!, 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1]!, 10) : 0,
    passing: passingMatch ? parseInt(passingMatch[1]!, 10) : (totalMatch && failedMatch
      ? parseInt(totalMatch[1]!, 10) - parseInt(failedMatch[1]!, 10) : 0),
  };
}

/** 文件名碰撞自增（参照 asset 工具模式）：test_player.gd → test_player_1.gd → ... */
function resolveCollision(dir: string, filename: string): string {
  if (!existsSync(join(dir, filename))) return filename;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${stem}_${Date.now()}${ext}`;
}

// ─── Actions ───────────────────────────────────────────────────────────────

/** check_gut: 检查 GUT 安装状态 */
function handleCheckGut(projectPath: string): ToolResult {
  const { installed, path } = checkGutInstalled(projectPath);
  const data = { installed, path, install_hint: installed ? '' : GUT_INSTALL_HINT };
  const humanText = installed
    ? `GUT addon: ✓ installed at ${path}`
    : `GUT addon: ✗ not found at ${path}\n\n${GUT_INSTALL_HINT}`;
  return textResult(dualTrackOutput(humanText, data));
}

/** list_suites: 扫描 test/ 目录列出测试文件 + test_ 函数 */
function handleListSuites(projectPath: string): ToolResult {
  const testDir = join(projectPath, 'test');
  if (!existsSync(testDir)) {
    const data = { suites: [], total_tests: 0, note: 'test/ directory not found' };
    return textResult(dualTrackOutput('No test/ directory found in project.', data));
  }
  const files = scanFiles(testDir, ['.gd']);
  const suites = files.map(f => {
    const source = readFileSync(f, 'utf-8');
    const tests = extractTestFunctions(source);
    return { file: f.replace(/\\/g, '/').replace(projectPath.replace(/\\/g, '/') + '/', ''), test_count: tests.length, tests };
  }).filter(s => s.test_count > 0);  // 只列有测试函数的文件
  const totalTests = suites.reduce((s, x) => s + x.test_count, 0);

  // 双轨输出
  const lines = suites.length === 0
    ? ['No GUT test files (containing test_* functions) found in test/.']
    : [
      `Found ${suites.length} test file(s) with ${totalTests} test(s):\n`,
      ...suites.map(s => `  ${s.file} (${s.test_count} tests): ${s.tests.join(', ')}`),
    ];
  return textResult(dualTrackOutput(lines.join('\n'), { suites, total_tests: totalTests }));
}

/** run: 运行 GUT 测试，结构化报告 */
async function handleRun(args: Record<string, unknown>, projectPath: string, ctx: ToolContext): Promise<ToolResult> {
  // 预检 GUT
  const { installed, path } = checkGutInstalled(projectPath);
  if (!installed) {
    return textResult(`GUT addon not found at ${path}.\n\n${GUT_INSTALL_HINT}`);
  }
  if (!existsSync(join(projectPath, 'project.godot'))) {
    return textResult(`Error: Not a Godot project (no project.godot found): ${projectPath}`);
  }

  const rawTestScript = (args.test_script as string) || 'res://test/';
  // I-SEC-08: 必须以 res:// 开头（防文件系统穿越，复用 runtime.ts:302 逻辑）
  if (!rawTestScript.startsWith('res://')) {
    return textResult(`Error: test_script must start with "res://", got: "${rawTestScript}"`);
  }

  if (!acquireShortRunningSlot()) {
    return textResult('Error: too many concurrent headless operations (max 3). Please wait and retry.');
  }

  const godot = await ctx.findGodot();
  const timeoutMs = ((args.timeout as number) || 120) * 1000;

  return new Promise((resolve) => {
    let settled = false;
    // 复用 runtime.ts:311-316 的 GUT spawn 命令模板
    const proc = spawn(godot, [
      '--headless', '--path', projectPath,
      '--script', 'addons/gut/gut_cmdln.gd',
      '-gdir', rawTestScript,
      '-gquit',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

    let out = '';
    const MAX_OUTPUT = 500_000;
    proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });

    const timer = setTimeout(() => {
      if (!settled && !proc.killed) {
        settled = true;
        forceKillTree(proc);
        releaseShortRunningSlot();
        resolve(textResult(`test_runner run timed out after ${timeoutMs / 1000}s`));
      }
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      releaseShortRunningSlot();

      // 结构化解析（修复 runtime.ts:337 字符串数组 bug）
      const stats = parseGutOutput(out);
      const passed = stats.total - stats.failed;
      const MAX_RAW_OUTPUT = 50_000;
      const rawOutput = out.length > MAX_RAW_OUTPUT
        ? out.slice(0, MAX_RAW_OUTPUT) + `\n... [truncated, ${out.length} total bytes]`
        : out;

      const data = {
        exit_code: code,
        total: stats.total,
        passed,
        failed: stats.failed,
        raw_output: rawOutput,
      };

      // 双轨报告
      const header = `Test Run: ${stats.failed === 0 ? '✓' : '✗'} ${passed} passed / ${stats.failed} failed / ${stats.total} total\n`;
      const issues: NormalizedIssue[] = [];
      // 从 raw_output 提取失败行（GUT 失败输出格式多样，这里做 best-effort）
      for (const line of rawOutput.split('\n')) {
        if (/FAILED|Failed|fail/i.test(line) && !/^Tests:|^Failed:|^Passing:/.test(line)) {
          issues.push({ severity: 'error', location: '', message: line.trim() });
        }
      }
      const humanText = header + '\n' + (issues.length > 0 ? formatIssues(issues, { truncate: 30 }) : '');
      resolve(textResult(dualTrackOutput(humanText, data)));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      releaseShortRunningSlot();
      resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
    });
  });
}

/** generate: 为脚本生成 GUT 测试骨架并落盘（补全 generate_test 不落盘的缺口） */
function handleGenerate(args: Record<string, unknown>, projectPath: string): ToolResult {
  const scriptPath = args.script_path as string;
  if (!scriptPath) {
    return opsErrorResult('INVALID_PARAMS', 'script_path is required (e.g. "scripts/player.gd")');
  }

  const fullScriptPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(scriptPath));
  if (!existsSync(fullScriptPath)) {
    return opsErrorResult('NOT_FOUND', `Script not found: ${fullScriptPath}`, {
      suggestion: 'Check the script_path for typos. Use validate_scripts to scan all scripts.',
    });
  }

  // 复用 script.ts:719-738 的推导逻辑
  const source = readFileSync(fullScriptPath, 'utf-8');
  const srcLines = source.split('\n');

  let extendsClass = '';
  let className = '';
  for (const line of srcLines) {
    const extMatch = line.match(/^extends\s+(\S+)/);
    if (extMatch) extendsClass = extMatch[1]!;
    const clsMatch = line.match(/^class_name\s+(\S+)/);
    if (clsMatch) className = clsMatch[1]!;
  }

  const publicMethods: string[] = [];
  const voidMethods = new Set<string>();
  for (const line of srcLines) {
    const funcMatch = line.match(/^func\s+(\w+)\s*\((?:[^)]*)\)\s*(?:->\s*(\w+))?\s*:/);
    if (funcMatch && !funcMatch[1]!.startsWith('_')) {
      publicMethods.push(funcMatch[1]!);
      if (funcMatch[2] === 'void') voidMethods.add(funcMatch[1]!);
    }
  }

  if (publicMethods.length === 0) {
    return textResult(
      `No public methods found in ${scriptPath}.\n` +
      `Only private methods (starting with _) were detected or the file has no functions.\n` +
      `The script extends "${extendsClass || 'unknown'}".`,
    );
  }

  let testTarget: string;
  if (className) {
    testTarget = className;
  } else if (scriptPath.includes('/')) {
    testTarget = scriptPath.split('/').pop()?.replace('.gd', '') || 'Target';
  } else {
    testTarget = scriptPath.replace('.gd', '');
  }
  const scriptResPath = scriptPath.startsWith('res://') ? scriptPath : `res://${scriptPath}`;

  // 复用 script.ts:758-776 的 GUT 模板生成
  let testCode = 'extends GutTest\n\n';
  testCode += `var ${testTarget}  # Instance under test\n\n`;
  testCode += 'func before_each():\n';
  testCode += `\t${testTarget} = load("${gdEscape(scriptResPath)}").new()\n\n`;
  testCode += 'func after_each():\n';
  testCode += `\tif is_instance_valid(${testTarget}):\n`;
  testCode += `\t\t${testTarget}.free()\n\n`;
  for (const method of publicMethods) {
    testCode += `func test_${method}():\n`;
    if (voidMethods.has(method)) {
      testCode += `\t# void method — no return value to assert\n`;
      testCode += `\t${testTarget}.${method}()\n`;
      testCode += `\tpass # TODO: verify side effects\n\n`;
    } else {
      testCode += `\tvar result = ${testTarget}.${method}()\n`;
      testCode += `\tassert_not_null(result, "${method} should return a value")\n\n`;
    }
  }

  // 关键增强：直接落盘（补全 generate_test:780 只返回文本不落盘的缺口）
  const testScriptsDir = join(projectPath, 'test', 'scripts');
  mkdirSync(testScriptsDir, { recursive: true });
  const desiredName = `test_${basename(scriptPath)}`;
  const actualName = resolveCollision(testScriptsDir, desiredName);
  const outputPath = join(testScriptsDir, actualName);
  writeFileSync(outputPath, testCode, 'utf-8');

  const data = {
    saved_to: outputPath.replace(/\\/g, '/').replace(projectPath.replace(/\\/g, '/') + '/', ''),
    target: testTarget,
    extends: extendsClass || null,
    class_name: className || null,
    methods_count: publicMethods.length,
    methods: publicMethods,
  };

  const humanText = `Generated GUT test for ${scriptPath}\n` +
    `Target: ${testTarget} (extends ${extendsClass || 'N/A'})\n` +
    `Methods: ${publicMethods.length} (${publicMethods.join(', ')})\n` +
    `Saved to: ${data.saved_to}\n`;
  return textResult(dualTrackOutput(humanText, data));
}

// ─── Tool Handler ──────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = requireProjectPath(args);
    const action = args.action as string;
    if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

    switch (action) {
      case 'check_gut':
        return handleCheckGut(projectPath);
      case 'list_suites':
        return handleListSuites(projectPath);
      case 'run':
        return await handleRun(args, projectPath, ctx);
      case 'generate':
        return handleGenerate(args, projectPath);
      default:
        return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}`);
    }
  } catch (err) {
    return opsErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  test_runner: {
    readonly: false,
    long_running: false,
    actionRisks: {
      check_gut: 'read',
      list_suites: 'read',
      run: 'write',       // 运行测试有副作用（spawn 进程、可能改场景状态）
      generate: 'write',  // 落盘写文件
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
