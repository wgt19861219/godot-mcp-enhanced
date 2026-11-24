import { expect, it, beforeEach, afterEach, describe, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mockSuccessResult } from './helpers/mock-results.js';

// Mock the executor — hoisted to top by Vitest
// SEC-P1-1: 用 importOriginal 保留 scanGdscriptSandbox 真实实现(只 mock executeGdscript/parseMcpMarkers)
vi.mock('../src/gdscript-executor.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    executeGdscript: vi.fn(() => Promise.resolve(mockSuccessResult({
      outputs: [{ key: 'result', value: '{"validated":1,"total_errors":0}' }],
    }))),
    parseMcpMarkers: vi.fn((raw) => ({
      parsed: null,
      logLines: raw.split('\n').map((l) => l.trim()).filter(Boolean),
    })),
  };
});

// Mock batchValidateScripts so validate_scripts doesn't spawn Godot
vi.mock('../src/tools/validation.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    batchValidateScripts: vi.fn(() => Promise.resolve([
      { file: 'scripts/main.gd', errors: [], warnings: [] },
    ])),
  };
});

// Task D1 (2026-11-12): spy fs-atomic.writeFileAtomic(透传真实实现,行为零变化)——
// 断言 parse error 回滚写走原子写(原裸 writeFileSync)
vi.mock('../src/core/fs-atomic.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileAtomic: vi.fn((...args) => actual.writeFileAtomic(...args)),
  };
});

// Task D1 (2026-11-12): mock 'fs' readFileSync(getter 透传)——写后回读校验用例
// 向第 2 次读(=写后回读)注入 stale 磁盘内容。vi.hoisted 保证 mock 工厂(hoisted)可安全访问。
const _fsMockState = vi.hoisted(() => ({ readFileMock: null, realReadFileSync: null }));

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal();
  _fsMockState.realReadFileSync = original.readFileSync;
  return {
    ...original,
    get readFileSync() {
      return _fsMockState.readFileMock ?? original.readFileSync;
    },
  };
});

import { executeGdscript } from '../src/gdscript-executor.js';
import * as script from '../src/tools/script.js';
import * as validation from '../src/tools/validation.js';
import * as fsAtomic from '../src/core/fs-atomic.js';
import { createToolContext, createTempProject } from './helpers/tool-context.js';
import { MINIMAL_PROJECT } from './helpers/fixtures.js';

describe('Level B: Script editing', () => {
  const dirRef = { path: null };
  let ctx;

  afterEach(() => {
    if (dirRef.path) {
      try { rmSync(dirRef.path, { recursive: true, force: true }); } catch {}
      dirRef.path = null;
    }
  });

  beforeEach(() => {
    vi.mocked(executeGdscript).mockReset();
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => 'godot';
  });

  // 用例 1: write_script — 创建新脚本文件
  it('write new script', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'write_script',
      script_path: 'scripts/new_script.gd',
      content: 'extends Node2D\n\nfunc _ready():\n\tprint("hello")\n',
    }, ctx);
    expect(result.isError).not.toBe(true);
    expect(existsSync(join(dirRef.path, 'scripts', 'new_script.gd'))).toBeTruthy();
  });

  // 用例 2: edit_script — search_and_replace 模式替换内容
  it('search and replace edit', async () => {
    const scriptPath = 'scripts/main.gd';
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: scriptPath,
      start_line: 1,
      end_line: 1,
      new_content: '',
      search_and_replace: { search: '\tpass', replace: '\tprint("edited")' },
    }, ctx);
    expect(result.isError).not.toBe(true);
    const content = readFileSync(join(dirRef.path, scriptPath), 'utf-8');
    expect(content).toContain('edited');
  });

  // 用例 3: validate_scripts — 合法脚本应通过验证
  it('validate scripts', async () => {
    vi.mocked(validation.batchValidateScripts).mockResolvedValueOnce([
      { file: 'scripts/main.gd', errors: [], warnings: [] },
    ]);

    const result = await validation.handleTool('validation', {
      project_path: dirRef.path,
      action: 'validate_scripts',
      scripts: ['scripts/main.gd'],
    }, ctx);
    expect(result.isError).not.toBe(true);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.validated > 0).toBe(true);
    expect(parsed.total_errors === 0 || parsed.total_errors === undefined).toBe(true);
  });

  // 用例 4: edit_script — 不存在的文件应返回错误
  it('edit nonexistent script', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'scripts/DOES_NOT_EXIST.gd',
      start_line: 1,
      end_line: 1,
      new_content: 'test',
    }, ctx);
    const text = result.content?.[0]?.text || '';
    expect(
      text.includes('Error') || text.includes('not found'),
    ).toBeTruthy();
  });

  // #2 路径解析统一: res:// 前缀应被正确剥离
  it('write_script with res:// prefix', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'write_script',
      script_path: 'res://scripts/res_path_test.gd',
      content: 'extends Node\n',
      overwrite: true,
    }, ctx);
    expect(result.isError).not.toBe(true);
    expect(existsSync(join(dirRef.path, 'scripts', 'res_path_test.gd'))).toBeTruthy();
  });

  it('read_script with res:// prefix', async () => {
    // 先写入
    await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'write_script',
      script_path: 'res://scripts/res_read_test.gd',
      content: 'extends Node\n# test comment\n',
    }, ctx);
    // 再用 res:// 读取
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'read_script',
      script_path: 'res://scripts/res_read_test.gd',
    }, ctx);
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('test comment');
  });

  it('edit_script with res:// prefix and path traversal fails', async () => {
    // resolveWithinRoot 应阻止 res://../ 路径遍历
    await expect(script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'res://../etc/passwd',
      start_line: 1,
      end_line: 1,
      new_content: 'hacked',
    }, ctx)).rejects.toThrow('Path traversal');
  });

  // #6 smart indent: 空格缩进文件应正确调整
  it('edit_script with space-indented file adjusts indent correctly', async () => {
    // 先创建空格缩进文件（2 空格）
    await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'write_script',
      script_path: 'scripts/space_indent.gd',
      content: 'extends Node\n\nfunc _ready():\n  var x = 1\n  if x > 0:\n    print(x)\n',
    }, ctx);
    // 用 smart indent 编辑，替换 if 块
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'scripts/space_indent.gd',
      start_line: 5,
      end_line: 6,
      new_content: 'if x > 0:\n  print("positive")\n  print("done")',
      indent_mode: 'smart',
    }, ctx);
    expect(result.isError).not.toBe(true);
    const content = readFileSync(join(dirRef.path, 'scripts', 'space_indent.gd'), 'utf-8');
    // 新内容应保持 2 空格缩进（与原文件一致）
    expect(content).toContain('  print("positive")');
  });

  // #6 smart indent: tab 缩进文件行为不变（向后兼容）
  it('edit_script with tab-indented file keeps tab indent', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'scripts/main.gd',
      start_line: 1,
      end_line: 1,
      new_content: 'func new_func():\n\tpass',
      indent_mode: 'smart',
    }, ctx);
    expect(result.isError).not.toBe(true);
    const content = readFileSync(join(dirRef.path, 'scripts', 'main.gd'), 'utf-8');
    expect(content).toContain('\tpass');
  });

  // #3 级联删除信息: parse error 应显示结构化行号和标识符
  it('edit_script revert shows structured parse error with line and identifier', async () => {
    // 让 batchValidateScripts 返回结构化 parse error
    vi.mocked(validation.batchValidateScripts).mockResolvedValueOnce([{
      file: 'scripts/main.gd',
      errors: [
        'scripts/main.gd:15 - Parse Error: identifier "MAX_SPEED" not declared in current scope',
        'scripts/main.gd:23 - Parse Error: Unexpected identifier: "calc_damage"',
      ],
      warnings: [],
    }]);

    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'scripts/main.gd',
      start_line: 1,
      end_line: 1,
      new_content: 'bad code',
    }, ctx);
    const text = result.content?.[0]?.text || '';
    // Task D1: 行模式回滚同样是错误语义(isError:true)
    expect(result.isError).toBe(true);
    // 应包含结构化行号信息
    expect(text).toContain('Line 15');
    expect(text).toContain('Line 23');
    // 应包含标识符
    expect(text).toContain('MAX_SPEED');
    expect(text).toContain('calc_damage');
    // 文件应被恢复到原始状态
    expect(text).toContain('Original file restored');
  });

  // ─── Task D1 (2026-11-12): edit_script 回滚语义修正 + 原子回滚 + 写后回读 ───
  // 反馈 2026-11-08: 返回成功但静默回滚未落盘——回滚响应必须以错误语义为主
  // (isError:true + EDIT_REVERTED),不得以成功主语开头。

  it('edit_script revert returns error semantics (isError + EDIT_REVERTED, no success wording)', async () => {
    vi.mocked(validation.batchValidateScripts).mockResolvedValueOnce([{
      file: 'scripts/main.gd',
      errors: ['scripts/main.gd:5 - Parse Error: identifier "oops" not declared in current scope'],
      warnings: [],
    }]);

    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'scripts/main.gd',
      search_and_replace: { search: '\tpass', replace: '\tprint("edited")' },
    }, ctx);

    // 错误语义为主:isError:true + error_code EDIT_REVERTED
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error_code).toBe('EDIT_REVERTED');
    expect(parsed.error.startsWith('EDIT WAS REVERTED')).toBe(true);
    // 不含成功主语(防"成功文案+REVERTED 拼同一响应"回归)
    expect(parsed.error).not.toContain('replaced occurrence');
    // 文件已回滚为原始内容
    const content = readFileSync(join(dirRef.path, 'scripts', 'main.gd'), 'utf-8');
    expect(content).toContain('\tpass');
    expect(content).not.toContain('edited');
  });

  it('edit_script revert writes rollback content via writeFileAtomic (atomic rollback)', async () => {
    vi.mocked(validation.batchValidateScripts).mockResolvedValueOnce([{
      file: 'scripts/main.gd',
      errors: ['scripts/main.gd:5 - Parse Error: identifier "oops" not declared in current scope'],
      warnings: [],
    }]);
    // 只清调用记录,透传实现保留(mockClear 不动 vi.fn(impl) 的初始实现)
    vi.mocked(fsAtomic.writeFileAtomic).mockClear();

    await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'scripts/main.gd',
      search_and_replace: { search: '\tpass', replace: '\tprint("edited")' },
    }, ctx);

    const calls = vi.mocked(fsAtomic.writeFileAtomic).mock.calls;
    // 第 1 次 = 编辑落盘,第 2 次 = 回滚;回滚参数必须是 (目标文件, 原始内容)
    expect(calls.length).toBe(2);
    const [rollbackPath, rollbackContent] = calls[1];
    expect(String(rollbackPath).endsWith(join('scripts', 'main.gd'))).toBe(true);
    expect(rollbackContent).toBe('extends Node2D\n\nfunc _ready():\n\tpass\n');
  });

  it('edit_script returns WRITE_VERIFY_FAILED when post-write read-back mismatches', async () => {
    const scriptFile = join(dirRef.path, 'scripts', 'main.gd');
    let readCount = 0;
    _fsMockState.readFileMock = (p, ...rest) => {
      if (String(p) === scriptFile) {
        readCount++;
        // 第 1 次 = 读原文件(rawFile),第 2 次 = writeFileAtomic 后的写后回读校验
        if (readCount === 2) return 'STALE ON DISK';
      }
      return _fsMockState.realReadFileSync(p, ...rest);
    };
    try {
      const result = await script.handleTool('script', {
        project_path: dirRef.path,
        action: 'edit_script',
        script_path: 'scripts/main.gd',
        search_and_replace: { search: '\tpass', replace: '\tprint("edited")' },
      }, ctx);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error_code).toBe('WRITE_VERIFY_FAILED');
      // 校验失败时不得落入成功文案
      expect(parsed.error).not.toContain('replaced occurrence');
    } finally {
      _fsMockState.readFileMock = null;
    }
  });

  // ─── 反馈 11-20 复发条(2026-11-22 批 Task 2): edit_script 假成功守卫三件套 ───
  // no-change 显式文案 / 成功文案附 UTF-8 bytes written / 回滚写补回读校验。

  it('edit_script no-change: 替换结果与原文一致 → 不写盘 + 明确 No change 文案', async () => {
    vi.mocked(fsAtomic.writeFileAtomic).mockClear();
    const result = await script.handleTool('script', {
      project_path: dirRef.path, action: 'edit_script', script_path: 'scripts/main.gd',
      search_and_replace: { search: '\tpass', replace: '\tpass' },
    }, ctx);
    const text = result.content?.[0]?.text || '';
    expect(text).toContain('No change made');
    expect(text).not.toContain('replaced');
    expect(vi.mocked(fsAtomic.writeFileAtomic).mock.calls.length).toBe(0);
    expect(readFileSync(join(dirRef.path, 'scripts', 'main.gd'), 'utf-8')).toBe('extends Node2D\n\nfunc _ready():\n\tpass\n');
  });

  it('行号模式: 替换行与原行相同 → No change 文案且不写盘', async () => {
    vi.mocked(fsAtomic.writeFileAtomic).mockClear();
    const result = await script.handleTool('script', {
      project_path: dirRef.path, action: 'edit_script', script_path: 'scripts/main.gd',
      start_line: 4, end_line: 4, new_content: '\tpass',
    }, ctx);
    expect(result.content?.[0]?.text || '').toContain('No change made');
    expect(vi.mocked(fsAtomic.writeFileAtomic).mock.calls.length).toBe(0);
  });

  it('edit_script 成功文案附 UTF-8 字节数(中文按字节计,非 UTF-16 码元)', async () => {
    await script.handleTool('script', {
      project_path: dirRef.path, action: 'write_script', script_path: 'scripts/cn.gd',
      content: 'extends Node\n# 中文注释\n',
    }, ctx);
    const result = await script.handleTool('script', {
      project_path: dirRef.path, action: 'edit_script', script_path: 'scripts/cn.gd',
      search_and_replace: { search: '# 中文注释', replace: '# 中文注释2' },
    }, ctx);
    const expected = 'extends Node\n# 中文注释2\n';
    const bytes = Buffer.byteLength(expected, 'utf8');
    expect(result.content?.[0]?.text || '').toContain(`(${bytes} bytes written)`);
    expect(bytes).toBeGreaterThan(expected.length);
  });

  it('edit_script 回滚写静默失效 → 回读比对报 CRITICAL rollback write mismatch(EDIT_REVERTED 通道)', async () => {
    vi.mocked(fsAtomic.writeFileAtomic).mockClear();
    vi.mocked(validation.batchValidateScripts).mockResolvedValueOnce([{
      file: 'scripts/main.gd',
      errors: ['scripts/main.gd:5 - Parse Error: identifier "oops" not declared in current scope'],
      warnings: [],
    }]);
    const passThrough = vi.mocked(fsAtomic.writeFileAtomic).getMockImplementation();
    vi.mocked(fsAtomic.writeFileAtomic)
      .mockImplementationOnce(passThrough)   // 编辑落盘: 真实写
      .mockImplementationOnce(() => {});      // 回滚写: 静默失效(不抛错,盘上仍是新内容)
    const result = await script.handleTool('script', {
      project_path: dirRef.path, action: 'edit_script', script_path: 'scripts/main.gd',
      search_and_replace: { search: '\tpass', replace: '\tprint("edited")' },
    }, ctx);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error_code).toBe('EDIT_REVERTED');
    expect(parsed.error).toContain('CRITICAL: rollback write mismatch');
    expect(parsed.error).toContain('Parse errors:');
    expect(parsed.error).not.toContain('Original file restored');
  });

  // 控制器裁定(2026-11-24): 补简报四用例未覆盖的三处行为,作为回归防线。
  // 字节数括注以落盘后 statSync(文件).size 为断言(UTF-8 字节),不手算。

  it('replace-all(occurrence=0) no-change: 替换结果与原文一致 → No change 文案且不写盘', async () => {
    vi.mocked(fsAtomic.writeFileAtomic).mockClear();
    const result = await script.handleTool('script', {
      project_path: dirRef.path, action: 'edit_script', script_path: 'scripts/main.gd',
      search_and_replace: { search: '\tpass', replace: '\tpass', occurrence: 0 },
    }, ctx);
    expect(result.content?.[0]?.text || '').toContain('No change made');
    expect(vi.mocked(fsAtomic.writeFileAtomic).mock.calls.length).toBe(0);
  });

  it('replace-all 成功文案字节数 = 落盘后文件实际大小(statSync)', async () => {
    await script.handleTool('script', {
      project_path: dirRef.path, action: 'write_script', script_path: 'scripts/cn_all.gd',
      content: 'extends Node\n# 中文\n# 中文\n',
    }, ctx);
    const result = await script.handleTool('script', {
      project_path: dirRef.path, action: 'edit_script', script_path: 'scripts/cn_all.gd',
      search_and_replace: { search: '# 中文', replace: '# 中文注释', occurrence: 0 },
    }, ctx);
    const firstLine = (result.content?.[0]?.text || '').split('\n')[0];
    expect(firstLine).toContain('replaced all 2 occurrences');
    const sizeOnDisk = statSync(join(dirRef.path, 'scripts', 'cn_all.gd')).size;
    const reportedBytes = /\((\d+) bytes written\)/.exec(firstLine)?.[1];
    expect(reportedBytes).toBe(String(sizeOnDisk));
  });

  it('行号路径成功文案字节数 = 落盘后文件实际大小,且 > 字符串长度(UTF-8 字节非 UTF-16 码元)', async () => {
    const result = await script.handleTool('script', {
      project_path: dirRef.path, action: 'edit_script', script_path: 'scripts/main.gd',
      start_line: 4, end_line: 4, new_content: '\tprint("中文")',
    }, ctx);
    const header = (result.content?.[0]?.text || '').split('\n')[0];
    const scriptFile = join(dirRef.path, 'scripts', 'main.gd');
    const sizeOnDisk = statSync(scriptFile).size;
    const reportedBytes = /\((\d+) bytes written\)/.exec(header)?.[1];
    expect(reportedBytes).toBe(String(sizeOnDisk));
    expect(sizeOnDisk).toBeGreaterThan(readFileSync(scriptFile, 'utf-8').length);
  });

  // ─── Task D2 (2026-11-12): MCP_LOAD_NULL 降级警告不触发回滚 ───
  // headless load() 返 null 归 headless_limitations 警告通道(errors 为空)——
  // edit_script 保留编辑(D1 回滚条件 errors.length>0 不触发),警告透传到响应。

  it('edit_script keeps edit (no revert) when validation returns only headless_limitations', async () => {
    vi.mocked(validation.batchValidateScripts).mockResolvedValueOnce([{
      file: 'scripts/main.gd',
      errors: [],
      headless_limitations: [
        'load() returned null — 可能因依赖脚本/autoload 在 headless 不可用，编辑已保留，请用 check:gdscript 或带窗口模式复核 (res://scripts/main.gd)',
      ],
    }]);

    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'edit_script',
      script_path: 'scripts/main.gd',
      search_and_replace: { search: '\tpass', replace: '\tprint("edited")' },
    }, ctx);

    // 编辑保留: 非错误语义 + 新内容落盘(未被回滚)
    expect(result.isError).not.toBe(true);
    const content = readFileSync(join(dirRef.path, 'scripts', 'main.gd'), 'utf-8');
    expect(content).toContain('edited');
    // 警告透传: 响应含 load() returned null 复核提示(agent 可见)
    const text = result.content[0].text;
    expect(text).toContain('load() returned null');
  });
});
