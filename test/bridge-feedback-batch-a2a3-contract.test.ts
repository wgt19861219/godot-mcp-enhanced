/**
 * 反馈批次 2026-11-12 Task A2+A3 契约级锁定(源码字面量契约,模式同 cmp-9-bridge-call-method):
 * - A2: click_button real_event verify 协程全路径存活守卫——自毁钮(pressed handler 内
 *   queue_free 自身)在 verify 等帧窗口内被引擎释放,修复前末尾读 btn.get("text")/
 *   btn.button_pressed 对已释放对象取属性 → Debugger Break 挂死主循环(2026-10-10/
 *   09-24/09-28/11-02 三项目三踩)。行为级 e2e 见 test/e2e-bridge-self-destruct.test.ts
 *   (GODOT_PATH 门控,自毁钮 fixture 真机点击不挂)。
 * - A3: _cmd_call_method 硬黑名单预检前置——此前 EXTRA_METHODS_BLOCKLIST 分支只在
 *   (_extra_ok or _gda_ok) 命中后才查,普通调用 blocklist 方法(如 set)落 -2 白名单
 *   首条报错,文案却建议 "allow via env/GDA_CALLABLE";照做设 env 后再撞 -6 硬底线,
 *   误导死路(2026-09-25 反馈)。预检前移判定链最前,首条报错即终判。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const gd = readFileSync('src/scripts/mcp_bridge.gd', 'utf8');

function funcSlice(name: string): string {
  const start = gd.indexOf(`func ${name}`);
  expect(start, `${name} 须存在`).toBeGreaterThanOrEqual(0);
  const end = gd.indexOf('\nfunc ', start + 10);
  return gd.slice(start, end === -1 ? undefined : end);
}

describe('A2: real_event verify 窗口全路径存活守卫(自毁钮)', () => {
  const s = funcSlice('_await_click_verify_and_respond');

  it('A2-a: button text 在 press 注入前缓存为局部变量,末尾不再读节点', () => {
    const cacheIdx = s.indexOf('var _btn_text_raw: Variant = btn.get("text")');
    const pressIdx = s.indexOf('vp.push_input(press)');
    expect(cacheIdx, '须有 btn_text 缓存声明(单次读取)').toBeGreaterThanOrEqual(0);
    expect(pressIdx, '须有 press 注入').toBeGreaterThan(cacheIdx);
    // 响应体用缓存变量,不读节点
    expect(s.includes('"button_text": btn_text'), '响应 button_text 须用缓存变量').toBe(true);
    // 函数内 btn.get("text") 仅允许出现一次(缓存处)——注入之后再读即裸点
    expect((s.match(/btn\.get\("text"\)/g) ?? []).length,
      'btn.get("text") 须且仅须出现一次(press 前缓存;末尾再读=对已 free 对象取属性)').toBe(1);
  });

  it('A2-b: press 等 2 帧归来后 is_instance_valid 守卫 release 注入(自毁钮跳过 release)', () => {
    const pressIdx = s.indexOf('vp.push_input(press)');
    const guardIdx = s.indexOf('if is_instance_valid(btn):');
    const releaseIdx = s.indexOf('vp.push_input(release)');
    expect(guardIdx, '须有 is_instance_valid(btn) 守卫分支').toBeGreaterThanOrEqual(0);
    expect(guardIdx, '守卫须在 press 注入之后(await 归来节点可能已 free)').toBeGreaterThan(pressIdx);
    expect(releaseIdx, 'release 注入须在守卫分支内(已 free 时跳过)').toBeGreaterThan(guardIdx);
  });

  it('A2-c: 末尾 button_pressed 读取前置守卫(已 free → null,不崩不误报 false)', () => {
    expect(s.includes('btn.button_pressed if is_instance_valid(btn) else null'),
      'button_pressed 须守卫读取:已 free 时给 null(节点没了读不到,给 false 是误报)').toBe(true);
  });

  it('A2-e: recorder.detach 调用点前置守卫(真机定谳:向类型化参数传 freed 对象,Debugger 下参数传递即 Break,detach 内部守卫执行不到)', () => {
    // 真机铁证(2026-11-13,Godot 4.7 带窗口):"Invalid type in function 'detach' ...
    // argument 1 (previously freed)" —— 挂点在调用点参数传递,非 detach 函数体。
    const guardDetach = s.indexOf('if is_instance_valid(btn):\n\t\t\t\trecorder.detach(btn)');
    const detachCall = s.indexOf('recorder.detach(btn)');
    expect(detachCall, '须有 detach 调用').toBeGreaterThanOrEqual(0);
    expect(guardDetach, 'detach 调用须在 is_instance_valid(btn) 守卫分支内(调用点守卫,detach 内部守卫不够)').toBeGreaterThanOrEqual(0);
  });

  it('A2-d: device=0 两处保留(批次C契约回归,守卫分支不得吞 release 的 device=0)', () => {
    const devices = s.match(/\.device = 0/g) ?? [];
    expect(devices.length, 'press/release 两处均须 device=0').toBe(2);
  });
});

describe('A3: call_method 硬黑名单预检前置(首条报错不再误导)', () => {
  const s = funcSlice('_cmd_call_method');

  it('A3-a: BLOCKLIST 预检无条件形态,且在判定链最前(先于 env/GDA 解析与白名单首条报错)', () => {
    const blIdx = s.indexOf('if method in EXTRA_METHODS_BLOCKLIST:');
    expect(blIdx, '须有无条件 BLOCKLIST 预检(无 allowlist 前缀)').toBeGreaterThanOrEqual(0);
    const envIdx = s.indexOf('var _extra_env :=');
    expect(envIdx, 'env 解析须在预检之后').toBeGreaterThan(blIdx);
    const gdaIdx = s.indexOf('var _gda_ok :=');
    expect(gdaIdx, 'GDA 解析须在预检之后').toBeGreaterThan(blIdx);
    const allowIdx = s.indexOf('if not method in ALLOWED_METHODS');
    expect(allowIdx, '白名单首条报错须在预检之后(blocklist 方法不得先落 -2 误导文案)').toBeGreaterThan(blIdx);
  });

  it('A3-b: 不再有 allowlist 条件前缀形态(旧形态=普通调用 set 落 -2 "allow via" 误导死路)', () => {
    expect(s.includes('(_extra_ok or _gda_ok) and method in EXTRA_METHODS_BLOCKLIST'),
      'BLOCKLIST 分支不得再挂 (_extra_ok or _gda_ok) 前缀').toBe(false);
  });

  it('A3-c: -6 硬底线文案保留在预检分支内(hard floor 措辞 + 内层 args[0] 检查随迁)', () => {
    const blIdx = s.indexOf('if method in EXTRA_METHODS_BLOCKLIST:');
    const branch = s.slice(blIdx, blIdx + 900);
    expect(branch.includes('"code": -6'), '预检分支须返 -6').toBe(true);
    expect(branch.includes('hard floor'), '须保留 hard floor 硬底线措辞').toBe(true);
    expect(branch.includes("args[0] in EXTRA_METHODS_BLOCKLIST"),
      'B-2 内层 args[0] 检查须随迁(纵深防御)').toBe(true);
  });

  it('A3-d: -2 白名单首条报错文案保留(非 blocklist 方法的 allow 建议不变)', () => {
    const allowIdx = s.indexOf('if not method in ALLOWED_METHODS');
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    const branch = s.slice(allowIdx, allowIdx + 400);
    expect(branch.includes('allow via'), '普通方法仍须给 allow via 指引').toBe(true);
  });
});
