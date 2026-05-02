import { spawn } from 'child_process';
import { join, dirname, resolve as pathResolve } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath, resolveWithinRoot, parseMcpScriptOutput, normalizeUserProjectPath } from '../helpers.js';
import { analyzeOutput } from '../error-analyzer.js';

const execFileAsync = promisify(execFile);

const TOOL_NAMES = [
  'run_and_verify',
  'analyze_error',
  'validate_project',
  'validate_scripts',
  'import_resources',
] as const;

// ─── Version mismatch detection ────────────────────────────────────────────

async function checkVersionMismatch(projectPath: string, godotBin: string): Promise<string | null> {
  try {
    const configPath = join(projectPath, 'project.godot');
    if (!existsSync(configPath)) return null;
    const config = readFileSync(configPath, 'utf-8');
    const featuresMatch = config.match(/config\/features=PackedStringArray\("([^"]+)"\)/);
    if (!featuresMatch) return null;
    const projectVersion = featuresMatch[1];

    const { stdout, stderr } = await execFileAsync(godotBin, ['--version'], { timeout: 5000 });
    const binVersion = (stdout || stderr || '').trim();
    const binMatch = binVersion.match(/^(\d+\.\d+)/);
    if (!binMatch) return null;
    const binMajorMinor = binMatch[1];

    if (projectVersion !== binMajorMinor) {
      return `⚠ Version mismatch: project.godot expects Godot ${projectVersion}, but binary is ${binVersion} (${binMajorMinor}). Errors may be inaccurate.`;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Script file collection ────────────────────────────────────────────────

function collectScriptFiles(projectPath: string, excludeDirs: string[] = ['.godot', '.import', 'addons', 'tools']): string[] {
  const results: string[] = [];
  function scan(dir: string, depth: number): void {
    if (depth > 15) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (excludeDirs.includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else if (entry.name.endsWith('.gd')) {
          results.push(full);
        }
      }
    } catch { /* skip */ }
  }
  scan(projectPath, 0);
  return results;
}

// ─── Batch script validation ────────────────────────────────────────────────

async function batchValidateScripts(
  godotPath: string,
  projectPath: string,
  scriptFiles: string[],
  globalTimeoutMs: number = 15000
): Promise<Array<{ file: string; errors: string[] }>> {
  if (scriptFiles.length === 0) return [];

  let effectiveGodotPath = godotPath;
  if (process.platform === 'win32' && !godotPath.endsWith('_console.exe')) {
    const consolePath = godotPath.replace(/\.exe$/, '_console.exe');
    if (existsSync(consolePath)) {
      effectiveGodotPath = consolePath;
    }
  }

  const pathSep = process.platform === 'win32' ? '\\' : '/';
  const relOf = (absPath: string) => absPath.replace(projectPath + pathSep, '');
  const scriptRels = scriptFiles.map(relOf);
  const resPaths = scriptRels.map(rel => 'res://' + rel.replace(/\\/g, '/'));

  const tmpDir = join(tmpdir(), 'godot-mcp-exec');
  mkdirSync(tmpDir, { recursive: true });
  const listId = Math.random().toString(36).substring(2, 10);
  const listPath = join(tmpDir, `validate-list-${listId}.json`).replace(/\\/g, '/');
  writeFileSync(listPath, JSON.stringify(resPaths), 'utf-8');

  const gdSafePath = listPath.replace(/"/g, '\\"');

  const validatorCode = [
    'extends SceneTree',
    '',
    'func _init():',
    '\tvar tmp_path: String = "' + gdSafePath + '"',
    '\tvar f := FileAccess.open(tmp_path, FileAccess.READ)',
    '\tif f == null:',
    '\t\tprint("MCP_VALIDATE_ERROR: Cannot read script list")',
    '\t\tquit()',
    '\t\treturn',
    '\tvar json_text := f.get_as_text()',
    '\tf.close()',
    '\tvar scripts = JSON.parse_string(json_text)',
    '\tif scripts == null or not scripts is Array:',
    '\t\tprint("MCP_VALIDATE_ERROR: Invalid script list JSON")',
    '\t\tquit()',
    '\t\treturn',
    '\tfor i in range(scripts.size()):',
    '\t\tvar script_path: String = scripts[i]',
    '\t\tvar res = load(script_path)',
    '\t\tif res == null:',
    '\t\t\tcontinue',
    '\tprint("MCP_VALIDATE_DONE")',
    '\tquit()',
  ].join('\n');

  const validatorPath = join(tmpDir, `validate-${listId}.gd`);
  writeFileSync(validatorPath, validatorCode, 'utf-8');

  const results = new Map<string, string[]>();

  const isErrorFalsePositive = (line: string): boolean => {
    if (line.includes('Identifier not found')) return true;
    if (line.includes('not declared in the current scope')) return true;
    if (line.includes('not found in base self')) return true;
    if (line.includes('Condition') && line.includes('is true')) return true;
    return false;
  };

  const output = await new Promise<string>((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(
      effectiveGodotPath,
      ['--headless', '--path', projectPath, '--script', validatorPath],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } }
    );

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGTERM');
    }, globalTimeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve('SPAWN_ERROR: ' + err.message);
    });

    proc.on('close', () => {
      clearTimeout(timer);
      resolve(stdout + stderr);
    });
  });

  if (output.startsWith('SPAWN_ERROR:')) {
    try { rmSync(listPath, { force: true }); } catch {}
    try { rmSync(validatorPath, { force: true }); } catch {}
    return [{ file: '<validator>', errors: [output] }];
  }

  try {
    const outputLines = output.split('\n');

    const infraErrors = outputLines.filter(l => l.includes('MCP_VALIDATE_ERROR:'));
    if (infraErrors.length > 0) {
      results.set('<validator>', infraErrors.map(l => l.trim()));
    }

    const validatorCompleted = outputLines.some(l => l.includes('MCP_VALIDATE_DONE'));
    if (!validatorCompleted && infraErrors.length === 0) {
      results.set('<validator>', ['Validator process did not complete (likely timed out). Results may be incomplete.']);
    }

    let lastParseError = '';
    for (const line of outputLines) {
      const trimmed = line.trim();
      if (trimmed.includes('Parse Error:') && !isErrorFalsePositive(trimmed)) {
        lastParseError = trimmed;
      } else if (trimmed.startsWith('at:') && trimmed.includes('res://') && lastParseError) {
        for (const rel of scriptRels) {
          const normalizedRel = rel.replace(/\\/g, '/');
          if (trimmed.includes('res://' + normalizedRel + ':')) {
            if (!results.has(rel)) results.set(rel, []);
            const errors = results.get(rel)!;
            if (!errors.includes(lastParseError)) {
              errors.push(lastParseError);
            }
            break;
          }
        }
        lastParseError = '';
      }
    }
  } finally {
    try { rmSync(listPath, { force: true }); } catch {}
    try { rmSync(validatorPath, { force: true }); } catch {}
  }

  return Array.from(results.entries()).map(([file, errors]) => ({ file, errors }));
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'run_and_verify',
      description: 'One-click run a Godot project in headless mode and return structured analysis (errors, warnings, suggestions). Automatically stops after timeout. '
        + 'Optionally captures a scene tree snapshot for runtime inspection.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene: { type: 'string', description: 'Optional scene file to run (e.g. res://scenes/main.tscn)' },
          timeout: { type: 'number', description: 'Auto-stop after N seconds (default: 20)', default: 20 },
          capture_tree: { type: 'boolean', description: 'Also capture a scene tree snapshot (default: false)', default: false },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'analyze_error',
      description: 'Analyze existing Godot error output text and return structured analysis with fix suggestions. Use this to re-analyze previous output.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          output: { type: 'string', description: 'The Godot runtime output to analyze (full text)' },
        },
        required: ['output'],
      },
    },
    {
      name: 'validate_project',
      description: 'Validate a Godot project for common issues: missing resource references, broken script paths, '
        + 'invalid scene files, and orphaned .import files. Returns a structured report of all issues found.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          check_resources: { type: 'boolean', description: 'Check for missing resource files (default: true)', default: true },
          check_scripts: { type: 'boolean', description: 'Check for broken script references (default: true)', default: true },
          check_scenes: { type: 'boolean', description: 'Validate scene file structure (default: true)', default: true },
          exclude_paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Directory paths (relative to project root) to exclude from validation. '
              + 'Default excludes: .godot, .import, tools, addons. Directories containing .gdignore are always skipped.',
            default: ['.godot', '.import', 'tools', 'addons'],
          },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'validate_scripts',
      description: 'Validate GDScript files by running each through the Godot parser. '
        + 'Detects parse errors, indentation issues, and type mismatches that headless run may miss. '
        + 'Returns per-file error details with fix suggestions.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scripts: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional array of script paths (relative to project) to validate. If omitted, scans all .gd files.',
          },
          timeout: { type: 'number', description: 'Timeout per script in seconds (default: 10)', default: 10 },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'import_resources',
      description: 'Scan a directory for assets and register them with the Godot project. Generates .import stubs '
        + 'so Godot recognizes the files. Supports images, audio, fonts, and other common asset types.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          directory: { type: 'string', description: 'Directory to scan (relative to project, e.g. "assets/ui")' },
          extensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'File extensions to import (default: common image/audio/font types)',
            default: ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp3', '.ogg', '.wav', '.ttf', '.otf', '.glb', '.gltf'],
          },
          recursive: { type: 'boolean', description: 'Scan subdirectories recursively (default: true)', default: true },
        },
        required: ['project_path', 'directory'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'run_and_verify': {
      const projectPath = validatePath(args.project_path as string);
      const timeout = (args.timeout as number) || 20;
      const scene = args.scene as string | undefined;
      const captureTree = args.capture_tree === true;

      const godot = await ctx.findGodot();
      const cmdArgs = ['--headless', '--path', projectPath];
      if (scene) cmdArgs.push(scene);

      const versionWarning = await checkVersionMismatch(projectPath, godot);

      const precheckErrors: Array<{ file: string; errors: string[] }> = [];
      try {
        const allScripts = collectScriptFiles(projectPath);
        const scriptsToCheck = allScripts.slice(0, 10);
        if (scriptsToCheck.length > 0) {
          const batchResults = await batchValidateScripts(godot, projectPath, scriptsToCheck, 15000);
          precheckErrors.push(...batchResults);
        }
      } catch { /* precheck is optional */ }

      try {
        const { stdout, stderr } = await execFileAsync(godot, cmdArgs, { timeout: timeout * 1000 });
        const allOutput = [...(stdout || '').split('\n'), ...(stderr || '').split('\n')];
        const analysis = analyzeOutput(allOutput);

        if (versionWarning) (analysis as any).version_warning = versionWarning;
        if (precheckErrors.length > 0) (analysis as any).precheck_errors = precheckErrors;

        if (captureTree && scene) {
          try {
            const scriptsDir = dirname(ctx.opsScript);
            const treeScript = join(scriptsDir, 'query_scene_tree.gd');
            if (existsSync(treeScript)) {
              const treeResult = await new Promise<string>((resolve) => {
                let out = '';
                const proc = spawn(godot, [
                  '--headless', '--path', projectPath,
                  '--script', treeScript,
                  JSON.stringify({ scene_path: scene, max_depth: 3 }),
                ], { stdio: ['pipe', 'pipe', 'pipe'] });
                proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
                proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
                proc.on('close', () => resolve(out));
                setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM'); resolve(''); }, 30000);
              });
              if (treeResult) {
                (analysis as any).scene_tree = parseMcpScriptOutput(treeResult, 0);
              }
            }
          } catch { /* tree capture is optional */ }
        }

        return textResult(JSON.stringify(analysis, null, 2));
      } catch (e: any) {
        const allOutput = [...(e.stdout || '').split('\n'), ...(e.stderr || '').split('\n')];
        const analysis = analyzeOutput(allOutput);
        if (versionWarning) (analysis as any).version_warning = versionWarning;
        if (precheckErrors.length > 0) (analysis as any).precheck_errors = precheckErrors;
        if (e.killed) {
          (analysis as any).summary += '\nNote: Process timed out after ' + timeout + 's (this is normal for interactive projects)';
        } else {
          (analysis as any).summary += '\nNote: Process exited with code ' + (e.code || 'unknown');
        }
        return textResult(JSON.stringify(analysis, null, 2));
      }
    }

    case 'analyze_error': {
      const outputText = args.output as string;
      if (!outputText || !outputText.trim()) {
        return textResult('Error: "output" parameter is required and must not be empty.');
      }
      const lines = outputText.split('\n');
      const analysis = analyzeOutput(lines);
      return textResult(JSON.stringify(analysis, null, 2));
    }

    case 'validate_project': {
      const p = validatePath(args.project_path as string);
      const checkResources = args.check_resources !== false;
      const checkScripts = args.check_scripts !== false;
      const checkScenes = args.check_scenes !== false;
      const excludePaths: string[] = (args.exclude_paths as string[]) || ['.godot', '.import', 'tools', 'addons'];

      const issues: Array<{ severity: string; category: string; message: string; file?: string }> = [];

      function shouldSkipDir(dirName: string, dirPath: string): boolean {
        if (excludePaths.includes(dirName)) return true;
        if (existsSync(join(dirPath, '.gdignore'))) return true;
        return false;
      }

      function collectFiles(dir: string, exts: string[], maxDepth: number = 10, depth: number = 0): string[] {
        if (depth > maxDepth) return [];
        const result: string[] = [];
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (shouldSkipDir(entry.name, full)) continue;
              result.push(...collectFiles(full, exts, maxDepth, depth + 1));
            } else {
              const ext = '.' + entry.name.split('.').pop()!.toLowerCase();
              if (exts.includes(ext)) result.push(full);
            }
          }
        } catch { /* skip */ }
        return result;
      }

      if (!existsSync(join(p, 'project.godot'))) {
        issues.push({ severity: 'critical', category: 'project', message: 'project.godot not found' });
        return textResult(JSON.stringify({ valid: false, issue_count: issues.length, issues }, null, 2));
      }

      if (checkScenes) {
        const sceneFiles = collectFiles(p, ['.tscn']);
        for (const sceneFile of sceneFiles) {
          const rel = sceneFile.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');
          try {
            const content = readFileSync(sceneFile, 'utf-8');
            const extResRegex = /\[ext_resource[^[]*path="([^"]+)"/g;
            let match;
            while ((match = extResRegex.exec(content)) !== null) {
              const resPath = match[1];
              if (!resPath.startsWith('res://')) continue;
              const absPath = resolveWithinRoot(p, resPath.replace('res://', ''));
              if (!existsSync(absPath)) {
                issues.push({
                  severity: 'error',
                  category: 'missing_resource',
                  message: `Referenced resource not found: ${resPath}`,
                  file: rel,
                });
              }
            }
          } catch (e) {
            issues.push({
              severity: 'warning',
              category: 'scene_read',
              message: `Cannot read scene file: ${(e as Error).message}`,
              file: rel,
            });
          }
        }
      }

      if (checkScripts) {
        const scriptFiles = collectFiles(p, ['.gd']);
        for (const scriptFile of scriptFiles) {
          const rel = scriptFile.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');
          try {
            const content = readFileSync(scriptFile, 'utf-8');
            const preloadRegex = /preload\(["']([^"']+)["']\)/g;
            let match;
            while ((match = preloadRegex.exec(content)) !== null) {
              const resPath = match[1];
              if (!resPath.startsWith('res://')) continue;
              const absPath = resolveWithinRoot(p, resPath.replace('res://', ''));
              if (!existsSync(absPath)) {
                issues.push({
                  severity: 'error',
                  category: 'missing_preload',
                  message: `preload() resource not found: ${resPath}`,
                  file: rel,
                });
              }
            }
            const loadRegex = /(?:^|\s)load\(["']([^"']+)["']\)/g;
            while ((match = loadRegex.exec(content)) !== null) {
              const resPath = match[1];
              if (!resPath.startsWith('res://')) continue;
              const absPath = resolveWithinRoot(p, resPath.replace('res://', ''));
              if (!existsSync(absPath)) {
                issues.push({
                  severity: 'warning',
                  category: 'missing_load',
                  message: `load() resource not found: ${resPath}`,
                  file: rel,
                });
              }
            }
          } catch {
            issues.push({ severity: 'warning', category: 'script_read', message: 'Cannot read script file', file: rel });
          }
        }
      }

      if (checkResources) {
        const importFiles = collectFiles(p, ['.import']);
        for (const importFile of importFiles) {
          const sourceFile = importFile.replace('.import', '');
          if (!existsSync(sourceFile)) {
            const rel = importFile.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');
            issues.push({
              severity: 'info',
              category: 'orphaned_import',
              message: `Orphaned .import file (source asset deleted)`,
              file: rel,
            });
          }
        }
      }

      const summary = {
        valid: issues.filter(i => i.severity === 'critical' || i.severity === 'error').length === 0,
        issue_count: issues.length,
        critical: issues.filter(i => i.severity === 'critical').length,
        errors: issues.filter(i => i.severity === 'error').length,
        warnings: issues.filter(i => i.severity === 'warning').length,
        info: issues.filter(i => i.severity === 'info').length,
        issues: issues.slice(0, 100),
      };

      return textResult(JSON.stringify(summary, null, 2));
    }

    case 'validate_scripts': {
      const p = validatePath(args.project_path as string);
      const perScriptTimeout = (args.timeout as number) || 10;
      const godot = await ctx.findGodot();

      let scriptsToValidate: string[];
      if (args.scripts && Array.isArray(args.scripts) && args.scripts.length > 0) {
        scriptsToValidate = (args.scripts as string[]).map(s => resolveWithinRoot(p, s));
      } else {
        scriptsToValidate = collectScriptFiles(p);
      }

      const totalFound = scriptsToValidate.length;
      if (scriptsToValidate.length > 50) {
        scriptsToValidate = scriptsToValidate.slice(0, 50);
      }

      const relOf = (f: string) => f.replace(p + (process.platform === 'win32' ? '\\' : '/'), '');

      const BATCH_SIZE = 20;
      const allBatchResults: Array<{ file: string; errors: string[] }> = [];
      for (let i = 0; i < scriptsToValidate.length; i += BATCH_SIZE) {
        const batch = scriptsToValidate.slice(i, i + BATCH_SIZE);
        const batchResults = await batchValidateScripts(godot, p, batch, Math.min(perScriptTimeout * Math.max(batch.length, 5), 60) * 1000);
        allBatchResults.push(...batchResults);
      }

      const errorMap = new Map(allBatchResults.map(r => [r.file, r.errors]));
      const results: Array<{ file: string; has_errors: boolean; errors: string[] }> = [];
      let totalErrors = 0;
      for (const sf of scriptsToValidate) {
        const rel = relOf(sf);
        const errs = errorMap.get(rel) || [];
        totalErrors += errs.length;
        results.push({ file: rel, has_errors: errs.length > 0, errors: errs });
      }

      let summaryMsg = `Validated ${scriptsToValidate.length} scripts, found ${totalErrors} errors in ${results.filter(r => r.has_errors).length} files.`;
      if (totalFound > 50) {
        summaryMsg += ` (${totalFound - 50} scripts skipped — specify scripts parameter to validate more)`;
      }

      const scriptsSummary = {
        validated: scriptsToValidate.length,
        total_scanned: totalFound,
        total_errors: totalErrors,
        scripts_with_errors: results.filter(r => r.has_errors).length,
        scripts: results,
        summary: summaryMsg,
      };

      const vWarn = await checkVersionMismatch(p, godot);
      if (vWarn) (scriptsSummary as any).version_warning = vWarn;

      return textResult(JSON.stringify(scriptsSummary, null, 2));
    }

    case 'import_resources': {
      const p = validatePath(args.project_path as string);
      const directoryRaw = args.directory as string;
      const normalizedDir = normalizeUserProjectPath(directoryRaw);

      if (!normalizedDir) {
        return textResult('Error: directory must be a non-empty path inside project.');
      }

      const defaultExts = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp3', '.ogg', '.wav', '.ttf', '.otf', '.glb', '.gltf'];
      const extensions = (args.extensions as string[]) || defaultExts;
      const recursive = args.recursive !== false;

      const targetDir = resolveWithinRoot(p, normalizedDir);
      if (!existsSync(targetDir)) {
        return textResult(`Error: Directory not found: ${targetDir}`);
      }

      const importedFiles: string[] = [];
      const skippedFiles: string[] = [];

      function scanDir(dir: string, depth: number): void {
        if (depth > 15) return;
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === '.import') continue;
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (recursive) scanDir(fullPath, depth + 1);
            } else {
              const ext = '.' + entry.name.split('.').pop()!.toLowerCase();
              if (!extensions.includes(ext)) continue;
              const importPath = fullPath + '.import';
              if (existsSync(importPath)) {
                skippedFiles.push(fullPath.replace(p + (process.platform === 'win32' ? '\\' : '/'), ''));
                continue;
              }
              const uid = 'uid://' + Buffer.from(fullPath.replace(p, '').replace(/\\/g, '/')).toString('base64url').substring(0, 24);
              const importerMap: Record<string, string> = {
                '.png': 'texture', '.jpg': 'texture', '.jpeg': 'texture', '.webp': 'texture', '.svg': 'texture',
                '.mp3': 'ogg_vorbis', '.ogg': 'ogg_vorbis', '.wav': 'wav',
                '.ttf': 'dynamic_font', '.otf': 'dynamic_font',
                '.glb': 'scene', '.gltf': 'scene',
              };
              const importer = importerMap[ext] || 'any';
              const importContent = [
                `[remap]`,
                ``,
                `importer="${importer}"`,
                `type="CompressedTexture2D"`,
                `uid="${uid}"`,
                `path="res://.godot/imported/${entry.name}-${uid.substring(5, 13)}.ctex"`,
                `metadata={`,
                `"vram_texture": false`,
                `}`,
                ``,
                `[deps]`,
                ``,
                `source_file="res://${fullPath.replace(p + (process.platform === 'win32' ? '\\' : '/'), '').replace(/\\/g, '/')}"`,
                ``,
                `[params]`,
                ``,
                `compress/mode=0`,
                `compress/high_quality=false`,
                `compress/lossy_quality=0.7`,
                ``,
              ].join('\n');
              writeFileSync(importPath, importContent, 'utf-8');
              importedFiles.push(fullPath.replace(p + (process.platform === 'win32' ? '\\' : '/'), ''));
            }
          }
        } catch { /* skip */ }
      }

      scanDir(targetDir, 0);

      return textResult(
        `Import scan complete.\n\n` +
        `Directory: ${normalizedDir}\n` +
        `New imports: ${importedFiles.length}\n` +
        `Already imported (skipped): ${skippedFiles.length}\n` +
        `Extensions: ${extensions.join(', ')}\n\n` +
        (importedFiles.length > 0 ? `Newly imported:\n${importedFiles.slice(0, 50).map(f => '  ' + f).join('\n')}${importedFiles.length > 50 ? `\n  ... and ${importedFiles.length - 50} more` : ''}\n\n` : '') +
        `Note: Open the project in Godot editor once to fully process imports.`
      );
    }

    default:
      return null;
  }
}
