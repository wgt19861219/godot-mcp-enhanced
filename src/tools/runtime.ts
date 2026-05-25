import { spawn } from 'child_process';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { appendOutput, clearOutputBuffer, killProcess, setProcessBusy } from '../core/process-state.js';
import { validatePath, checkVersionMismatch } from '../helpers.js';
import { existsSync } from 'fs';
import { join } from 'path';

const TOOL_NAMES = [
  'launch_editor',
  'run_project',
  'stop_project',
  'get_debug_output',
  'run_tests',
  'get_godot_version',
] as const;

// ─── classifyOutput helper ──────────────────────────────────────────────────

function classifyOutput(lines: string[]): {
  errors: string[];
  warnings: string[];
  prints: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prints: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('error') || lower.includes('exception') || lower.includes('traceback')) {
      errors.push(line);
    } else if (lower.includes('warning') || lower.includes('warn')) {
      warnings.push(line);
    } else {
      prints.push(line);
    }
  }

  return { errors, warnings, prints };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'launch_editor',
      description: 'Launch the Godot editor GUI for a project.',
      inputSchema: {
        type: 'object' as const,
        properties: { project_path: { type: 'string', description: 'Path to Godot project directory' } },
        required: ['project_path'],
      },
    },
    {
      name: 'run_project',
      description: 'Run a Godot project in debug mode, capturing output. Supports timeout to auto-stop.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          timeout: { type: 'number', description: 'Auto-stop after N seconds (default: 30)', default: 30 },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'stop_project',
      description: 'Stop the currently running Godot project and return categorized output.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'get_debug_output',
      description: 'Get structured debug output (errors first) from the running project.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'run_tests',
      description: 'Run GUT unit tests and parse results.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          test_script: { type: 'string', description: 'Path to test script or directory (res://test/)', default: 'res://test/' },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'get_godot_version',
      description: 'Get the Godot engine version.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'launch_editor': {
      const p = validatePath(args.project_path as string);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      const godot = await ctx.findGodot();
      const child = spawn(godot, ['--editor', '--path', p], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        console.error(`[runtime] Failed to launch editor: ${err.message}`);
      });
      child.unref();
      return textResult(`Launched Godot editor for project: ${p}`);
    }

    case 'run_project': {
      const p = validatePath(args.project_path as string);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      const timeout = Math.max(5, Number(args.timeout) || 30);
      const godot = await ctx.findGodot();

      // Version mismatch warning
      const versionWarning = await checkVersionMismatch(p, godot);
      const warnPrefix = versionWarning ? versionWarning + '\n' : '';

      // Stop existing
      if (ctx.runningProcess) {
        setProcessBusy(false);
        await killProcess(ctx.runningProcess);
        ctx.setRunningProcess(null);
      }

      ctx.setProjectDir(p);
      clearOutputBuffer();
      ctx.setProcessStartTime(Date.now());

      const proc = spawn(godot, ['--path', p, '--debug'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (data: Buffer) => {
        appendOutput(data.toString().split('\n'));
      });
      proc.stderr?.on('data', (data: Buffer) => {
        appendOutput(data.toString().split('\n'));
      });

      // Auto-stop after timeout
      let autoStopTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeout > 0) {
        autoStopTimer = setTimeout(() => {
          if (ctx.runningProcess === proc) {
            setProcessBusy(false);
            void killProcess(proc);
            ctx.setRunningProcess(null);
          }
        }, timeout * 1000);
      }

      proc.on('close', () => {
        setProcessBusy(false);
        ctx.setRunningProcess(null);
        if (autoStopTimer) clearTimeout(autoStopTimer);
      });

      proc.on('error', (err) => {
        setProcessBusy(false);
        ctx.setRunningProcess(null);
        if (autoStopTimer) clearTimeout(autoStopTimer);
        appendOutput([`Spawn error: ${err.message}`]);
      });

      ctx.setRunningProcess(proc);
      setProcessBusy(true);

      return textResult(warnPrefix + `Running project at ${p} (timeout: ${timeout}s). Use get_debug_output or stop_project to check.`);
    }

    case 'stop_project': {
      if (!ctx.runningProcess) {
        return textResult('No project is currently running.');
      }
      await killProcess(ctx.runningProcess);
      setProcessBusy(false);
      ctx.setRunningProcess(null);

      const classified = classifyOutput(ctx.outputBuffer);
      const result = {
        status: 'stopped',
        runtime: `${((Date.now() - ctx.processStartTime) / 1000).toFixed(1)}s`,
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: ctx.outputBuffer.length,
      };
      clearOutputBuffer();
      return textResult(JSON.stringify(result, null, 2));
    }

    case 'get_debug_output': {
      if (ctx.outputBuffer.length === 0 && !ctx.runningProcess) {
        return textResult('No debug output available. Run a project first.');
      }
      const classified = classifyOutput(ctx.outputBuffer);
      const result = {
        running: ctx.runningProcess !== null,
        runtime: `${((Date.now() - ctx.processStartTime) / 1000).toFixed(1)}s`,
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: ctx.outputBuffer.length,
      };
      return textResult(JSON.stringify(result, null, 2));
    }

    case 'run_tests': {
      const p = validatePath(args.project_path as string);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      const testScript = (args.test_script as string) || 'res://test/';
      const godot = await ctx.findGodot();

      return new Promise((resolve) => {
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', 'addons/gut/gut_cmdln.gd',
          '-gdir', testScript,
          '-gquit',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        let out = '';
        proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

        const timer = setTimeout(() => {
          if (!proc.killed) void killProcess(proc);
        }, 120000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          const passed = (out.match(/Tests: (\d+)/g) || []).map(m => m.replace('Tests: ', ''));
          const failed = (out.match(/Failed: (\d+)/g) || []).map(m => m.replace('Failed: ', ''));
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify({
                exit_code: code,
                passed: passed.join(', '),
                failed: failed.join(', '),
                raw_output: out,
              }, null, 2),
            }],
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
        });
      });
    }

    case 'get_godot_version': {
      const godot = await ctx.findGodot();
      return new Promise((resolve) => {
        const proc = spawn(godot, ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.on('close', () => {
          resolve({ content: [{ type: 'text', text: out.trim() }] });
        });
        proc.on('error', (err) => {
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
        });
      });
    }

    default:
      return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  launch_editor: { readonly: false, long_running: false },
  run_project: { readonly: false, long_running: false },
  stop_project: { readonly: false, long_running: false },
  get_debug_output: { readonly: true, long_running: false },
  run_tests: { readonly: false, long_running: true },
  get_godot_version: { readonly: true, long_running: false },
};
