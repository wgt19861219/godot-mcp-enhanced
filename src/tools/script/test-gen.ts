// script 工具测试生成 actions（generate_test / create_test_scene）实现。
// 拆分来源：src/tools/script.ts（2026-09-20 可维护性批7，case→文件机械搬迁）。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import type { ToolResult } from '../../types.js';
import { textResult } from '../../types.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { resolveWithinRoot, normalizeUserProjectPath } from '../../core/path-utils.js';
import { opsErrorResult, escapeForGdLiteral } from '../shared.js';

export async function generateTest(args: Record<string, unknown>): Promise<ToolResult> {
  const projectPath = requireProjectPath(args);
  const scriptPath = args.script_path as string;
  if (!scriptPath) {
    return opsErrorResult('INVALID_PARAMS', 'script_path is required (e.g. "scripts/player.gd")');
  }

  const fullScriptPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(scriptPath));
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
      if (funcMatch[2] === 'void') {
        voidMethods.add(funcMatch[1]!);
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
  testCode += `\t${testTarget} = load("${escapeForGdLiteral(scriptResPath)}").new()\n\n`;
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

export async function createTestScene(args: Record<string, unknown>): Promise<ToolResult> {
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
