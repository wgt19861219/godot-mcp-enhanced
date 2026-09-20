// script 工具 read_script action 实现。
// 拆分来源：src/tools/script.ts（2026-09-20 可维护性批7，case→文件机械搬迁）。

import { existsSync, readFileSync } from 'fs';
import { extname } from 'path';
import type { ToolResult } from '../../types.js';
import { textResult } from '../../types.js';
import { maybeWrapUntrusted } from '../../core/untrusted-wrap.js';
import { requireProjectPath } from '../../core/args-validation.js';
import { resolveWithinRoot, normalizeUserProjectPath } from '../../core/path-utils.js';

export async function readScript(args: Record<string, unknown>): Promise<ToolResult> {
  const sp = resolveWithinRoot(requireProjectPath(args), normalizeUserProjectPath(args.script_path as string));
  if (!existsSync(sp)) return textResult(`Script not found: ${sp}`);

  const content = readFileSync(sp, 'utf-8');
  const lines = content.split('\n');
  const ext = extname(sp).toLowerCase();

  // C# 文件：直接读取，返回 csharp 语言标记
  if (ext === '.cs') {
    let csClassName = '';
    let csNamespace = '';
    let csBaseClass = '';
    const csUsings: string[] = [];
    for (const line of lines) {
      const nsMatch = line.match(/^\s*namespace\s+(\S+)/);
      if (nsMatch) csNamespace = nsMatch[1]!;
      const clsMatch = line.match(/^\s*(?:public\s+)?(?:partial\s+)?class\s+([A-Za-z_]\w*)/);
      if (clsMatch && !csClassName) csClassName = clsMatch[1]!;
      const baseMatch = line.match(/^\s*(?:public\s+)?(?:partial\s+)?class\s+[A-Za-z_]\w*\s*:\s*([A-Za-z_]\w*)/);
      if (baseMatch) csBaseClass = baseMatch[1]!;
      const usingMatch = line.match(/^\s*using\s+([^;]+);/);
      if (usingMatch && csUsings.length < 50) csUsings.push(usingMatch[1]!.trim());
    }
    // P1-1: 源码内容 nonce 信封(输出侧防注入,src/core/untrusted-wrap.ts)
    return textResult(maybeWrapUntrusted('script.read', sp, JSON.stringify({
      path: sp,
      language: 'csharp',
      namespace: csNamespace,
      class_name: csClassName,
      extends: csBaseClass,
      usings: csUsings,
      lines: lines.length,
      content,
    }, null, 2)));
  }

  // GDScript 文件：解析 extends / class_name
  let extendsClass = '';
  let className = '';

  for (const line of lines) {
    const extMatch = line.match(/^extends\s+(\S+)/);
    if (extMatch) extendsClass = extMatch[1]!;
    const clsMatch = line.match(/^class_name\s+(\S+)/);
    if (clsMatch) className = clsMatch[1]!;
  }

  // P1-1: 源码内容 nonce 信封(输出侧防注入,src/core/untrusted-wrap.ts)
  return textResult(maybeWrapUntrusted('script.read', sp, JSON.stringify({
    path: sp,
    extends: extendsClass,
    class_name: className,
    lines: lines.length,
    content,
  }, null, 2)));
}
