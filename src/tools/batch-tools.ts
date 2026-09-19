import { existsSync, writeFileSync, readFileSync } from 'fs';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { opsErrorResult, validateTimeout } from './shared.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath, ensureDir } from '../helpers.js';
import { analyzeOutput } from '../error-analyzer.js';
import { batchValidateScripts } from './validation.js';
import { lintGDScript, formatLintResults } from './gdscript-lint.js';
import { parseTscn } from '../tscn/tscn-parser.js';
import { spawnGodot } from './spawn-helper.js';
import { scanScriptSandboxOrThrow } from './script.js';

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  console.warn(`[DEPRECATED] batch-tools module is absorbed into workflow. Do not register directly.`);
  return [
    {
      name: 'batch',
      description: '批量操作。create_files: 批量创建文件（支持自动验证 .gd）。run_verify: 批量运行 headless 验证场景。diff_scenes: 比较两个场景文件差异。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          files: {
            type: 'array',
            description: 'create_files: Array of files to create',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path (e.g. res://scripts/player.gd)' },
                content: { type: 'string', description: 'File content' },
                overwrite: { type: 'boolean', description: 'Overwrite if exists (default: false)', default: false },
              },
              required: ['path', 'content'],
            },
          },
          validate: { type: 'boolean', description: 'create_files: Validate .gd files after creation (default: true)', default: true },
          scenes: {
            type: 'array',
            description: 'run_verify: Array of scene paths relative to project',
            items: { type: 'string' },
          },
          timeout: { type: 'number', description: 'run_verify: Timeout per scene in seconds (default: 10)', default: 10 },
          capture_tree: { type: 'boolean', description: 'run_verify: Capture scene tree snapshot (default: false)', default: false },
          scene_a: { type: 'string', description: 'diff_scenes: First scene path relative to project' },
          scene_b: { type: 'string', description: 'diff_scenes: Second scene path relative to project' },
          ignore_properties: {
            type: 'array',
            description: 'diff_scenes: Property names to ignore in diff (default: metadata/_edit_lock)',
            items: { type: 'string' },
            default: ['metadata/_edit_lock'],
          },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

const ACTIONS = ['create_files', 'run_verify', 'diff_scenes'] as const;

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'batch') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', '"action" is required.');

  switch (action) {
    case 'create_files': {
      const projectPath = requireProjectPath(args);
      const files = args.files as Array<{ path: string; content: string; overwrite?: boolean }>;
      const doValidate = args.validate !== false;

      if (!files || !Array.isArray(files) || files.length === 0) {
        return opsErrorResult('INVALID_PARAMS', '"files" must be a non-empty array.');
      }

      // H-06: 批量文件限制 — 防止 OOM
      const MAX_FILE_COUNT = 50;
      const MAX_FILE_SIZE = 1_000_000; // 1 MB per file

      if (files.length > MAX_FILE_COUNT) {
        return opsErrorResult('INVALID_PARAMS', `Too many files: ${files.length}. Maximum is ${MAX_FILE_COUNT}.`);
      }
      const oversized = files.find(f => typeof f.content === 'string' && f.content.length > MAX_FILE_SIZE);
      if (oversized) {
        return opsErrorResult('INVALID_PARAMS', `File "${oversized.path}" exceeds maximum size of ${MAX_FILE_SIZE} bytes.`);
      }

      const created: string[] = [];
      const skipped: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      const gdFiles: string[] = [];

      for (const f of files) {
        if (!f.path || typeof f.path !== 'string') {
          failed.push({ path: f.path ? String(f.path) : '<missing>', error: 'Invalid or missing path' });
          continue;
        }
        if (f.content == null || typeof f.content !== 'string') {
          failed.push({ path: f.path, error: 'Invalid or missing content (must be a string)' });
          continue;
        }
        const relPath = normalizeUserProjectPath(f.path);
        const absPath = resolveWithinRoot(projectPath, relPath);

        if (existsSync(absPath) && !f.overwrite) {
          skipped.push(relPath);
          continue;
        }

        // B-1 (SEC-P1-1): create_files 写 .gd 前过沙箱扫描(此前裸 writeFileSync 绕过;
        // 后置 batchValidateScripts 仅语法 parse + lint 不扫危险 API)。危险 .gd 拒写入
        // failed(其余文件继续批处理);非 .gd 路径 scanScriptSandboxOrThrow 直接放行不受影响。
        const sandboxGuard = scanScriptSandboxOrThrow(f.content, absPath);
        if (sandboxGuard) {
          // opsErrorResult 的 content[0] 恒为 text 块,但类型联合不保证,运行时判别收窄
          const guardBlock = sandboxGuard.content[0];
          const guardMsg = guardBlock && guardBlock.type === 'text' ? guardBlock.text : 'SANDBOX_VIOLATION';
          failed.push({ path: relPath, error: guardMsg });
          continue;
        }

        try {
          ensureDir(absPath);
          writeFileSync(absPath, f.content, 'utf-8');
          created.push(relPath);
          if (relPath.endsWith('.gd')) {
            gdFiles.push(absPath);
          }
        } catch (e: unknown) {
          failed.push({ path: relPath, error: (e as Error).message });
        }
      }

      const result: Record<string, unknown> = {
        created: created.length,
        skipped: skipped.length,
        failed: failed.length,
        details: { created, skipped, failed },
      };

      if (doValidate && gdFiles.length > 0) {
        const godot = await ctx.findGodot();
        const batchResults = await batchValidateScripts(godot, projectPath, gdFiles, 15000);
        const validationErrors: Record<string, string[]> = {};
        for (const r of batchResults) {
          if (r.errors.length > 0) {
            const pathSep = process.platform === 'win32' ? '\\' : '/';
            const rel = r.file.replace(projectPath + pathSep, '');
            validationErrors[rel] = r.errors;
          }
        }
        if (Object.keys(validationErrors).length > 0) {
          result.validation_errors = validationErrors;
        }
      }

      const lintParts: string[] = [];
      for (const f of files) {
        if (f.path.endsWith('.gd') && !skipped.includes(normalizeUserProjectPath(f.path)) && !failed.some(e => e.path === normalizeUserProjectPath(f.path))) {
          const lintOutput = lintGDScript(f.content as string);
          const fmt = formatLintResults(lintOutput);
          if (fmt) lintParts.push(`[${f.path}]${fmt}`);
        }
      }
      const lintSummary = lintParts.length > 0 ? '\n\nLint Results:\n' + lintParts.join('\n') : '';

      return textResult(JSON.stringify(result, null, 2) + lintSummary);
    }

    case 'run_verify': {
      const projectPath = requireProjectPath(args);
      const scenes = args.scenes as string[];
      const timeout = validateTimeout(args.timeout, 1, 60, 10);
      const captureTree = args.capture_tree === true;

      if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
        return opsErrorResult('INVALID_PARAMS', '"scenes" must be a non-empty array of scene paths.');
      }

      const godot = await ctx.findGodot();
      const results: Array<Record<string, unknown>> = [];

      let passed = 0;
      let failed = 0;
      let timedOut = 0;

      for (const scene of scenes) {
        const normalizedScene = normalizeUserProjectPath(scene);
        const sceneFullPath = resolveWithinRoot(projectPath, normalizedScene);
        if (!existsSync(sceneFullPath)) {
          results.push({ scene, status: 'error', errors: ['File not found'] });
          failed++;
          continue;
        }

        const r = await runSingleVerify(godot, projectPath, scene, timeout, captureTree);
        results.push(r);
        if (r.status === 'passed') passed++;
        else if (r.status === 'timed_out') timedOut++;
        else failed++;
      }

      return textResult(JSON.stringify({
        total: scenes.length,
        passed,
        failed,
        timed_out: timedOut,
        results,
      }, null, 2));
    }

    case 'diff_scenes': {
      const projectPath = requireProjectPath(args);
      const sceneA = args.scene_a as string;
      const sceneB = args.scene_b as string;
      const ignoreProps = new Set((args.ignore_properties as string[]) || ['metadata/_edit_lock']);

      const absA = resolveWithinRoot(projectPath, normalizeUserProjectPath(sceneA));
      const absB = resolveWithinRoot(projectPath, normalizeUserProjectPath(sceneB));

      if (!existsSync(absA)) {
        return opsErrorResult('NOT_FOUND', `Scene A not found: ${sceneA}`);
      }
      if (!existsSync(absB)) {
        return opsErrorResult('NOT_FOUND', `Scene B not found: ${sceneB}`);
      }

      let parsedA: ReturnType<typeof parseTscn>;
      let parsedB: ReturnType<typeof parseTscn>;
      try {
        parsedA = parseTscn(readFileSync(absA, 'utf-8'));
        parsedB = parseTscn(readFileSync(absB, 'utf-8'));
      } catch (e: unknown) {
        return opsErrorResult('EXEC_FAILED', `Error reading scene files: ${(e as Error).message}`);
      }

      const mapA = parsedA.nodeMap;
      const mapB = parsedB.nodeMap;

      const added: string[] = [];
      const removed: string[] = [];
      const modified: Array<{ path: string; changes: string[] }> = [];

      for (const [path, nodeB] of mapB) {
        if (!mapA.has(path)) {
          added.push(`${path} [${nodeB.type}]`);
        }
      }

      for (const [path, nodeA] of mapA) {
        if (!mapB.has(path)) {
          removed.push(`${path} [${nodeA.type}]`);
        }
      }

      for (const [path, nodeA] of mapA) {
        const nodeB = mapB.get(path);
        if (!nodeB) continue;

        const changes: string[] = [];

        if (nodeA.type !== nodeB.type) {
          changes.push(`type: ${nodeA.type} → ${nodeB.type}`);
        }

        const propsA = filterProps(nodeA.properties, ignoreProps);
        const propsB = filterProps(nodeB.properties, ignoreProps);

        const allKeys = new Set([...propsA.keys(), ...propsB.keys()]);
        for (const key of allKeys) {
          const valA = propsA.get(key);
          const valB = propsB.get(key);
          if (valA === undefined && valB !== undefined) {
            changes.push(`+${key}: ${formatPropVal(valB)}`);
          } else if (valA !== undefined && valB === undefined) {
            changes.push(`-${key}: ${formatPropVal(valA)}`);
          } else if (JSON.stringify(valA) !== JSON.stringify(valB)) {
            changes.push(`${key}: ${formatPropVal(valA)} → ${formatPropVal(valB)}`);
          }
        }

        if (changes.length > 0) {
          modified.push({ path, changes });
        }
      }

      const summary = `Nodes: ${mapA.size} → ${mapB.size} | Added: ${added.length} | Removed: ${removed.length} | Modified: ${modified.length}`;

      return textResult(JSON.stringify({ summary, added, removed, modified }, null, 2));
    }

    default:
      return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function runSingleVerify(
  godot: string,
  projectPath: string,
  scene: string,
  timeoutSec: number,
  captureTree: boolean,
): Promise<Record<string, unknown>> {
  const sceneArg = `res://${scene.replace(/\\/g, '/')}`;
  const result = await spawnGodot(godot, ['--headless', '--path', projectPath, sceneArg], {
    timeoutMs: timeoutSec * 1000,
  });

  if (result.timedOut) {
    return { scene, status: 'timed_out' };
  }

  if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) {
    return { scene, status: 'error', errors: [result.stdout.replace('SPAWN_FAILED: ', '')] };
  }

  const analysis = analyzeOutput(result.stdout.split('\n'));
  const entry: Record<string, unknown> = {
    scene,
    status: (result.exitCode === 0 && !analysis.hasErrors) ? 'passed' : 'failed',
    error_count: analysis.errors.length,
    errors: analysis.errors.map(e => e.message).slice(0, 10),
  };

  if (captureTree) {
    const treeMatch = result.stdout.match(/=== Scene Tree ===([\s\S]*?)===/);
    if (treeMatch) {
      entry.tree = { raw: treeMatch[1]!.trim() };
    }
  }

  return entry;
}

function filterProps(
  props: Array<{ name: string; type: string; value: unknown }>,
  ignore: Set<string>,
): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const p of props) {
    if (!ignore.has(p.name)) {
      map.set(p.name, p.value);
    }
  }
  return map;
}

function formatPropVal(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  batch: { readonly: false, long_running: false },
};

// ─── Re-export for workflow.ts absorption ────────────────────────────────────

export async function handleBatchAction(action: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  return handleTool('batch', { ...args, action }, ctx);
}
