import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initDocs, clearApiCache, searchClasses, getDocsVersion } from '../build/godot-docs.js';

function makeApiJson(classCount = 1) {
  const classes = [];
  for (let i = 0; i < classCount; i++) {
    classes.push({
      name: `TestClass${i}`,
      inherits: i > 0 ? `TestClass${i - 1}` : '',
      brief_description: `Test class ${i}`,
      methods: [],
      properties: [],
      signals: [],
      constants: [],
      enums: [],
    });
  }
  return JSON.stringify({
    header: { version_major: 4, version_minor: 3, version_patch: 0 },
    classes,
  });
}

describe('godot-docs API cache', () => {
  let tmpDir;

  beforeEach(() => {
    clearApiCache();
    tmpDir = mkdtempSync(join(tmpdir(), 'godot-docs-cache-'));
  });

  it('clearApiCache resets all state', () => {
    const apiPath = join(tmpDir, 'api.json');
    writeFileSync(apiPath, makeApiJson());

    initDocs(apiPath);
    assert.strictEqual(getDocsVersion(), '4.3.0');

    clearApiCache();
    assert.strictEqual(getDocsVersion(), null);

    // 清理
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clearApiCache is idempotent', () => {
    clearApiCache();
    clearApiCache();
    clearApiCache();
    assert.strictEqual(getDocsVersion(), null);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('same path: second initDocs skips file read (uses cached data)', () => {
    const apiPath = join(tmpDir, 'api.json');
    writeFileSync(apiPath, makeApiJson(3));

    // 第一次：读取文件 + 解析 + 缓存
    initDocs(apiPath);
    assert.strictEqual(getDocsVersion(), '4.3.0');
    let results = searchClasses('TestClass');
    assert.strictEqual(results.length, 3);

    // 删除源文件 — 如果再次读取会 ENOENT
    rmSync(apiPath, { force: true });

    // clearApiCache 后再 initDocs：因为文件已删除，应该抛出错误
    // 但如果不清缓存，initDocs 因 initialized=true 直接 return，不读文件
    // 这里测试的是：initialized + same path 守卫使第二次调用不触碰磁盘
    // （初始化状态下已经测过 initialized 守卫，此处验证行为一致）
    initDocs(apiPath);
    assert.strictEqual(getDocsVersion(), '4.3.0');
    results = searchClasses('TestClass');
    assert.strictEqual(results.length, 3);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parse failure is not cached, retry succeeds', () => {
    const apiPath = join(tmpDir, 'api-bad.json');
    writeFileSync(apiPath, 'this is not valid json {{{');

    // 解析失败应抛出 SyntaxError，且不缓存
    assert.throws(() => initDocs(apiPath), { name: 'SyntaxError' });

    // 覆写为合法 JSON
    writeFileSync(apiPath, makeApiJson(1));

    // 重试应成功（因为上次失败没缓存）
    initDocs(apiPath);
    const results = searchClasses('TestClass');
    assert.ok(results.length > 0, '重试后应能搜到类');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('different path loads new data after clearApiCache', () => {
    const apiPath1 = join(tmpDir, 'api-v1.json');
    const apiPath2 = join(tmpDir, 'api-v2.json');

    writeFileSync(apiPath1, JSON.stringify({
      header: { version_major: 4, version_minor: 2, version_patch: 0 },
      classes: [{
        name: 'VersionTwo',
        inherits: '',
        brief_description: 'v4.2 class',
      }],
    }));

    writeFileSync(apiPath2, JSON.stringify({
      header: { version_major: 4, version_minor: 3, version_patch: 0 },
      classes: [{
        name: 'VersionThree',
        inherits: '',
        brief_description: 'v4.3 class',
      }],
    }));

    initDocs(apiPath1);
    assert.strictEqual(getDocsVersion(), '4.2.0');
    let results = searchClasses('Version');
    assert.ok(results.some(r => r.name === 'VersionTwo'));

    // 切换到新路径需要先清缓存
    clearApiCache();
    initDocs(apiPath2);
    assert.strictEqual(getDocsVersion(), '4.3.0');
    results = searchClasses('Version');
    assert.ok(results.some(r => r.name === 'VersionThree'));

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
