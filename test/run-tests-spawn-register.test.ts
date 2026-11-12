/**
 * P1-1: run_tests spawn 注册 PID 契约（源码级 grep）。
 *
 * 缺陷背景（vault 2026-07-31 可靠性专项审查 P1）：
 *   runtime.ts:311 run_tests 分支 spawn Godot headless 进程未注册到
 *   _spawnedGodotPids。GodotServer.close()（GodotServer.ts:611-616）只遍历
 *   _spawnedGodotPids 清理 in-flight spawn，故 close() 清不到 run_tests 进程；
 *   且 run_tests 非 detached 非 unref，会阻止 Node 退出最多 120s（timer 兜底）。
 *   这是 07-29 P1-②（gdscript-executor spawn orphan 修复）的遗漏分支——
 *   修复者只盯 gdscript-executor:1198，漏了 run_tests 同型前台 spawn。
 *
 * 对齐参考：gdscript-executor.ts:1198-1199 的 register + unregisterSpawn 闭包模式
 * （见 test/gdscript-spawn-orphan.test.ts 的 B-T4 契约）。
 *
 * 本测试源码级验证（行为级 spy 在 runtime.ts 的 spawn 散点难以稳定 mock，源码契约
 * 已被 gdscript-spawn-orphan.test.ts 证明是该项目该模块的有效范式）：
 *   1. run_tests 分支 spawn 后调 registerSpawnedGodotPid
 *   2. run_tests 三结束路径（close/error/timeout）均调 unregister
 *   3. run_tests 分支独立于 run_project（不依赖 :224 的注册）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = readFileSync(join(__dirname, '../src/tools/runtime.ts'), 'utf-8');

/**
 * 剥离 JS/TS 注释与字符串内容，防 grep 假绿（NEUTERED 注释 / docstring 字面量被当真实调用）。
 * 对齐 anti-pattern-test-that-survives-deleting-guarded-code 教训：
 * 测试断言删除被测代码后必须 RED，故匹配必须在「真实代码 token」上而非注释字面量。
 *
 * 实现：用等长空格替换注释/字符串内容（换行符保留），保证输出与输入**严格等长**，
 * 这样原始源码上定位的下标可直接用于清洗后源码切片。
 */
function stripCommentsAndStrings(src: string): string {
  const chars = src.split('');
  let i = 0;
  const blankTo = (end: number) => {
    for (let j = i; j < end; j++) {
      if (chars[j] !== '\n') chars[j] = ' ';
    }
  };
  while (i < chars.length) {
    const c = chars[i];
    const next = chars[i + 1];
    // 行注释 //
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? chars.length : end;
      blankTo(stop);
      i = stop;
      continue;
    }
    // 块注释 /* */
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? chars.length : end + 2;
      blankTo(stop);
      i = stop;
      continue;
    }
    // 字符串 " ' ` （模板字面量含 ${} 简化处理：整段内容置空，引号也置空）
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      chars[i] = ' ';
      i++;
      while (i < chars.length && chars[i] !== quote) {
        if (chars[i] === '\\') { chars[i] = ' '; i++; if (chars[i] && chars[i] !== '\n') chars[i] = ' '; i++; continue; }
        if (chars[i] !== '\n') chars[i] = ' ';
        i++;
      }
      if (i < chars.length) chars[i] = ' '; // 闭合引号
      i++;
      continue;
    }
    i++;
  }
  return chars.join('');
}

const RUNTIME_SRC_CLEAN = stripCommentsAndStrings(RUNTIME_SRC);

/**
 * 在原始源码上定位 runGutProcess 函数体的 [start, end) 边界，然后从清洗后源码切对应片段。
 * D6 (2026-11-12): run_tests case 重构后 PID 注册不变量的载体从 case 分支移入
 * runGutProcess（shards=1 与分片模式共用的单进程执行函数）——契约定位点随之搬家,
 * 不变量本身（spawn 后 register + 三结束路径 unregister）不变。
 * 这样既准确定位（原始源码 function 声明不会被清洗），又保证断言在真实代码 token 上
 * （清洗去掉注释/字符串字面量，防 NEUTERED 假绿）。
 */
function extractRunTestsBranchClean(): string {
  const startIdx = RUNTIME_SRC.indexOf('function runGutProcess');
  if (startIdx < 0) throw new Error('找不到 function runGutProcess（run_tests 单进程执行载体）');
  const rest = RUNTIME_SRC.slice(startIdx + 1);
  // 函数体终点:下一个顶层函数声明（async function runShardedTests）
  const nextFnMatch = rest.match(/\nasync function /);
  const endIdx = nextFnMatch ? startIdx + 1 + nextFnMatch.index : RUNTIME_SRC.length;
  // 清洗后的源码与原始源码等长（stripCommentsAndStrings 用 '""' 占位保持长度），
  // 故可直接用同一下标切。核实等长以防 strip 实现变化：
  if (RUNTIME_SRC_CLEAN.length !== RUNTIME_SRC.length) {
    throw new Error(`stripCommentsAndStrings 改变了源码长度（${RUNTIME_SRC.length}→${RUNTIME_SRC_CLEAN.length}），分支切片不可信`);
  }
  return RUNTIME_SRC_CLEAN.slice(startIdx, endIdx);
}

describe('P1-1: run_tests spawn 注册 PID（对齐 B-T4 gdscript-executor 模式）', () => {
  it("run_tests 分支存在且可独立抽取", () => {
    expect(RUNTIME_SRC).toMatch(/case 'run_tests':/);
    const branch = extractRunTestsBranchClean();
    // 基本完整性：执行函数内含 spawn + close/error 监听 + timer（清洗后引号变 ""，匹配标识符即可）
    expect(branch).toMatch(/spawn\(/);
    expect(branch).toMatch(/proc\.on\(/);
    expect(branch).toMatch(/setTimeout/);
  });

  it("run_tests spawn 后立即注册 PID（proc 出现后 600 字符内调 register）", () => {
    const branch = extractRunTestsBranchClean();
    const spawnIdx = branch.indexOf('spawn(godot');
    expect(spawnIdx, 'runGutProcess 内应有 spawn(godot, ...)').toBeGreaterThan(0);
    // run_tests 的 spawn 是多行 args 形式（单进程路径 args 数组 --headless/--path/--script/
    // -gdir/-gquit，或分片的 -gconfig=），加上 {stdio,env} 块本身占 ~250 字符，
    // 故窗口取 600（对齐 gdscript-spawn-orphan 用 400 的意图：单行 spawn 取 400，多行 args 取 600）。
    const after = branch.slice(spawnIdx, spawnIdx + 600);
    expect(
      after,
      'spawn 后应紧跟 registerSpawnedGodotPid(proc.pid)（非注释/字符串字面量）'
    ).toMatch(/\bregisterSpawnedGodotPid\s*\(\s*proc\.pid\s*\)/);
  });

  it("run_tests 三结束路径均调 unregister（close / error / timeout）", () => {
    const branch = extractRunTestsBranchClean();
    // 闭包定义：const unregisterSpawn = () => { ... unregisterSpawnedGodotPid(proc.pid) ... }
    // 注意 \b 词边界：unregisterSpawnedGodotPid 含子串 registerSpawnedGodotPid，必须排除
    const closureDef = branch.match(/unregisterSpawnedGodotPid\s*\(\s*proc\.pid\s*\)/g) ?? [];
    // 三路径调用：unregisterSpawn()（close / error / timeout 各 1）
    const closureCalls = branch.match(/\bunregisterSpawn\s*\(\s*\)/g) ?? [];
    // 期望精确：1 个闭包定义 + 3 个路径调用 = 4。若误用 >=3，删一个仍绿（假绿）
    expect(
      closureDef.length,
      `闭包定义 unregisterSpawnedGodotPid(proc.pid) 数量 ${closureDef.length}，期望 1`
    ).toBe(1);
    expect(
      closureCalls.length,
      `路径调用 unregisterSpawn() 数量 ${closureCalls.length}，期望 3 [close+error+timeout]`
    ).toBe(3);
  });

  it("run_tests 注册独立于 run_project（:224 注册不能算 run_tests 的覆盖）", () => {
    // 抽取的 run_tests 执行函数必须自含 register，不能依赖函数外的 run_project 注册
    // \b 词边界：排除 unregisterSpawnedGodotPid 的子串匹配（un-register）
    const branch = extractRunTestsBranchClean();
    const branchRegister = branch.match(/\bregisterSpawnedGodotPid\s*\(\s*proc\.pid\s*\)/g) ?? [];
    expect(
      branchRegister.length,
      'runGutProcess 内必须有自己的 register 调用（不能依赖 run_project :224）'
    ).toBeGreaterThanOrEqual(1);
  });
});
