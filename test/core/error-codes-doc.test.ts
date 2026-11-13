// A2 (2026-11-13 批 A): docs/error-codes.md 语义表与 ERROR_CODES 注册表锚定测试(防漂移)。
// 单向是方案要求(注册表每码都在文档表出现);反向(文档表码都在注册表)顺带锚定,
// 防文档侧手写错码误导 agent。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES } from '../../src/core/error-codes.js';

const docPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'error-codes.md');
const doc = readFileSync(docPath, 'utf-8');

/** 从文档两个表格行提取码列(`| CODE | category | ...` 形态)。 */
const docCodes = new Set(
  [...doc.matchAll(/^\| ([A-Z][A-Z_]*) \|/gm)].map((m) => m[1]!),
);

describe('docs/error-codes.md ↔ ERROR_CODES 注册表锚定(防漂移)', () => {
  it('注册表每码都在文档表出现', () => {
    const missing = Object.keys(ERROR_CODES).filter((c) => !docCodes.has(c));
    expect(missing, `注册表有而文档缺: ${missing.join(', ')}——改注册表须同步 docs/error-codes.md`).toEqual([]);
  });

  it('文档表每码都在注册表(文档不得手写未收编码)', () => {
    const extra = [...docCodes].filter((c) => !(c in ERROR_CODES));
    expect(extra, `文档有而注册表缺: ${extra.join(', ')}`).toEqual([]);
  });

  it('表头五列(code/category/retryable/语义/典型自愈动作)', () => {
    expect(doc).toMatch(/^\| code \| category \| retryable \| 语义 \| 典型自愈动作 \|/m);
  });

  it('顶部注明 retryable 语义(true 等待/修复环境后重试;false 按 suggestion 改参数)', () => {
    expect(doc).toMatch(/retryable 语义/);
    expect(doc).toMatch(/等.*1-2s.*或修复环境/);
    expect(doc).toMatch(/suggestion.*改参数|按 `suggestion` 改参数/);
  });
});
