import { join, basename } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath, resolveWithinRoot, ensureDir } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';

const TOOL_NAMES = [
  'read_script',
  'write_script',
  'edit_script',
  'generate_test',
  'create_test_scene',
  'execute_gdscript',
] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'read_script',
      description: 'Read a GDScript (.gd) file with metadata (extends, class_name, line count).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          script_path: { type: 'string', description: 'Absolute path to the .gd file' },
        },
        required: ['project_path', 'script_path'],
      },
    },
    {
      name: 'write_script',
      description: 'Write or overwrite a GDScript (.gd) file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          script_path: { type: 'string', description: 'Absolute path to the .gd file' },
          content: { type: 'string', description: 'GDScript content to write' },
        },
        required: ['script_path', 'content'],
      },
    },
    {
      name: 'edit_script',
      description: 'Edit an existing GDScript file by replacing a range of lines. '
        + 'Preserves CRLF line endings. By default inserts content as-is (raw mode). '
        + 'Safer than write_script for incremental edits. '
        + 'IMPORTANT: Prefer this tool over Claude\'s built-in Edit for .gd files to preserve line endings. '
        + 'Use search_and_replace mode for content-based editing that is resilient to line number shifts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          script_path: { type: 'string', description: 'Path to the .gd file to edit (absolute or relative to project)' },
          start_line: { type: 'number', description: '1-based line number where replacement starts (inclusive)' },
          end_line: { type: 'number', description: '1-based line number where replacement ends (inclusive). Use same as start_line for single line replace.' },
          new_content: { type: 'string', description: 'New content to replace the specified line range.' },
          indent_mode: {
            type: 'string',
            enum: ['raw', 'smart'],
            description: 'Indentation mode: "raw" (default) inserts content exactly as provided. "smart" auto-adjusts indentation to match start_line.',
            default: 'raw',
          },
          verify_content: { type: 'string', description: 'Optional: expected content at the replacement range. Edit is aborted if it does not match, preventing stale line-number edits.' },
          search_and_replace: {
            type: 'object',
            description: 'Content-based editing mode: search for a string and replace it. More resilient than line-number editing. '
              + 'When provided, start_line/end_line are ignored.',
            properties: {
              search: { type: 'string', description: 'The exact text to search for (CRLF is normalized to LF for matching)' },
              replace: { type: 'string', description: 'The replacement text' },
              occurrence: { type: 'number', description: 'Which occurrence to replace (1-based, default: 1). Use 0 to replace all.' },
            },
            required: ['search', 'replace'],
          },
        },
        required: ['script_path', 'start_line', 'end_line', 'new_content'],
      },
    },
    {
      name: 'generate_test',
      description: 'Analyze a GDScript file and generate a GUT (Godot Unit Test) test script. Reads the script, extracts public methods, and generates test stubs. The generated code is returned as text — use write_script to save it.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          script_path: { type: 'string', description: 'Path to the GDScript to test, relative to project root (e.g. scripts/player.gd)' },
        },
        required: ['project_path', 'script_path'],
      },
    },
    {
      name: 'create_test_scene',
      description: 'Create a GUT test runner scene (test_scene.tscn) for a Godot project. Checks if GUT addon is installed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'execute_gdscript',
      description: 'Execute arbitrary GDScript code in a headless Godot process. '
        + 'Two modes: (1) Snippet mode — provide code without "extends", auto-wrapped with helpers. '
        + 'Use _mcp_output(key, value) to return structured results. '
        + '(2) Full class mode — provide code with "extends SceneTree" for full control. '
        + 'Set load_autoloads=true to run with full autoload context (slower but can access DataRegistry, PlayerData, etc.).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          code: { type: 'string', description: 'GDScript code to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 30)', default: 30 },
          load_autoloads: { type: 'boolean', description: 'When true, runs with full autoload context so DataRegistry/PlayerData etc. are available (default: false)', default: false },
        },
        required: ['project_path', 'code'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'read_script': {
      const sp = resolveWithinRoot(validatePath(args.project_path as string), args.script_path as string);
      if (!existsSync(sp)) return textResult(`Script not found: ${sp}`);

      const content = readFileSync(sp, 'utf-8');
      const lines = content.split('\n');

      let extendsClass = '';
      let className = '';

      for (const line of lines) {
        const extMatch = line.match(/^extends\s+(\S+)/);
        if (extMatch) extendsClass = extMatch[1];
        const clsMatch = line.match(/^class_name\s+(\S+)/);
        if (clsMatch) className = clsMatch[1];
      }

      return textResult(JSON.stringify({
        path: sp,
        extends: extendsClass,
        class_name: className,
        lines: lines.length,
        content,
      }, null, 2));
    }

    case 'write_script': {
      const scriptPath = args.script_path as string;
      const sp = resolveWithinRoot(validatePath(args.project_path as string), scriptPath);
      const content = args.content as string;

      ensureDir(sp);
      writeFileSync(sp, content, 'utf-8');

      return textResult(`Script written to ${sp} (${content.split('\n').length} lines)`);
    }

    case 'edit_script': {
      const scriptPath = args.script_path as string;
      const fullPath = resolveWithinRoot(validatePath(args.project_path as string), scriptPath);

      if (!existsSync(fullPath)) {
        return textResult(`Error: File not found: ${fullPath}`);
      }

      const rawFile = readFileSync(fullPath, 'utf-8');
      const hasCRLF = rawFile.includes('\r\n');
      const lines = rawFile.split(/\r?\n/);

      // search_and_replace mode
      if (args.search_and_replace && typeof args.search_and_replace === 'object') {
        const sr = args.search_and_replace as { search: string; replace: string; occurrence?: number };
        if (!sr.search) {
          return textResult('Error: search_and_replace.search must be a non-empty string.');
        }
        const normalizedContent = rawFile.replace(/\r\n/g, '\n');
        const normalizedSearch = sr.search.replace(/\r\n/g, '\n');
        const normalizedReplace = sr.replace.replace(/\r\n/g, '\n');

        const occurrence = sr.occurrence ?? 1;
        let searchIndex = -1;
        let foundCount = 0;

        if (occurrence === 0) {
          if (!normalizedContent.includes(normalizedSearch)) {
            return textResult(`Error: search_and_replace: search text not found in ${fullPath}`);
          }
          const newFileContent = normalizedContent.split(normalizedSearch).join(normalizedReplace);
          const finalContent = hasCRLF ? newFileContent.replace(/\n/g, '\r\n') : newFileContent;
          writeFileSync(fullPath, finalContent, 'utf-8');
          const count = normalizedContent.split(normalizedSearch).length - 1;
          return textResult(`Edited ${fullPath}: replaced all ${count} occurrences of search text.`);
        }

        let pos = 0;
        while (pos < normalizedContent.length) {
          const idx = normalizedContent.indexOf(normalizedSearch, pos);
          if (idx === -1) break;
          foundCount++;
          if (foundCount === occurrence) {
            searchIndex = idx;
            break;
          }
          pos = idx + 1;
        }

        if (searchIndex === -1) {
          return textResult(`Error: search_and_replace: occurrence ${occurrence} not found (found ${foundCount} total matches in ${fullPath})`);
        }

        const before = normalizedContent.substring(0, searchIndex);
        const after = normalizedContent.substring(searchIndex + normalizedSearch.length);
        const newFileContent = before + normalizedReplace + after;
        const finalContent = hasCRLF ? newFileContent.replace(/\n/g, '\r\n') : newFileContent;
        writeFileSync(fullPath, finalContent, 'utf-8');
        return textResult(`Edited ${fullPath}: replaced occurrence ${occurrence} of search text (${foundCount} total matches found).`);
      }

      // Line-number mode
      const startLine = args.start_line as number;
      const endLine = args.end_line as number;
      const newContent = args.new_content as string;
      const indentMode = (args.indent_mode as string) || 'raw';
      const verifyContent = args.verify_content as string | undefined;

      if (startLine < 1 || endLine < startLine) {
        return textResult(`Error: Invalid line range: start_line=${startLine}, end_line=${endLine}`);
      }

      if (endLine > lines.length) {
        return textResult(`Error: end_line ${endLine} exceeds file length ${lines.length}`);
      }

      const beforeLines = lines.slice(startLine - 1, endLine);

      if (verifyContent !== undefined) {
        const existingContent = beforeLines.join('\n');
        const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\t/g, '    ').trim();
        if (normalize(existingContent) !== normalize(verifyContent)) {
          return textResult(
            `Error: Content verification failed at lines ${startLine}-${endLine}. The file has changed since the line numbers were read.\n` +
            `--- Expected ---\n${verifyContent}\n` +
            `--- Actual ---\n${existingContent}`
          );
        }
      }

      const newLines = newContent.split(/\r?\n/);
      let adjustedLines: string[];

      if (indentMode === 'smart') {
        const originalLine = lines[startLine - 1] || '';
        const baseIndent = (originalLine.match(/^(\t*)/) || ['',''])[1];
        let minIndent = Infinity;
        for (const nl of newLines) {
          if (nl.trim() === '') continue;
          const tabs = (nl.match(/^(\t*)/) || ['',''])[1].length;
          if (tabs < minIndent) minIndent = tabs;
        }
        if (minIndent === Infinity) minIndent = 0;
        const stripPrefix = '\t'.repeat(minIndent);

        adjustedLines = newLines.map((line: string) => {
          if (line.trim() === '') return line;
          const stripped = line.startsWith(stripPrefix)
            ? line.substring(stripPrefix.length)
            : line;
          return baseIndent + stripped;
        });
      } else {
        adjustedLines = newLines;
      }

      lines.splice(startLine - 1, endLine - startLine + 1, ...adjustedLines);

      const result = lines.join(hasCRLF ? '\r\n' : '\n');
      writeFileSync(fullPath, result, 'utf-8');

      const afterLines = adjustedLines;
      const diffHeader = `Edited ${fullPath}: replaced lines ${startLine}-${endLine} (${beforeLines.length} lines → ${afterLines.length} lines)`;
      const diffBody = `--- Before ---\n${beforeLines.join('\n')}\n--- After ---\n${afterLines.join('\n')}`;

      return textResult(`${diffHeader}\n${diffBody}`);
    }

    case 'generate_test': {
      const projectPath = validatePath(args.project_path as string);
      const scriptPath = args.script_path as string;
      if (!scriptPath) {
        return textResult('Error: script_path is required (e.g. "scripts/player.gd")');
      }

      const fullScriptPath = resolveWithinRoot(projectPath, scriptPath);
      if (!existsSync(fullScriptPath)) {
        return textResult(`Error: Script not found: ${fullScriptPath}`);
      }

      const source = readFileSync(fullScriptPath, 'utf-8');
      const srcLines = source.split('\n');

      let extendsClass = '';
      let className = '';
      for (const line of srcLines) {
        const extMatch = line.match(/^extends\s+(\S+)/);
        if (extMatch) extendsClass = extMatch[1];
        const clsMatch = line.match(/^class_name\s+(\S+)/);
        if (clsMatch) className = clsMatch[1];
      }

      const publicMethods: string[] = [];
      for (const line of srcLines) {
        const funcMatch = line.match(/^func\s+(\w+)\s*\(/);
        if (funcMatch && !funcMatch[1].startsWith('_')) {
          publicMethods.push(funcMatch[1]);
        }
      }

      if (publicMethods.length === 0) {
        return textResult(
          `No public methods found in ${scriptPath}.\n` +
          `Only private methods (starting with _) were detected or the file has no functions.\n` +
          `The script extends "${extendsClass || 'unknown'}".`
        );
      }

      const testTarget = className || (scriptPath.includes('/') ? scriptPath.split('/').pop()?.replace('.gd', '') || 'Target' : scriptPath.replace('.gd', ''));
      const scriptResPath = scriptPath.startsWith('res://') ? scriptPath : `res://${scriptPath}`;

      let testCode = 'extends GutTest\n\n';
      testCode += `var ${testTarget}  # Instance under test\n\n`;
      testCode += 'func before_each():\n';
      testCode += `\t${testTarget} = load("${scriptResPath}").new()\n\n`;
      testCode += 'func after_each():\n';
      testCode += `\tif is_instance_valid(${testTarget}):\n`;
      testCode += `\t\t${testTarget}.free()\n\n`;

      for (const method of publicMethods) {
        testCode += `func test_${method}():\n`;
        testCode += `\tvar result = ${testTarget}.${method}()\n`;
        testCode += `\tassert_not_null(result, "${method} should return a value")\n\n`;
      }

      const outputTestPath = join(projectPath, 'test', 'scripts', `test_${basename(scriptPath)}`);

      return textResult(
        `Generated GUT test for ${scriptPath}\n\n` +
        `Target class: ${testTarget}\n` +
        `Extends: ${extendsClass || 'N/A'}\n` +
        `Class name: ${className || 'N/A'}\n` +
        `Public methods found: ${publicMethods.length}\n` +
        `  ${publicMethods.join(', ')}\n\n` +
        `Suggested save path: ${outputTestPath}\n\n` +
        `--- Generated test code ---\n${testCode}` +
        `--- End of generated code ---\n\n` +
        `To save, use: write_script(project_path="${projectPath}", script_path="test/scripts/test_${basename(scriptPath)}", content=<above code>)`
      );
    }

    case 'create_test_scene': {
      const p = validatePath(args.project_path as string);

      const gutDir = join(p, 'addons', 'gut');
      if (!existsSync(gutDir)) {
        return textResult(
          `GUT (Godot Unit Test) addon not found at ${gutDir}.\n\n` +
          `To install GUT:\n` +
          `1. Download from: https://github.com/bitwes/Gut/releases\n` +
          `2. Extract to ${join(p, 'addons', 'gut')}\n` +
          `3. Or use the Godot Asset Library: https://godotengine.org/asset-library/asset/282\n\n` +
          `After installing GUT, run create_test_scene again.`
        );
      }

      mkdirSync(join(p, 'test', 'scripts'), { recursive: true });

      const testSceneContent = [
        '[gd_scene load_steps=2 format=3]',
        '',
        '[ext_resource type="Script" path="res://addons/gut/gut.gd" id="1_gut"]',
        '',
        '[node name="TestScene" type="Node"]',
        'script = ExtResource("1_gut")',
        '',
      ].join('\n');
      writeFileSync(join(p, 'test_scene.tscn'), testSceneContent, 'utf-8');

      return textResult(
        `GUT test scene created at ${join(p, 'test_scene.tscn')}\n\n` +
        `To run tests:\n` +
        `1. Open test_scene.tscn in Godot editor\n` +
        `2. Click "Run All" in the GUT panel\n` +
        `3. Or use run_tests(project_path="${p}") for headless testing\n\n` +
        `Test scripts should be placed in: test/scripts/`
      );
    }

    case 'execute_gdscript': {
      const projectPath = validatePath(args.project_path as string);
      const code = args.code as string;
      const timeout = (args.timeout as number) || 30;
      const loadAutoloads = (args.load_autoloads as boolean) || false;
      const godot = await ctx.findGodot();

      const result = await executeGdscript({
        godotPath: godot,
        projectPath,
        code,
        timeout,
        loadAutoloads,
      });

      return textResult(JSON.stringify(result, null, 2));
    }

    default:
      return null;
  }
}
