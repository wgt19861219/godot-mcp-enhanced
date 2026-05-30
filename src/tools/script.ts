import { join, basename, extname } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { requireProjectPath, resolveWithinRoot, ensureDir } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { batchValidateScripts } from './validation.js';
import { lintGDScript, formatLintResults } from './gdscript-lint.js';
import { getTemplateSuggestion } from './code-templates.js';
import { gdEscape, opsErrorResult } from './shared.js';
import { validateTimeout } from './shared.js';

function detectDuplicateLines(lines: string[]): string[] {
  const warnings: string[] = [];
  let runStart = -1;
  for (let i = 1; i <= lines.length; i++) {
    const cur = i < lines.length ? lines[i].trim() : '';
    const prev = lines[i - 1].trim();
    if (cur.length > 10 && cur === prev && (cur.includes('(') || cur.includes('='))) {
      if (runStart < 0) runStart = i - 1;
    } else {
      if (runStart >= 0 && i - runStart >= 3) {
        warnings.push(`Duplicate block (lines ${runStart + 1}-${i}): "${prev.substring(0, 80)}"`);
      }
      runStart = -1;
    }
  }
  return warnings;
}

function formatDuplicateWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '';
  return `\n\n⚠ Warning: ${warnings.length} duplicate line(s) detected (possible copy-paste error):\n${warnings.map(w => `  ${w}`).join('\n')}`;
}

function joinWithLineEnding(content: string, hasCRLF: boolean): string {
  if (!hasCRLF) return content;
  return content.split('\n').join('\r\n');
}

async function validateAndRevert(
  fullPath: string,
  rawFile: string,
  godotPath: string,
  projectPath: string,
  contextInfo?: string
): Promise<string | null> {
  try {
    const valResult = await batchValidateScripts(godotPath, projectPath, [fullPath], 15000);
    if (valResult.length > 0 && valResult[0].errors.length > 0) {
      try {
        writeFileSync(fullPath, rawFile, 'utf-8');
      } catch (rollbackErr) {
        return `⚠️ CRITICAL: Parse error detected AND rollback failed!\n` +
          `Parse errors:\n  ${valResult[0].errors.join('\n  ')}\n` +
          `Rollback error: ${rollbackErr}\n` +
          `File may be in a corrupted state: ${fullPath}`;
      }
      return `⚠️ Edit REVERTED due to GDScript parse error:\n` +
        valResult[0].errors.map(e => `  ${e}`).join('\n') +
        `\n\nOriginal file restored. Please fix the edit content and retry.` +
        (contextInfo ? `\n\n--- Attempted change ---\n${contextInfo}` : '');
    }
  } catch (e) {
    return `⚠️ Validation skipped (Godot unavailable): ${(e as Error).message}\nEdit was applied but not validated.`;
  }
  return null;
}

const ACTIONS = [
  'read_script',
  'write_script',
  'edit_script',
  'generate_test',
  'create_test_scene',
  'execute_gdscript',
  'project_replace',
] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'script',
      description: '脚本操作。读写: read_script, write_script。编辑: edit_script（行号/search_and_replace）。执行: execute_gdscript。测试: generate_test, create_test_scene。批量替换: project_replace。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          script_path: { type: 'string', description: 'read_script 用绝对路径；write_script/edit_script/generate_test 用绝对或相对项目路径' },
          content: { type: 'string', description: 'write_script: GDScript 内容' },
          overwrite: { type: 'boolean', description: 'write_script: 覆盖已有文件（默认 false）', default: false },
          start_line: { type: 'number', description: 'edit_script: 替换起始行（1-based）' },
          end_line: { type: 'number', description: 'edit_script: 替换结束行（1-based，含）' },
          new_content: { type: 'string', description: 'edit_script: 替换内容' },
          indent_mode: {
            type: 'string',
            enum: ['raw', 'smart'],
            description: 'edit_script: 缩进模式（默认 raw）',
            default: 'raw',
          },
          verify_content: { type: 'string', description: 'edit_script: 期望内容守卫（不匹配则中止）' },
          auto_validate: {
            type: 'boolean',
            description: 'edit_script: 自动验证语法并在失败时回滚（默认 true）',
            default: true,
          },
          search_and_replace: {
            type: 'object',
            description: 'edit_script: 内容搜索替换模式（提供时忽略 start_line/end_line）',
            properties: {
              search: { type: 'string', description: '搜索文本（CRLF 归一化匹配）' },
              replace: { type: 'string', description: '替换文本' },
              occurrence: { type: 'number', description: '替换第几次出现（1-based，0=全部）' },
            },
            required: ['search', 'replace'],
          },
          code: { type: 'string', description: 'execute_gdscript: 要执行的 GDScript 代码' },
          timeout: { type: 'number', description: 'execute_gdscript: 超时秒数（默认 30）', default: 30 },
          load_autoloads: { type: 'boolean', description: 'execute_gdscript: 加载完整 Autoload 上下文（默认 false）', default: false },
          search: { type: 'string', description: 'project_replace: 搜索文本' },
          replace: { type: 'string', description: 'project_replace: 替换文本' },
          extensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'project_replace: 文件扩展名（默认 [".gd"]）',
            default: ['.gd'],
          },
          exclude_dirs: {
            type: 'array',
            items: { type: 'string' },
            description: 'project_replace: 排除目录（默认 [".godot", ".import", "addons", "tools"]）',
            default: ['.godot', '.import', 'addons', 'tools'],
          },
          dry_run: { type: 'boolean', description: 'project_replace: 仅预览不写入（默认 false）', default: false },
        },
        required: ['project_path', 'action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'script') return null;

  const action = args.action as string;

  switch (action) {
    case 'read_script': {
      const sp = resolveWithinRoot(requireProjectPath(args), args.script_path as string);
      if (!existsSync(sp)) return textResult(`Script not found: ${sp}`);

      const content = readFileSync(sp, 'utf-8');
      const lines = content.split('\n');
      const ext = extname(sp).toLowerCase();

      // C# 文件：直接读取，返回 csharp 语言标记
      if (ext === '.cs') {
        let csClassName = '';
        let csNamespace = '';
        let csBaseClass = '';
        for (const line of lines) {
          const nsMatch = line.match(/^\s*namespace\s+(\S+)/);
          if (nsMatch) csNamespace = nsMatch[1];
          const clsMatch = line.match(/^\s*(?:public\s+)?(?:partial\s+)?class\s+([A-Za-z_]\w*)/);
          if (clsMatch && !csClassName) csClassName = clsMatch[1];
          const baseMatch = line.match(/^\s*(?:public\s+)?(?:partial\s+)?class\s+[A-Za-z_]\w*\s*:\s*([A-Za-z_]\w*)/);
          if (baseMatch) csBaseClass = baseMatch[1];
        }
        return textResult(JSON.stringify({
          path: sp,
          language: 'csharp',
          namespace: csNamespace,
          class_name: csClassName,
          extends: csBaseClass,
          lines: lines.length,
          content,
        }, null, 2));
      }

      // GDScript 文件：解析 extends / class_name
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
      const sp = resolveWithinRoot(requireProjectPath(args), scriptPath);
      const content = args.content as string;
      const overwrite = args.overwrite === true; // default false

      if (existsSync(sp) && !overwrite) {
        return opsErrorResult('FILE_EXISTS', `File already exists: ${sp}. Set overwrite=true to replace it.`);
      }

      ensureDir(sp);
      writeFileSync(sp, content, 'utf-8');

      let lintSection = '';
      let templateHint = '';
      if (sp.endsWith('.gd')) {
        const lintOutput = lintGDScript(content);
        lintSection = formatLintResults(lintOutput);

        const allIssues = [...lintOutput.errors, ...lintOutput.warnings];
        if (allIssues.length > 0) {
          const suggestions = new Set<string>();
          for (const issue of allIssues) {
            const suggestion = getTemplateSuggestion(issue.rule);
            if (suggestion) {
              const preview = suggestion.split('\n').slice(0, 3).join('\n');
              suggestions.add(`  (${issue.rule}) → 建议:\n    ${preview}\n    ... (完整模板见 templates(action=list))`);
            }
          }
          if (suggestions.size > 0) {
            templateHint = '\n\nTemplate suggestions:\n' + [...suggestions].join('\n');
          }
        }
      }
      return textResult(`Script written to ${sp} (${content.split('\n').length} lines)${lintSection}${templateHint}`);
    }

    case 'edit_script': {
      const scriptPath = args.script_path as string;
      const projectPath = requireProjectPath(args);
      const fullPath = resolveWithinRoot(projectPath, scriptPath);

      if (!existsSync(fullPath)) {
        return opsErrorResult('NOT_FOUND', `File not found: ${fullPath}`, {
          suggestion: 'Check the script_path for typos. Use validate_scripts to scan all scripts in the project.',
        });
      }

      const rawFile = readFileSync(fullPath, 'utf-8');
      const hasCRLF = rawFile.includes('\r\n');
      const lines = rawFile.split(/\r?\n/);
      const autoValidate = args.auto_validate !== false;

      let godotPath: string | null = null;
      if (autoValidate && fullPath.endsWith('.gd')) {
        try {
          godotPath = await ctx.findGodot();
        } catch {
          godotPath = null;
        }
      }

      // search_and_replace mode
      if (args.search_and_replace && typeof args.search_and_replace === 'object') {
        const sr = args.search_and_replace as { search: string; replace: string; occurrence?: number };
        if (!sr.search) {
          return opsErrorResult('INVALID_PARAMS', 'search_and_replace.search must be a non-empty string.');
        }
        const normalizedContent = rawFile.replace(/\r\n/g, '\n');
        const normalizedSearch = sr.search.replace(/\r\n/g, '\n');
        const normalizedReplace = sr.replace.replace(/\r\n/g, '\n');

        const occurrence = sr.occurrence ?? 1;
        let searchIndex = -1;
        let foundCount = 0;

        if (occurrence === 0) {
          if (!normalizedContent.includes(normalizedSearch)) {
            return opsErrorResult('NOT_FOUND', `search_and_replace: search text not found in ${fullPath}`);
          }
          const newFileContent = normalizedContent.split(normalizedSearch).join(normalizedReplace);
          const finalContent = joinWithLineEnding(newFileContent, hasCRLF);
          writeFileSync(fullPath, finalContent, 'utf-8');

          if (godotPath) {
            const revertMsg = await validateAndRevert(fullPath, rawFile, godotPath, projectPath);
            if (revertMsg) return textResult(revertMsg);
          }

          const count = normalizedContent.split(normalizedSearch).length - 1;

          const dupWarns = detectDuplicateLines(finalContent.split(/\r?\n/));
          const dw = formatDuplicateWarnings(dupWarns);

          let editLintSection = '';
          if (fullPath.endsWith('.gd')) {
            const editedContent = readFileSync(fullPath, 'utf-8');
            editLintSection = formatLintResults(lintGDScript(editedContent));
          }

          return textResult(`Edited ${fullPath}: replaced all ${count} occurrences of search text.${dw}${editLintSection}`);
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
          return opsErrorResult('NOT_FOUND', `search_and_replace: occurrence ${occurrence} not found (found ${foundCount} total matches in ${fullPath})`);
        }

        const before = normalizedContent.substring(0, searchIndex);
        const after = normalizedContent.substring(searchIndex + normalizedSearch.length);
        const newFileContent = before + normalizedReplace + after;
        const finalContent = joinWithLineEnding(newFileContent, hasCRLF);
        writeFileSync(fullPath, finalContent, 'utf-8');

        if (godotPath) {
          const revertMsg = await validateAndRevert(fullPath, rawFile, godotPath, projectPath);
          if (revertMsg) return textResult(revertMsg);
        }

        const dupWarns = detectDuplicateLines(finalContent.split(/\r?\n/));
        const dw = formatDuplicateWarnings(dupWarns);

        let editLintSection = '';
        if (fullPath.endsWith('.gd')) {
          const editedContent = readFileSync(fullPath, 'utf-8');
          editLintSection = formatLintResults(lintGDScript(editedContent));
        }

        return textResult(`Edited ${fullPath}: replaced occurrence ${occurrence} of search text (${foundCount} total matches found).${dw}${editLintSection}`);
      }

      // Line-number mode
      const startLine = args.start_line as number;
      const endLine = args.end_line as number;
      const newContent = args.new_content as string;
      const indentMode = (args.indent_mode as string) || 'raw';
      const verifyContent = args.verify_content as string | undefined;

      if (startLine < 1 || endLine < startLine) {
        return opsErrorResult('INVALID_PARAMS', `Invalid line range: start_line=${startLine}, end_line=${endLine}`);
      }

      if (endLine > lines.length) {
        return opsErrorResult('INVALID_PARAMS', `end_line ${endLine} exceeds file length ${lines.length}`);
      }

      const beforeLines = lines.slice(startLine - 1, endLine);

      if (verifyContent !== undefined) {
        const existingContent = beforeLines.join('\n');
        const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\t/g, '    ').trim();
        if (normalize(existingContent) !== normalize(verifyContent)) {
          return opsErrorResult(
            'CONTENT_MISMATCH',
            `Content verification failed at lines ${startLine}-${endLine}. The file has changed since the line numbers were read.\n` +
            `--- Expected ---\n${verifyContent}\n` +
            `--- Actual ---\n${existingContent}`
          );
        }
      }

      const newLines = newContent.split(/\r?\n/);
      let adjustedLines: string[];

      if (indentMode === 'smart') {
        const originalLine = lines[startLine - 1] || '';
        const originalBaseIndent = (originalLine.match(/^(\t*)/) || ['',''])[1].length;

        const newNonEmptyLines = newLines.filter(l => l.trim() !== '');
        let newMinIndent = Infinity;
        for (const nl of newNonEmptyLines) {
          const tabs = (nl.match(/^(\t*)/) || ['',''])[1].length;
          if (tabs < newMinIndent) newMinIndent = tabs;
        }
        if (newMinIndent === Infinity) newMinIndent = 0;

        const indentDelta = originalBaseIndent - newMinIndent;

        adjustedLines = newLines.map((line: string) => {
          if (line.trim() === '') return line;

          const currentTabs = (line.match(/^(\t*)/) || ['',''])[1].length;

          if (indentDelta > 0) {
            return '\t'.repeat(indentDelta) + line;
          } else if (indentDelta < 0) {
            const tabsToRemove = Math.min(-indentDelta, currentTabs);
            return line.substring(tabsToRemove);
          }
          return line;
        });
      } else {
        adjustedLines = newLines;
      }

      lines.splice(startLine - 1, endLine - startLine + 1, ...adjustedLines);

      const result = joinWithLineEnding(lines.join('\n'), hasCRLF);
      writeFileSync(fullPath, result, 'utf-8');

      if (godotPath) {
        const ctxInfo = `Lines ${startLine}-${endLine}:\n${beforeLines.join('\n')}\n→\n${adjustedLines.join('\n')}`;
        const revertMsg = await validateAndRevert(fullPath, rawFile, godotPath, projectPath, ctxInfo);
        if (revertMsg) return textResult(revertMsg);
      }

      const afterLines = adjustedLines;
      const diffHeader = `Edited ${fullPath}: replaced lines ${startLine}-${endLine} (${beforeLines.length} lines → ${afterLines.length} lines)`;
      const diffBody = `--- Before ---\n${beforeLines.join('\n')}\n--- After ---\n${afterLines.join('\n')}`;

      const contextBefore = lines.slice(Math.max(0, startLine - 3), startLine - 1);
      const contextAfterStart = startLine - 1 + adjustedLines.length;
      const contextAfter = lines.slice(contextAfterStart, contextAfterStart + 2);
      const ctxBefore = contextBefore.length > 0 ? `\n--- Context (before) ---\n${contextBefore.join('\n')}` : '';
      const ctxAfter = contextAfter.length > 0 ? `\n--- Context (after) ---\n${contextAfter.join('\n')}` : '';

      const warnings = formatDuplicateWarnings(detectDuplicateLines(lines));
      const skipNote = (autoValidate && !fullPath.endsWith('.gd'))
        ? "\nNote: Auto-validate only supports .gd files. Other file types are not validated."
        : "";

      let editLintSection = '';
      if (fullPath.endsWith('.gd')) {
        const editedContent = readFileSync(fullPath, 'utf-8');
        editLintSection = formatLintResults(lintGDScript(editedContent));
      }

      return textResult(`${diffHeader}\n${diffBody}${ctxBefore}${ctxAfter}${warnings}${skipNote}${editLintSection}`);
    }

    case 'generate_test': {
      const projectPath = requireProjectPath(args);
      const scriptPath = args.script_path as string;
      if (!scriptPath) {
        return opsErrorResult('INVALID_PARAMS', 'script_path is required (e.g. "scripts/player.gd")');
      }

      const fullScriptPath = resolveWithinRoot(projectPath, scriptPath);
      if (!existsSync(fullScriptPath)) {
        return opsErrorResult('NOT_FOUND', `Script not found: ${fullScriptPath}`, {
          suggestion: 'Check the script_path for typos. Use validate_scripts to scan all scripts in the project.',
        });
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
      const voidMethods = new Set<string>();
      for (const line of srcLines) {
        const funcMatch = line.match(/^func\s+(\w+)\s*\((?:[^)]*)\)\s*(?:->\s*(\w+))?\s*:/);
        if (funcMatch && !funcMatch[1].startsWith('_')) {
          publicMethods.push(funcMatch[1]);
          if (funcMatch[2] === 'void') {
            voidMethods.add(funcMatch[1]);
          }
        }
      }

      if (publicMethods.length === 0) {
        return textResult(
          `No public methods found in ${scriptPath}.\n` +
          `Only private methods (starting with _) were detected or the file has no functions.\n` +
          `The script extends "${extendsClass || 'unknown'}".`
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
      const p = requireProjectPath(args);

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
      const projectPath = requireProjectPath(args);
      const code = args.code as string;
      const timeout = validateTimeout(args.timeout);
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

    case 'project_replace': {
      const p = requireProjectPath(args);
      const search = args.search as string;
      const replace = (args.replace as string) ?? '';
      const ALLOWED_EXTENSIONS = new Set(['.gd', '.tscn', '.tres', '.gdshader', '.cfg', '.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.toml', '.csv']);
      const HARDCODED_EXCLUDE = new Set(['.git', 'node_modules']);
      const rawExtensions: string[] = (args.extensions as string[]) || ['.gd'];
      const extensions = rawExtensions.filter(ext => ALLOWED_EXTENSIONS.has(ext));
      if (extensions.length === 0) {
        return opsErrorResult('INVALID_PARAMS', `No allowed extensions. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
      }
      const userExcludeDirs: string[] = (args.exclude_dirs as string[]) || ['.godot', '.import', 'addons', 'tools'];
      const excludeDirs = [...new Set([...userExcludeDirs, ...HARDCODED_EXCLUDE])];
      const dryRun = args.dry_run === true;

      if (!search) {
        return opsErrorResult('INVALID_PARAMS', 'search must be a non-empty string.');
      }

      const normalizedSearch = search.replace(/\r\n/g, '\n');
      const normalizedReplace = replace.replace(/\r\n/g, '\n');

      // Collect files
      const MAX_FILES = 500;
      const matchedFiles: string[] = [];
      const skippedDirs: string[] = [];
      function scanDir(dir: string, depth: number): void {
        if (matchedFiles.length >= MAX_FILES) return;
        if (depth > 15) return;
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (matchedFiles.length >= MAX_FILES) return;
            if (entry.name.startsWith('.')) continue;
            if (excludeDirs.includes(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (existsSync(join(full, '.gdignore'))) continue;
              scanDir(full, depth + 1);
            } else if (extensions.some(ext => entry.name.endsWith(ext))) {
              matchedFiles.push(full);
            }
          }
        } catch (err) {
          console.debug('[script] scan dir for files:', err);
          skippedDirs.push(dir.slice(p.length + 1) || dir);
        }
      }
      scanDir(p, 0);
      if (matchedFiles.length >= MAX_FILES) {
        return opsErrorResult('INVALID_PARAMS', `Too many matching files (>${MAX_FILES}). Narrow the search with more specific extensions or add directories to exclude_dirs.`);
      }

      const relOf = (absPath: string) => absPath.slice(p.length + 1);

      const changedFiles: string[] = [];
      const unchangedFiles: string[] = [];
      const skippedLarge: string[] = [];
      let totalReplacements = 0;
      const MAX_FILE_SIZE = 1_000_000; // 1MB

      for (const filePath of matchedFiles) {
        try {
          const fileSize = statSync(filePath).size;
          if (fileSize > MAX_FILE_SIZE) {
            skippedLarge.push(relOf(filePath));
            continue;
          }
        } catch (e) { console.debug(`[script] stat failed for ${filePath}:`, e); continue; }
        const content = readFileSync(filePath, 'utf-8');
        const hasCRLF = content.includes('\r\n');
        const normalized = content.replace(/\r\n/g, '\n');

        if (!normalized.includes(normalizedSearch)) {
          unchangedFiles.push(relOf(filePath));
          continue;
        }

        const count = normalized.split(normalizedSearch).length - 1;
        totalReplacements += count;

        if (!dryRun) {
          const newContent = normalized.split(normalizedSearch).join(normalizedReplace);
          const finalContent = hasCRLF ? newContent.split('\n').join('\r\n') : newContent;
          writeFileSync(filePath, finalContent, 'utf-8');
        }

        changedFiles.push(relOf(filePath));
      }

      const prefix = dryRun ? '[DRY RUN] ' : '';
      const summary = [
        `${prefix}Batch replace complete.`,
        `Search: "${search.substring(0, 80)}${search.length > 80 ? '...' : ''}"`,
        `Replace: "${replace.substring(0, 80)}${replace.length > 80 ? '...' : ''}"`,
        `Extensions: ${extensions.join(', ')}`,
        `Scanned: ${matchedFiles.length} files`,
        `Changed: ${changedFiles.length} files (${totalReplacements} replacements)`,
        unchangedFiles.length > 0 ? `Unchanged: ${unchangedFiles.length} files` : '',
        skippedLarge.length > 0 ? `Skipped (>${MAX_FILE_SIZE / 1_000_000}MB): ${skippedLarge.length} files` : '',
        skippedDirs.length > 0 ? `Skipped dirs (unreadable): ${skippedDirs.slice(0, 10).join(', ')}${skippedDirs.length > 10 ? ` ... and ${skippedDirs.length - 10} more` : ''}` : '',
      ].filter(Boolean).join('\n');

      const details = changedFiles.length > 0
        ? '\n\nChanged files:\n' + changedFiles.slice(0, 50).map(f => `  ${f}`).join('\n')
          + (changedFiles.length > 50 ? `\n  ... and ${changedFiles.length - 50} more` : '')
        : '\n\nNo files contained the search text.';

      return textResult(summary + details);
    }

    default:
      return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  script: { readonly: false, long_running: false },
};
