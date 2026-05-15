import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath, resolveWithinRoot, normalizeUserProjectPath, ensureDir } from '../helpers.js';
import { analyzeOutput } from '../error-analyzer.js';
import { batchValidateScripts } from './validation.js';
import { parseTscn } from '../tscn-parser.js';

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'batch_create_files',
      description: 'Batch create multiple files. Supports auto-validation of .gd files after creation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          files: {
            type: 'array',
            description: 'Array of files to create',
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
          validate: { type: 'boolean', description: 'Validate .gd files after creation (default: true)', default: true },
        },
        required: ['project_path', 'files'],
      },
    },
    {
      name: 'batch_run_verify',
      description: 'Run headless verification on multiple scenes, returning a summary report.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scenes: {
            type: 'array',
            description: 'Array of scene paths relative to project',
            items: { type: 'string' },
          },
          timeout: { type: 'number', description: 'Timeout per scene in seconds (default: 10)', default: 10 },
          capture_tree: { type: 'boolean', description: 'Capture scene tree snapshot (default: false)', default: false },
        },
        required: ['project_path', 'scenes'],
      },
    },
    {
      name: 'diff_scenes',
      description: 'Compare two scene files and report node tree differences.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_a: { type: 'string', description: 'First scene path relative to project' },
          scene_b: { type: 'string', description: 'Second scene path relative to project' },
          ignore_properties: {
            type: 'array',
            description: 'Property names to ignore in diff (default: metadata/_edit_lock)',
            items: { type: 'string' },
            default: ['metadata/_edit_lock'],
          },
        },
        required: ['project_path', 'scene_a', 'scene_b'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

const TOOL_NAMES = ['batch_create_files', 'batch_run_verify', 'diff_scenes'] as const;

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'batch_create_files': {
      const projectPath = validatePath(args.project_path as string);
      const files = args.files as Array<{ path: string; content: string; overwrite?: boolean }>;
      const doValidate = args.validate !== false;

      if (!files || !Array.isArray(files) || files.length === 0) {
        return textResult('Error: "files" must be a non-empty array.');
      }

      const created: string[] = [];
      const skipped: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      const gdFiles: string[] = [];

      for (const f of files) {
        const relPath = normalizeUserProjectPath(f.path);
        const absPath = resolveWithinRoot(projectPath, relPath);

        if (existsSync(absPath) && !f.overwrite) {
          skipped.push(relPath);
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

      return textResult(JSON.stringify(result, null, 2));
    }

    case 'batch_run_verify': {
      const projectPath = validatePath(args.project_path as string);
      const scenes = args.scenes as string[];
      const timeout = (args.timeout as number) || 10;
      const captureTree = args.capture_tree === true;

      if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
        return textResult('Error: "scenes" must be a non-empty array of scene paths.');
      }

      const godot = await ctx.findGodot();
      const results: Array<Record<string, unknown>> = [];

      let passed = 0;
      let failed = 0;
      let timedOut = 0;

      for (const scene of scenes) {
        const sceneFullPath = join(projectPath, scene);
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
      const projectPath = validatePath(args.project_path as string);
      const sceneA = args.scene_a as string;
      const sceneB = args.scene_b as string;
      const ignoreProps = new Set((args.ignore_properties as string[]) || ['metadata/_edit_lock']);

      const absA = resolveWithinRoot(projectPath, sceneA);
      const absB = resolveWithinRoot(projectPath, sceneB);

      if (!existsSync(absA)) {
        return textResult(`Error: Scene A not found: ${sceneA}`);
      }
      if (!existsSync(absB)) {
        return textResult(`Error: Scene B not found: ${sceneB}`);
      }

      const parsedA = parseTscn(readFileSync(absA, 'utf-8'));
      const parsedB = parseTscn(readFileSync(absB, 'utf-8'));

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
      return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function runSingleVerify(
  godot: string,
  projectPath: string,
  scene: string,
  timeoutSec: number,
  captureTree: boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let out = '';
    const sceneArg = `res://${scene.replace(/\\/g, '/')}`;
    const proc = spawn(godot, ['--headless', '--path', projectPath, sceneArg], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGTERM');
      resolve({ scene, status: 'timed_out' });
    }, timeoutSec * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const analysis = analyzeOutput(out.split('\n'));
      const result: Record<string, unknown> = {
        scene,
        status: code === 0 && !analysis.hasErrors ? 'passed' : 'failed',
        error_count: analysis.errors.length,
        errors: analysis.errors.map(e => e.message).slice(0, 10),
      };

      if (captureTree) {
        const treeMatch = out.match(/=== Scene Tree ===([\s\S]*?)===/);
        if (treeMatch) {
          result.tree = { raw: treeMatch[1].trim() };
        }
      }

      resolve(result);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ scene, status: 'error', errors: [err.message] });
    });
  });
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
  batch_create_files: { readonly: false, long_running: true },
  batch_run_verify: { readonly: true, long_running: true },
  diff_scenes: { readonly: true, long_running: false },
};
