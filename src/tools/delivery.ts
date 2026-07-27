// src/tools/delivery.ts
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath, scanFiles } from '../helpers.js';
import { getLogger } from '../core/logger.js';
import { executeGdscript } from '../gdscript-executor.js';
import { batchValidateScripts } from './validation.js';
import { SCENE_TREE_HEADER, wrapAssertionCode, opsErrorResult } from './shared.js';
import { formatIssues, dualTrackOutput } from './shared/issue-formatter.js';
import type { NormalizedIssue } from './shared/issue-formatter.js';
import { parseAsserts } from './frame-verify/assert-protocol.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, relative, isAbsolute } from 'path';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_ASSERTIONS = 10;
const PERF_TIMEOUT_S = 20;
const ASSERTION_TIMEOUT_S = 15;
const ORPHAN_WARNING_THRESHOLD = 100;
// 交付检查跳过 addons：第三方插件代码不纳入交付质量门禁
const SKIP_DIRS = new Set(['.godot', '.import', 'addons']);

// ─── Types ──────────────────────────────────────────────────────────────────

interface Issue {
  severity: 'error' | 'warning';
  location: string;
  message: string;
  suggestion?: string;
}

function hasErrors(issues: Issue[]): boolean {
  return issues.some(i => i.severity === 'error');
}

function safeReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Tool Definition ────────────────────────────────────────────────────────

/** @deprecated v0.18.0 — 已合并到 validation。仅保留供目标模块导入 handler。 */
export function getToolDefinitions(): Tool[] {
  console.warn(`[DEPRECATED] delivery module is absorbed into validation. Do not register directly.`);
  return [
    {
      name: 'verify_delivery',
      description:
        'End-to-end delivery verification tool. Multi-dimension checks: scene tree integrity, script robustness, performance/resource health, custom behavior assertions, and GDD standards compliance. ' +
        'Returns a structured report with clear pass/fail per dimension. scope controls scanning range, checks controls which dimensions to run.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scope: {
            type: 'string',
            enum: ['scene', 'script', 'full'],
            description: 'Verification scope: scene, script, or full project',
          },
          scene_path: { type: 'string', description: 'Scene path for scope=scene (relative to project)' },
          script_path: { type: 'string', description: 'Script path for scope=script (relative to project)' },
          checks: {
            type: 'object',
            description: 'Check dimensions (all default to true)',
            properties: {
              scene_tree: { type: 'boolean', description: 'Check scene tree integrity' },
              script_health: { type: 'boolean', description: 'Check script robustness' },
              performance: { type: 'boolean', description: 'Check performance/resource health' },
              assertions: {
                type: 'array',
                description: 'Custom behavior assertions (max 10). GDScript must use _mcp_output("assert_N", value) to report results; keys must start with "assert_" or be "assert_result".',
                items: {
                  type: 'object',
                  properties: {
                    description: { type: 'string' },
                    gdscript: { type: 'string' },
                    expect: { type: 'string' },
                  },
                  required: ['description', 'gdscript'],
                },
              },
              gdd_standards: {
                type: 'boolean',
                description: 'Check GDD documents against 8-section standard (requires design/ directory)',
              },
              gdd_dirs: {
                type: 'array',
                description: 'Directories to scan for GDD .md files (default: ["design/gdd"])',
                items: { type: 'string' },
              },
            },
          },
          godot_path: { type: 'string', description: '覆盖 Godot 二进制路径（可选，优先于项目配置和环境变量）' },
        },
        required: ['scope'],
      },
    },
  ];
}

// ─── Scene Integrity Helpers ────────────────────────────────────────────────

export function checkSceneIntegrity(projectPath: string, scenePath: string): { passed: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  // A1 (2026-07-13 对比测试核实): scenePath 可能是 resolveWithinRoot 解析后的绝对路径
  // (scope=scene 上游 resolvedScenePath)。裸 join 会二次拼接 → existsSync 假阴性 →
  // "Scene file not found"。同 resolveScriptPath (:317) 自证的 NEW-2/3 模式, 绝对路径直接用。
  const fullPath = isAbsolute(scenePath) ? scenePath : join(projectPath, scenePath);

  if (!existsSync(fullPath)) {
    return { passed: false, issues: [{ severity: 'error', location: scenePath, message: `Scene file not found: ${scenePath}` }] };
  }

  const content = safeReadFile(fullPath);
  if (content === null) {
    return { passed: false, issues: [{ severity: 'error', location: scenePath, message: `Cannot read scene file: ${scenePath}` }] };
  }

  // Check ext_resource references (match within single [ext_resource ...] entry)
  const extRegex = /^\[ext_resource[^\]]*path="res:\/\/([^"]+)"/gm;
  let match: RegExpExecArray | null;
  while ((match = extRegex.exec(content)) !== null) {
    const refPath = match[1]!;
    const diskPath = join(projectPath, refPath);
    if (!existsSync(diskPath)) {
      issues.push({
        severity: 'error',
        location: `${scenePath}:res://${refPath}`,
        message: `Referenced resource not found: res://${refPath}`,
      });
    }
  }

  // Check [connection] static signals
  const connRegex = /^\[connection\s+.*?\]/gm;
  while ((match = connRegex.exec(content)) !== null) {
    const line = match[0];
    const target = line.match(/target="([^"]+)"/)?.[1];
    const method = line.match(/method="([^"]+)"/)?.[1];
    const signal = line.match(/signal="([^"]+)"/)?.[1];
    if (target !== undefined && method !== undefined) {
      if (!target.trim() || !method.trim()) {
        issues.push({
          severity: 'warning',
          location: `${scenePath}:connection`,
          message: `Malformed connection: signal=${signal ?? '?'}, target=${target}, method=${method}`,
        });
      }
    }
  }

  return { passed: !hasErrors(issues), issues };
}

// Cache: scene path → file content (avoids O(n*m) re-reading)
// Lifecycle is bound to a single handleTool call — no module-level state.

function buildSceneContentCache(projectPath: string, cache: Map<string, string>): Map<string, string> {
  if (cache.size > 0) return cache;
  (function scanDir(dir: string, relPrefix: string): void {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            scanDir(join(dir, entry.name), `${relPrefix}${entry.name}/`);
          }
        } else if (entry.name.endsWith('.tscn')) {
          const content = safeReadFile(join(dir, entry.name));
          if (content) {
            cache.set(`${relPrefix}${entry.name}`, content);
          }
        }
      }
    } catch (err) { getLogger().debug('delivery', `scan scene cache: ${err instanceof Error ? err.message : err}`); }
  })(projectPath, '');
  return cache;
}

export function findAssociatedScenes(projectPath: string, scriptPath: string, cache?: Map<string, string>): string[] {
  const scenes: string[] = [];
  // 归一化 scriptPath 为相对项目的 res:// 引用形式。
  // 场景文件中的脚本引用一律是相对的（如 res://scripts/player.gd），
  // 而调用方（verify_delivery scope=script）传入的是 resolveWithinRoot 解析后的绝对路径，
  // 若直接 `res://${absPath}` 拼成 res://D:\project\... 将与场景内容恒不匹配 → scenes 恒空
  // → scene_tree 维度空循环 → 报告 passed:true，发版门禁静默假阴性。
  let scriptRel = scriptPath;
  if (scriptRel.startsWith('res://')) scriptRel = scriptRel.slice('res://'.length);
  if (isAbsolute(scriptRel)) scriptRel = relative(projectPath, scriptRel);
  scriptRel = scriptRel.replace(/\\/g, '/');
  const scriptResPath = `res://${scriptRel}`;
  const sceneCache = cache ?? new Map<string, string>();
  const filled = buildSceneContentCache(projectPath, sceneCache);
  for (const [sceneRelPath, content] of filled) {
    if (content.includes(`"${scriptResPath}"`)) {
      scenes.push(sceneRelPath);
    }
  }
  return scenes;
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

/** @deprecated v0.18.0 — 已合并到 validation。仅保留供目标模块导入 handler。 */
export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'verify_delivery') return null;

  if (typeof args.project_path !== 'string') {
    return opsErrorResult('INVALID_PARAMS', 'project_path must be a string');
  }
  if (typeof args.scope !== 'string' || !['scene', 'script', 'full'].includes(args.scope)) {
    return opsErrorResult('INVALID_PARAMS', 'scope must be one of: scene, script, full');
  }

  const projectPath = requireProjectPath(args);
  if (!existsSync(join(projectPath, 'project.godot'))) {
    return opsErrorResult('INVALID_PARAMS', `Not a valid Godot project (missing project.godot): ${projectPath}`);
  }
  // Scene content cache — lifecycle bound to this single handleTool call
  const sceneCache = new Map<string, string>();
  const scope = args.scope;
  const checks = (args.checks as Record<string, unknown>) ?? {};

  // Validate sub-paths stay within project root
  let resolvedScenePath: string | undefined;
  let resolvedScriptPath: string | undefined;
  if (typeof args.scene_path === 'string' && args.scene_path) {
    try {
      // A9: normalizeUserProjectPath 剥 res:// 前缀，再 resolveWithinRoot 校验（统一模式）。
      resolvedScenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path));
    } catch {
      return opsErrorResult('INVALID_PARAMS', `scene_path traversal detected: ${args.scene_path}`);
    }
  }
  if (typeof args.script_path === 'string' && args.script_path) {
    try {
      resolvedScriptPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.script_path));
    } catch {
      return opsErrorResult('INVALID_PARAMS', `script_path traversal detected: ${args.script_path}`);
    }
  }

  const sceneTree = checks.scene_tree !== false;
  const scriptHealth = checks.script_health !== false;
  const perfCheck = checks.performance !== false;
  const assertions = (checks.assertions as Array<Record<string, string>>) ?? [];
  const report: Record<string, unknown> = {};
  const dimensionResults: Array<{ dim: string; passed: boolean }> = [];

  // ── Dimension 1: Scene tree integrity ──
  if (sceneTree) {
    let scenePaths: string[] = [];

    if (scope === 'scene') {
      if (!resolvedScenePath) {
        report.scene_tree = { passed: false, issues: [{ severity: 'error', location: '', message: 'scene_path required for scope=scene' }] };
      } else {
        scenePaths = [resolvedScenePath];
      }
    } else if (scope === 'script') {
      if (!resolvedScriptPath) {
        report.scene_tree = { passed: false, issues: [{ severity: 'error', location: '', message: 'script_path required for scope=script' }] };
      } else {
        scenePaths = findAssociatedScenes(projectPath, resolvedScriptPath, sceneCache);
      }
    } else {
      // scope=full: collect all .tscn
      // A-07: Replaced inline collectScenes with scanFiles
      const sceneFiles = scanFiles(projectPath, ['.tscn'], { skipDirs: [...SKIP_DIRS] });
      getLogger().debug('delivery', `scanFiles found ${sceneFiles.length} .tscn files in ${projectPath}`);
      scenePaths = sceneFiles.map(f => relative(projectPath, f));
    }

    if (!report.scene_tree) {
      const allIssues: Issue[] = [];
      for (const sp of scenePaths) {
        const result = checkSceneIntegrity(projectPath, sp);
        allIssues.push(...result.issues);
      }
      const passed = !hasErrors(allIssues);
      report.scene_tree = { passed, issues: allIssues };
      dimensionResults.push({ dim: 'scene_tree', passed });
    } else {
      dimensionResults.push({ dim: 'scene_tree', passed: (report.scene_tree as { passed: boolean }).passed });
    }
  }

  // ── Dimension 2: Script health ──
  if (scriptHealth) {
    const issues: Issue[] = [];
    let scriptPaths: string[] = [];

    if (scope === 'script') {
      if (resolvedScriptPath) scriptPaths = [resolvedScriptPath];
      if (resolvedScenePath) {
        if (existsSync(resolvedScenePath)) {
          const content = safeReadFile(resolvedScenePath);
          if (content) {
            const scriptRegex = /path="(res:\/\/[^"]+\.gd)"/g;
            let m: RegExpExecArray | null;
            while ((m = scriptRegex.exec(content)) !== null) {
              scriptPaths.push(m[1]!.replace('res://', ''));
            }
          }
        }
      }
    } else {
      // A-07: Replaced inline collectScripts with scanFiles
      const scriptFiles = scanFiles(projectPath, ['.gd'], { skipDirs: [...SKIP_DIRS] });
      getLogger().debug('delivery', `scanFiles found ${scriptFiles.length} .gd files in ${projectPath}`);
      scriptPaths = scriptFiles.map(f => relative(projectPath, f));
    }

    // resolveScriptPath: scope=script 的 scriptPaths 含 resolveWithinRoot 解析后的绝对路径(:292),
    // join(projectPath, 绝对路径) 会二次拼接(projectPath/绝对路径) → 恒 not found。
    // (Node path.join 不像 resolve, 不处理绝对路径覆盖, 直接拼接)
    // 绝对路径直接用, 相对路径(scope=full 的 scanFiles 相对)才 join。统一此 helper 防 NEW-2/3 类漏改。
    const resolveScriptPath = (sp: string): string => isAbsolute(sp) ? sp : join(projectPath, sp);

    // Check file existence
    for (const sp of scriptPaths) {
      const fullPath = resolveScriptPath(sp);
      if (!existsSync(fullPath)) {
        issues.push({ severity: 'error', location: sp, message: `Script file not found: ${sp}` });
      }
    }

    // Check preload/load references (NEW-3: 绝对路径脚本的引用检查不再被裸 join 跳过)
    for (const sp of scriptPaths) {
      const fullPath = resolveScriptPath(sp);
      if (!existsSync(fullPath)) continue;
      const content = safeReadFile(fullPath);
      if (!content) continue;
      const preloadRegex = /(?:preload|load)\("res:\/\/([^"]+)"\)/g;
      let m: RegExpExecArray | null;
      while ((m = preloadRegex.exec(content)) !== null) {
        if (!existsSync(join(projectPath, m[1]!))) {
          issues.push({
            severity: 'warning',
            location: sp,
            message: `Resource not found: res://${m[1]!} (referenced by preload/load)`,
          });
        }
      }
    }

    // GDScript syntax validation via Godot headless parser (NEW-2: 绝对路径脚本不再被 filter 掉)
    const existingScripts = scriptPaths.filter(sp => existsSync(resolveScriptPath(sp)));
    if (existingScripts.length > 200) {
      issues.push({ severity: 'warning', location: '(script validation)', message: `Script count (${existingScripts.length}) exceeds 200 limit; validation skipped. Set scope='script' to validate individual files.` });
    }
    if (existingScripts.length > 0 && existingScripts.length <= 200) {
      try {
        const godot = await ctx.findGodot();
        const fullPaths = existingScripts.map(sp => resolveScriptPath(sp));
        const validateResults = await batchValidateScripts(godot, projectPath, fullPaths, 30000);
        for (const r of validateResults) {
          for (const err of r.errors) {
            issues.push({
              severity: 'error',
              location: r.file,
              message: `Syntax error: ${err}`,
            });
          }
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        getLogger().debug('delivery', `Script validation error: ${detail}`);
        issues.push({ severity: 'warning', location: '(script validation)', message: `GDScript syntax validation unavailable: ${detail}` });
      }
    }

    const passed = !hasErrors(issues);
    report.script_health = { passed, issues };
    dimensionResults.push({ dim: 'script_health', passed });
  }

  // ── Dimension 3: Performance/resource health ──
  if (perfCheck) {
    const godot = await ctx.findGodot();
    const perfScript = `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar _data: Dictionary = {}
\t_data["orphan_node_count"] = int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT))
\t_data["static_memory_mb"] = Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0
\t_data["resource_count"] = int(Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT))
\t_mcp_output("perf", _data)
\t_mcp_done()
`;
    const perfResult = await executeGdscript({
      godotPath: godot, projectPath, code: perfScript, timeout: PERF_TIMEOUT_S, loadAutoloads: false,
    });

    const perfIssues: Issue[] = [];
    let perfData: Record<string, unknown> = {};

    if (perfResult.compile_success && perfResult.run_success) {
      for (const entry of perfResult.outputs) {
        if (entry.key === 'perf') {
          try { perfData = JSON.parse(entry.value); } catch { perfData = { raw: entry.value }; }
        }
      }
      const orphans = (perfData.orphan_node_count as number) ?? 0;
      if (orphans > ORPHAN_WARNING_THRESHOLD) {
        perfIssues.push({
          severity: 'warning',
          location: '(project-wide)',
          message: `High orphan node count: ${orphans}`,
          suggestion: 'Check for nodes created without add_child or missing queue_free() calls',
        });
      }
    } else {
      perfIssues.push({ severity: 'warning', location: '(project-wide)', message: 'Performance snapshot unavailable' });
    }

    const perfPassed = !hasErrors(perfIssues);
    report.performance = { passed: perfPassed, issues: perfIssues, metrics: perfData };
    dimensionResults.push({ dim: 'performance', passed: perfPassed });
  }

  // ── Dimension 4: Custom behavior assertions ──
  if (assertions.length > 0) {
    if (assertions.length > MAX_ASSERTIONS) {
      report.assertions = { passed: false, results: [], error: 'Too many assertions (max 10)' };
      dimensionResults.push({ dim: 'assertions', passed: false });
    } else {
      const godot = await ctx.findGodot();
      const assertionResults: Array<Record<string, unknown>> = [];
      // 收集每个断言执行的原始 stdout（含 GD.Print "ASSERT PASS/FAIL" 协议），供 visual_proof 维度聚合
      const assertStdouts: string[] = [];

      // Execute each assertion independently for isolation
      for (let i = 0; i < assertions.length; i++) {
        const a = assertions[i]!;
        const desc = a.description ?? 'unnamed assertion';
        if (typeof a.gdscript !== 'string' || !a.gdscript.trim()) {
          assertionResults.push({ description: desc, passed: false, error: 'Missing required "gdscript" field in assertion' });
          continue;
        }
        try {
          const wrappedCode = wrapAssertionCode(a.gdscript, desc, true, a.expect);
          const assertResult = await executeGdscript({
            godotPath: godot, projectPath, code: wrappedCode, timeout: ASSERTION_TIMEOUT_S, loadAutoloads: false,
          });

          // 收集原始 stdout（无论成功失败，只要执行了就有输出）用于 ASSERT 协议解析
          if (assertResult.raw_output) {
            assertStdouts.push(assertResult.raw_output);
          }

          if (!assertResult.compile_success) {
            assertionResults.push({ description: desc, passed: false, error: assertResult.compile_error });
          } else if (!assertResult.run_success) {
            assertionResults.push({ description: desc, passed: false, error: assertResult.run_error });
          } else {
            const actual = String(assertResult.outputs.find(e => e.key.startsWith('assert_') || e.key === 'assert_result')?.value ?? '');
            const expected = a.expect;
            const passed = expected ? actual === expected : true;
            assertionResults.push({ description: desc, passed, actual, expected });
          }
        } catch (err) {
          assertionResults.push({ description: desc, passed: false, error: err instanceof Error ? err.message : String(err) });
        }
      }


      const allPassed = assertionResults.every(r => r.passed);
      report.assertions = { passed: allPassed, results: assertionResults };
      dimensionResults.push({ dim: 'assertions', passed: allPassed });

      // ── visual_proof 维度：聚合 ASSERT 协议（Godogen test-harness.md 范式）──
      // 把 assertions 维度执行时收集的 stdout 合并，解析 ASSERT PASS/FAIL 文本协议。
      // 失败仅影响 report.passed（软报告），不阻断 isError，保持向后兼容。
      const allAssertStdout = assertStdouts.join('\n');
      const assertSummary = parseAsserts(allAssertStdout);
      const visualProofIssues: string[] = [];
      if (!assertSummary.passed) {
        if (assertSummary.passCount === 0 && assertSummary.failCount === 0) {
          visualProofIssues.push('no ASSERT PASS/FAIL evidence found in runtime stdout');
        }
        for (const f of assertSummary.fails) {
          visualProofIssues.push(`ASSERT FAIL: ${f}`);
        }
      }
      report.visual_proof = {
        passed: assertSummary.passed,
        assert_summary: assertSummary,
        issues: visualProofIssues,
      };
      dimensionResults.push({ dim: 'visual_proof', passed: assertSummary.passed });
    }
  } else {
    // assertions 维度未运行（无断言）—— visual_proof graceful 处理：不阻断 report.passed
    report.visual_proof = {
      passed: true,
      assert_summary: { passCount: 0, failCount: 0, fails: [], passed: false },
      issues: ['no assertions run; visual_proof skipped'],
    };
  }

  // ── Dimension 5: GDD standards ──
  const effectiveGddStandards = checks.gdd_standards === true
    || (checks.gdd_standards !== false && scope === 'full' && existsSync(join(projectPath, 'design')));

  if (effectiveGddStandards) {
    const { validateGDD } = await import('./game-design.js');
    const gddDirs = (checks.gdd_dirs as string[]) || ['design/gdd'];
    const gddIssues: Issue[] = [];
    let gddFilesScanned = 0;

    for (const gddDir of gddDirs) {
      const fullDir = resolveWithinRoot(projectPath, gddDir);
      if (!existsSync(fullDir)) {
        gddIssues.push({
          severity: 'warning',
          location: gddDir,
          message: `GDD directory not found: ${gddDir}`,
          suggestion: 'Create design/gdd/ directory for game design documents',
        });
        continue;
      }

      // A-07: Replaced inline collectGddFiles with scanFiles
      const gddFileList = scanFiles(fullDir, ['.md'], { skipDirs: [...SKIP_DIRS] });
      const gddFiles = gddFileList.map(f => relative(fullDir, f));
      gddFilesScanned += gddFiles.length;

      for (const gf of gddFiles) {
        const content = safeReadFile(join(fullDir, gf));
        if (!content) continue;
        const validation = validateGDD(content);
        for (const issue of validation.issues) {
          gddIssues.push({
            severity: issue.severity,
            location: `${gddDir}/${gf}:${issue.location}`,
            message: issue.message,
            suggestion: issue.suggestion,
          });
        }
      }
    }

    const gddPassed = !hasErrors(gddIssues);
    report.gdd_standards = {
      passed: gddPassed,
      files_scanned: gddFilesScanned,
      issues: gddIssues,
    };
    dimensionResults.push({ dim: 'gdd_standards', passed: gddPassed });
  }

  // ── Summary ──
  const passedCount = dimensionResults.filter(d => d.passed).length;
  const totalCount = dimensionResults.length;
  report.passed = dimensionResults.every(d => d.passed);
  report.summary = `${passedCount}/${totalCount} dimensions passed`;

  // 双轨输出：各维度 issue 归一化为统一列表 + 尾部紧凑 JSON
  const dimLabels: Record<string, string> = {
    scene_tree: 'Scene Tree', script_health: 'Script Health', performance: 'Performance',
    assertions: 'Assertions', visual_proof: 'Visual Proof', gdd_standards: 'GDD Standards',
  };
  const allIssues: NormalizedIssue[] = [];
  for (const [dim, label] of Object.entries(dimLabels)) {
    const d = report[dim] as { passed?: boolean; issues?: Array<{ severity?: string; location?: string; message?: string; suggestion?: string } | string> | undefined } | undefined;
    if (!d) continue;
    const dimIssues = (d.issues ?? []).map((it): NormalizedIssue => {
      if (typeof it === 'string') {
        return { severity: 'warning', location: dim, message: it };
      }
      return {
        severity: it.severity ?? 'warning',
        location: it.location ?? dim,
        message: it.message ?? '',
        suggestion: it.suggestion,
      };
    });
    for (const iss of dimIssues) {
      allIssues.push({ ...iss, location: `[${label}] ${iss.location}` });
    }
  }
  const header = `Delivery verification: ${report.passed ? '✓ passed' : '✗ failed'} (${report.summary})\n\n`;
  const humanText = allIssues.length > 0
    ? header + formatIssues(allIssues, { truncate: 50 })
    : header + 'No issues found.';
  return textResult(dualTrackOutput(humanText, report));
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  verify_delivery: { readonly: true, long_running: true },
};

// ─── Re-export for validation.ts absorption ──────────────────────────────────

export async function handleVerifyDelivery(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  return handleTool('verify_delivery', args, ctx);
}
