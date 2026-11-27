import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { handleTool } from '../src/tools/runtime.js';
import type { ToolContext } from '../src/types.js';

// D6 (2026-11-12 反馈批次) 真机锚定: run_tests 分片模式 + GODOT_TEST_MODE 透传。
// -gconfig 选片语义依据(GUT 9.7.1 源码 gut_cli.gd GutCliOptionResolver cmd>config>base):
// 显式 -gconfig=<tmp> 时项目 .gutconfig.json 完全不加载(替换语义);tests 完整路径列表
// 经 gut.add_script 逐个加载是选片通道。本套用 fixture test/fixtures/gut-shard-e2e
// (GUT 9.7.1 addon 拷自 CardGame2)验证:
//   1. shards=2 蛇形分片真机执行,total=各片之和,delta(test_legacy,仅在项目 .gutconfig.json
//      的 dirs 里)永不执行——替换语义防 dirs 附加合并(反馈坑③)的运行时证据
//   2. GODOT_TEST_MODE 透传非注入(shell 设了 ENVMARK:1,未设 ENVMARK: 空)
//   3. shards=1 单进程 -gdir 路径 + GUT 9.7 Totals 无冒号格式解析真机锚定
// 改 runGutProcess/runShardedTests/gutCountMatches/buildSafeEnv 后本套必红(GODOT_PATH 门控)。

const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = GODOT_PATH !== '' && existsSync(GODOT_PATH);
const FIXTURE = resolve('test/fixtures/gut-shard-e2e');
const CLASS_CACHE = join(FIXTURE, '.godot', 'global_script_class_cache.cfg');

function makeCtx(): ToolContext {
  return { findGodot: async () => GODOT_PATH } as unknown as ToolContext;
}

function shardTextOf(result: { content: { text: string }[] }): string {
  return JSON.parse(result.content[0].text);
}

// 夹具的导入缓存(.godot/)被 gitignore:主检出里早就有,全新克隆 / CI 没有。GUT 9.7.1 的
// gut_cmdln.gd 启动时检查全部 Gut* class_name 是否已导入,缺缓存直接拒跑("Some GUT class_names
// have not been imported... run godot --headless --import"),一条测试都不执行(total_tests=0)。
// 2026-11-27 在全新克隆里复现 3 failed;按报错先导入一次后转绿。
function ensureFixtureImported(): void {
  if (existsSync(CLASS_CACHE)) return;
  const imported = spawnSync(GODOT_PATH, ['--headless', '--import', '--path', FIXTURE], {
    encoding: 'utf-8',
    timeout: 120_000,
    windowsHide: true,
  });
  if (imported.error || imported.status !== 0 || !existsSync(CLASS_CACHE)) {
    throw new Error(
      `[D6-SETUP] gut-shard-e2e 夹具预导入失败(exit=${imported.status}): ${imported.error?.message ?? imported.stderr ?? imported.stdout}`,
    );
  }
}

describe.skipIf(!hasGodot)('D6 e2e: run_tests 分片 + GODOT_TEST_MODE 透传(GUT 9.7.1 + ' + (hasGodot ? 'real Godot' : 'GODOT_PATH unset') + ')', () => {
  beforeAll(() => {
    if (hasGodot) ensureFixtureImported();
  }, 180_000);

  it('shards=2: 各片只跑片内文件,delta 永不执行(替换语义),total_tests=6 全过', async () => {
    const result = await handleTool('runtime', {
      action: 'run_tests',
      project_path: FIXTURE,
      shards: 2,
      quit_flag: 'gexit',   // GUT 9.6+ 移除 -gquit
    }, makeCtx());
    const parsed = shardTextOf(result);
    expect(parsed.mode).toBe('sharded');
    expect(parsed.shards).toBe(2);
    // 蛇形: [alpha,gamma](4 tests) | [beta](2 tests)
    expect(parsed.total_tests).toBe(6);
    expect(parsed.total_failed).toBe(0);
    expect(parsed.all_passed).toBe(true);
    // 反馈坑③判据: 项目 .gutconfig.json 的 dirs 指向 res://test_legacy(仅 test_delta.gd,
    // 1 个测试)——若 -gconfig 被附加合并而非替换,每片会多跑 delta,计数将超 6
    expect(parsed.total_tests).not.toBeGreaterThan(6);
    const outputs = parsed.shard_results.map((s: { raw_output: string }) => s.raw_output).join('\n');
    expect(outputs).not.toContain('test_delta');
    // 片文件数蛇形均衡: 3 文件 2 片 → 2|1
    const fileCounts = parsed.shard_results.map((s: { files: number }) => s.files).sort((a: number, b: number) => b - a);
    expect(fileCounts).toEqual([2, 1]);
  }, 180_000);

  it('GODOT_TEST_MODE 透传: shell 设了 → ENVMARK:1;未设 → ENVMARK: 空(非注入)', async () => {
    const wasSet = process.env.GODOT_TEST_MODE;
    try {
      process.env.GODOT_TEST_MODE = '1';
      const withEnv = shardTextOf(await handleTool('runtime', {
        action: 'run_tests', project_path: FIXTURE, shards: 2, quit_flag: 'gexit',
      }, makeCtx()));
      const outWith = withEnv.shard_results.map((s: { raw_output: string }) => s.raw_output).join('\n');
      expect(outWith).toContain('ENVMARK:1');

      delete process.env.GODOT_TEST_MODE;
      const withoutEnv = shardTextOf(await handleTool('runtime', {
        action: 'run_tests', project_path: FIXTURE, shards: 2, quit_flag: 'gexit',
      }, makeCtx()));
      const outWithout = withoutEnv.shard_results.map((s: { raw_output: string }) => s.raw_output).join('\n');
      expect(outWithout).toContain('ENVMARK:');
      expect(outWithout).not.toContain('ENVMARK:1');
    } finally {
      if (wasSet === undefined) delete process.env.GODOT_TEST_MODE;
      else process.env.GODOT_TEST_MODE = wasSet;
    }
  }, 240_000);

  it('shards=1 单进程: -gdir 路径 + GUT 9.7 Totals 无冒号格式解析(passed="6")', async () => {
    const result = await handleTool('runtime', {
      action: 'run_tests',
      project_path: FIXTURE,
      quit_flag: 'gexit',
    }, makeCtx());
    const parsed = shardTextOf(result);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.passed).toBe('6');   // 旧结构 + 新格式双兼容
    expect(parsed.failed).toBe('');    // Failing 行非零才打印: 缺行=0 → 空 join
  }, 180_000);
});
