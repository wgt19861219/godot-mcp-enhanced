import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { forceKillTree } from '../core/process-state.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, parseGdscriptResult } from './shared.js';
import { gdEscape } from './shared.js';
import { batchValidateScripts, type BatchValidateResult } from './validation.js';

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'dev_loop',
      description: 'Run a development loop: execute GDScript code, optionally validate project, and capture structured output in one step.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          code: { type: 'string', description: 'GDScript code to execute (snippet or full extends SceneTree)' },
          verify: { type: 'boolean', description: 'Also run project validation after execution (default: false)', default: false },
          timeout: { type: 'number', description: 'Timeout per step in seconds (default: 30)', default: 30 },
          load_autoloads: { type: 'boolean', description: 'Load Autoload context (default: true)', default: true },
        },
        required: ['project_path', 'code'],
      },
    },
    {
      name: 'scene_snapshot',
      description: 'Capture a structured snapshot of a scene tree for before/after comparison.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene_path: { type: 'string', description: 'Scene file path relative to project' },
          max_depth: { type: 'number', description: 'Max tree depth (default: 5)', default: 5 },
        },
        required: ['project_path', 'scene_path'],
      },
    },
    {
      name: 'batch_validate',
      description: 'Validate multiple GDScript files at once. Returns per-file results with error details.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scripts: {
            type: 'array',
            description: 'Array of script paths relative to project',
            items: { type: 'string' },
          },
        },
        required: ['project_path', 'scripts'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

const TOOL_NAMES = ['dev_loop', 'scene_snapshot', 'batch_validate'] as const;

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'dev_loop': {
      const projectPath = validatePath(args.project_path as string);
      const code = args.code as string;
      const verify = args.verify === true;
      const timeout = (args.timeout as number) || 30;
      const loadAutoloads = args.load_autoloads !== false;

      if (!code || typeof code !== 'string') {
        return textResult('Error: "code" must be a non-empty string.');
      }

      const godot = await ctx.findGodot();
      const execResult = await executeGdscript({
        godotPath: godot,
        projectPath,
        code,
        timeout,
        loadAutoloads,
      });

      const result: Record<string, unknown> = {
        step1_execute: execResult.compile_success ? 'success' : 'compile_error',
      };

      if (!execResult.compile_success) {
        result.compile_error = execResult.compile_error;
        return textResult(JSON.stringify(result, null, 2));
      }

      if (!execResult.run_success) {
        result.step1_execute = 'runtime_error';
        result.run_error = execResult.run_error;
        return textResult(JSON.stringify(result, null, 2));
      }

      const outputs: Record<string, unknown> = {};
      for (const entry of execResult.outputs) {
        try {
          outputs[entry.key] = JSON.parse(entry.value);
        } catch {
          outputs[entry.key] = entry.value;
        }
      }
      result.outputs = outputs;

      if (verify) {
        result.step2_verify = await runVerification(godot, projectPath);
      }

      return textResult(JSON.stringify(result, null, 2));
    }

    case 'scene_snapshot': {
      const projectPath = validatePath(args.project_path as string);
      const scenePath = args.scene_path as string;
      const maxDepth = (args.max_depth as number) || 5;
      const godot = await ctx.findGodot();

      const safePath = gdEscape(scenePath);
      const snapScript = `${SCENE_TREE_HEADER}

func _initialize():
\tvar packed := load("${safePath}")
\tif packed == null:
\t\t_mcp_output("error", "Failed to load scene: ${safePath}")
\t\t_mcp_done()
\t\treturn
\tvar instance: Node = packed.instantiate()
\t_mcp_get_root().add_child(instance)
\tvar data := _snap(instance, ${maxDepth}, 0)
\t_mcp_output("snapshot", data)
\tinstance.queue_free()
\t_mcp_done()

func _snap(node: Node, max_depth: int, depth: int) -> Dictionary:
\tvar info := {"name": node.name, "type": node.get_class()}
\tif node is Node2D:
\t\tinfo["position"] = {"x": node.position.x, "y": node.position.y}
\t\tinfo["rotation"] = node.rotation
\tif node is Node3D:
\t\tinfo["position"] = {"x": node.position.x, "y": node.position.y, "z": node.position.z}
\tif depth < max_depth:
\t\tvar ch: Array = []
\t\tfor c in node.get_children():
\t\t\tch.append(_snap(c, max_depth, depth + 1))
\t\tinfo["child_count"] = ch.size()
\treturn info
`;

      const result = await executeGdscript({
        godotPath: godot,
        projectPath,
        code: snapScript,
        timeout: 30,
        loadAutoloads: false,
      });

      return parseGdscriptResult(result, [], () => 'SNAPSHOT_FAILED');
    }

    case 'batch_validate': {
      const projectPath = validatePath(args.project_path as string);
      const scripts = args.scripts as string[];

      if (!scripts || !Array.isArray(scripts) || scripts.length === 0) {
        return textResult('Error: "scripts" must be a non-empty array of file paths.');
      }

      const godot = await ctx.findGodot();
      const pathSep = process.platform === 'win32' ? '\\' : '/';
      const relOf = (absPath: string) => absPath.replace(projectPath + pathSep, '');
      const fullPaths: string[] = [];
      const missing: string[] = [];

      for (const s of scripts) {
        const full = join(projectPath, s);
        if (existsSync(full)) {
          fullPaths.push(full);
        } else {
          missing.push(s);
        }
      }

      const batchResults = await batchValidateScripts(godot, projectPath, fullPaths, 15000);

      const results: Record<string, unknown> = {};
      let allValid = true;
      let totalFiltered = 0;

      for (const r of batchResults) {
        results[r.file] = r.errors.length > 0 ? { valid: false, error: r.errors } : { valid: true };
        if (r.errors.length > 0) allValid = false;
        if (r.filtered_count) totalFiltered += r.filtered_count;
      }
      for (const m of missing) {
        results[m] = { valid: false, error: 'File not found' };
        allValid = false;
      }

      const summary: Record<string, unknown> = { all_valid: allValid, total: scripts.length, results };
      if (totalFiltered > 0) summary.filtered_count = totalFiltered;

      return textResult(JSON.stringify(summary, null, 2));
    }

    default:
      return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function runVerification(godot: string, projectPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(godot, ['--headless', '--path', projectPath, '-e', '--quit'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

    const timer = setTimeout(() => {
      if (!proc.killed) forceKillTree(proc);
      resolve({ status: 'timeout', output: out.slice(-2000) });
    }, 20000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const errors = out.split('\n').filter(l => l.includes('ERROR') || l.includes('SCRIPT ERROR'));
      resolve({
        status: code === 0 ? 'passed' : 'failed',
        exit_code: code,
        error_count: errors.length,
        errors: errors.slice(0, 10),
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'error', message: err.message });
    });
  });
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  dev_loop: { readonly: false, long_running: true },
  scene_snapshot: { readonly: true, long_running: false },
  batch_validate: { readonly: true, long_running: false },
};
