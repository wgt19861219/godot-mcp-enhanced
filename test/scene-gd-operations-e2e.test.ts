import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// 审查 I-F(2026-09-03) 测试沉淀: 全面维度审查发现 GD 侧行为修复零自动化锚定——
// check:gdscript 编译层抓不到运行时类型错/行为回归(send_drag 事故的共同盲区),真机 e2e
// 基建已存在(scene-uid-preserve.test.ts 的 GODOT_PATH skipIf 模式)却未沉淀。本文件锚定:
// - batch 属性失败注入 → exit 1 + stderr per-node 清单 + 成功节点已落盘(Minor-1 提示)
// - remove_node 真机落盘子树删除 + root 拒绝 exit 1(ca68d56 持久化链)
// - add_node parent 剥离链统一(M-3): "/root/<根名>" 与 "<根名>/Child" 前缀均可解析
// 修改 godot_operations.gd 的 batch 失败计数/remove 持久化/parent 规范化后,本套必红。

const GODOT_PATH = process.env.GODOT_PATH || '';
const hasGodot = GODOT_PATH !== '' && existsSync(GODOT_PATH);

function makeProject(tag: string): string {
  const proj = join(tmpdir(), `gd-ops-e2e-${tag}-${Date.now()}`);
  mkdirSync(join(proj, 'scenes'), { recursive: true });
  writeFileSync(join(proj, 'project.godot'), 'config_version=5\n', 'utf-8');
  writeFileSync(join(proj, 'scenes', 'main.tscn'),
    '[gd_scene format=3 uid="uid://gdopse2e0000001"]\n\n[node name="Main" type="Node2D"]\n', 'utf-8');
  return proj;
}

function runOps(proj: string, op: string, params: Record<string, unknown>):
  { status: number | null; stdout: string; stderr: string } {
  const opsScript = resolve('src/scripts/godot_operations.gd');
  const r = spawnSync(GODOT_PATH, [
    '--headless', '--path', proj, '--script', opsScript, op,
    JSON.stringify(params),
  ], { encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe.skipIf(!hasGodot)('审查 I-F e2e: batch 失败注入/remove 落盘/parent 规范化(GODOT_PATH=' + (hasGodot ? 'set' : 'unset') + ')', () => {
  it('batch 属性失败:exit 1 + stderr per-node 清单 + 成功节点已落盘 + Minor-1 重试提示', () => {
    const proj = makeProject('batchfail');
    try {
      const r = runOps(proj, 'batch_add_nodes', {
        scene_path: 'res://scenes/main.tscn',
        nodes: [
          { node_type: 'Node2D', node_name: 'GoodNode', properties: { position: [100, 200] } },
          { node_type: 'Node2D', node_name: 'BadNode', properties: { position: [100] } },  // 分量不足 → coerce 失败
        ],
      });
      expect(r.status, `退出码(stdout:${r.stdout} stderr:${r.stderr})`).toBe(1);
      // per-node 失败清单走 stderr(log_error=printerr)——锚定 I-A 的通道语义
      expect(r.stderr).toMatch(/Failed to add 1 nodes/);
      expect(r.stderr).toContain('BadNode');
      expect(r.stderr).toMatch(/already persisted.*query_scene_tree/s);  // Minor-1 重试防重复提示
      const scene = readFileSync(join(proj, 'scenes', 'main.tscn'), 'utf-8');
      expect(scene, '成功节点已落盘(部分失败语义:成功者持久化)').toContain('GoodNode');
      expect(scene, '失败节点不落盘').not.toContain('BadNode');
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 90_000);

  it('remove_node:子树整体落盘删除 + root 拒绝 exit 1', () => {
    const proj = makeProject('remove');
    try {
      // 组装 Main > Child > GrandChild(parent_node_path 用根名前缀,同时锚定 M-3 统一剥离链)
      const add1 = runOps(proj, 'add_node', { scene_path: 'res://scenes/main.tscn', node_type: 'Node2D', node_name: 'Child', parent_node_path: 'Main' });
      expect(add1.status, `add Child(stderr:${add1.stderr})`).toBe(0);
      const add2 = runOps(proj, 'add_node', { scene_path: 'res://scenes/main.tscn', node_type: 'Node2D', node_name: 'GrandChild', parent_node_path: '/root/Main/Child' });
      expect(add2.status, `add GrandChild 经 /root/ 前缀(stderr:${add2.stderr})`).toBe(0);
      let scene = readFileSync(join(proj, 'scenes', 'main.tscn'), 'utf-8');
      expect(scene).toContain('Child');
      expect(scene).toContain('GrandChild');

      // remove Child → 子树(含 GrandChild)落盘删除,uid 回填不丢 header uid
      const rm = runOps(proj, 'remove_node', { scene_path: 'res://scenes/main.tscn', node_path: 'Child' });
      expect(rm.status, `remove stderr:${rm.stderr}`).toBe(0);
      scene = readFileSync(join(proj, 'scenes', 'main.tscn'), 'utf-8');
      expect(scene, '子树根删除').not.toContain('Child');
      expect(scene, '孙节点随子树删除').not.toContain('GrandChild');
      expect(scene, '场景根保留').toContain('Main');
      expect(scene, 'uid 回填保留(A5)').toContain('uid="uid://gdopse2e0000001"');

      // remove 根名 → 显式拒绝 exit 1(错误在 stderr)
      const rmRoot = runOps(proj, 'remove_node', { scene_path: 'res://scenes/main.tscn', node_path: 'Main' });
      expect(rmRoot.status).toBe(1);
      expect(rmRoot.stderr).toMatch(/[Rr]oot/);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 120_000);

  it('add_node parent 剥离链统一(M-3): "/root/<根名>" 指根自身、"<根名>/Child" 剥前缀', () => {
    const proj = makeProject('parent');
    try {
      // 先建 Child,再用 "/root/Main"(= 根自身)与 "Main/Child"(根名前缀)两种历史分叉形态挂孙节点
      const add1 = runOps(proj, 'add_node', { scene_path: 'res://scenes/main.tscn', node_type: 'Node2D', node_name: 'Child', parent_node_path: '/root/Main' });
      expect(add1.status, `"/root/Main" 解析为根自身(原 fallback 路径 not found, M-3 修复)stderr:${add1.stderr}`).toBe(0);
      const add2 = runOps(proj, 'add_node', { scene_path: 'res://scenes/main.tscn', node_type: 'Node2D', node_name: 'GrandChild', parent_node_path: 'Main/Child' });
      expect(add2.status, `"Main/Child" 剥根名前缀解析(query_scene_tree 拷贝路径形态)stderr:${add2.stderr}`).toBe(0);
      const scene = readFileSync(join(proj, 'scenes', 'main.tscn'), 'utf-8');
      expect(scene).toContain('Child');
      expect(scene).toContain('GrandChild');
      expect(scene).toMatch(/parent="Child"/);  // GrandChild 挂在 Child 下(而非根下)——剥离链正确
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 90_000);
});

// ─── Task B(2026-09-17 架构审查): H-1 headless 数学分量守卫 ──
// 修复前: _math_comp 无类型白名单,容器分量({"x":{}})穿透到 float() = "Nonexistent 'float'
// constructor" SCRIPT ERROR(真机 4.6.3 实证;上游 "cannot coerce" 是错误中断返回 null 的
// 未定义行为兜底,交互场景实测可挂死)——同 Task A bridge 侧 I-C 结论的 headless 收口。
describe.skipIf(!hasGodot)('Task B: H-1 数学分量守卫(GODOT_PATH=' + (hasGodot ? 'set' : 'unset') + ')', () => {
  // 毒分量修复前在交互场景会挂死进程,timeout 收紧到 20s 快速失败 + 显式 timedOut 检出(共用 runOps 的 60s 太慢)
  function runOpsFast(proj: string, op: string, params: Record<string, unknown>):
    { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
    const opsScript = resolve('src/scripts/godot_operations.gd');
    const r = spawnSync(GODOT_PATH, [
      '--headless', '--path', proj, '--script', opsScript, op,
      JSON.stringify(params),
    ], { encoding: 'utf8', timeout: 20_000 });
    const timedOut = !!r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut };
  }

  it('H-1: add_node 毒分量 position={"x":{}, "y":2} → 白名单拒绝走可读错误 exit 1,无 SCRIPT ERROR,节点不落盘', () => {
    const proj = makeProject('poisoncomp');
    try {
      const r = runOpsFast(proj, 'add_node', {
        scene_path: 'res://scenes/main.tscn',
        node_type: 'Node2D',
        node_name: 'PoisonNode',
        properties: { position: { x: {}, y: 2 } },
      });
      expect(r.timedOut, '进程不应挂死(修复前 float({}) SCRIPT ERROR 后交互场景可卡死)').toBe(false);
      expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/SCRIPT ERROR/);
      expect(r.status, 'coerce 失败走 C-1 整节点失败 exit 1,stderr:' + r.stderr).toBe(1);
      expect(r.stderr, '可读错误点名(上游 -8 同款文案)').toMatch(/cannot coerce/);
      const scene = readFileSync(join(proj, 'scenes', 'main.tscn'), 'utf8');
      expect(scene, '失败节点不落盘').not.toContain('PoisonNode');
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 60_000);
});
