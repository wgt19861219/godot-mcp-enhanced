// Level B 集成测试：场景操作工具（scene.handleTool）
import { expect, it, beforeEach, describe, vi } from 'vitest';
import { stripEnvelope } from '../src/core/untrusted-wrap.js';
import { mockSuccessResult, mockSuccessSpawn } from './helpers/mock-results.js';

// Mock the executor — hoisted to top by Vitest
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve(mockSuccessResult({
    outputs: [{ key: 'result', value: '{"ok":true}' }],
  }))),
  parseMcpMarkers: vi.fn((raw) => ({
    parsed: null,
    logLines: raw.split('\n').map((l) => l.trim()).filter(Boolean),
  })),
}));

// Mock spawnGodot — Task 3: edit_node 迁移到 spawnGodot 路径，需 mock 避免真 spawn
vi.mock('../src/tools/spawn-helper.js', () => ({
  spawnGodot: vi.fn(() => Promise.resolve(mockSuccessSpawn({
    stdout: "Node 'root/Root/MovableNode' edited successfully",
  }))),
}));

import { executeGdscript } from '../src/gdscript-executor.js';
import { spawnGodot } from '../src/tools/spawn-helper.js';
import * as scene from '../src/tools/scene.js';
import { createToolContext, createTempProject, registerCleanup } from './helpers/tool-context.js';
import { MINIMAL_PROJECT } from './helpers/fixtures.js';

/**
 * 辅助函数：判断工具调用结果是否成功。
 * - spawn 路径（add_node）返回 { content: [{ text }] }，成功和失败都不设 isError，
 *   需检查 text 中的错误关键词。
 * - parseGdscriptResult 路径成功时返回 textResult（无 isError），失败时返回
 *   opsErrorResult（isError=true）。
 * - read_scene 成功和"未找到"都返回 textResult，需检查文本内容。
 */
function isSuccessful(result) {
  if (result.isError) return false;
  const text = result.content?.[0]?.text || '';
  if (/failed \(exit code \d+\)/i.test(text)) return false;
  try {
    const parsed = JSON.parse(stripEnvelope(text));
    if (parsed.success === false) return false;
  } catch { /* 非 JSON，忽略 */ }
  return true;
}

describe('Level B: Scene Operations', () => {
  const dirRef = { path: null };
  let ctx;

  // 注册临时目录自动清理
  registerCleanup(dirRef);

  beforeEach(() => {
    vi.mocked(executeGdscript).mockReset();
    vi.mocked(spawnGodot).mockReset();
    // Task 3: edit_node 默认成功 mock（个别 case 可覆盖）
    vi.mocked(spawnGodot).mockResolvedValue({
      stdout: "Node 'root/Root/MovableNode' edited successfully",
      stderr: '', output: '', exitCode: 0, timedOut: false,
    });
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => 'godot';
  });

  // --- 用例 1: add_node — 添加 Sprite2D 到场景 ---
  it('add_node — 添加 Sprite2D 到 main.tscn', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'add_node',
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Sprite2D',
      node_name: 'TestSprite',
    }, ctx);
    expect(isSuccessful(result)).toBeTruthy();
    // Tier1-1: structuredContent 验证(成功路径,文本编辑落盘)
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent.action).toBe('add_node');
    expect(result.structuredContent.node_name).toBe('TestSprite');
    expect(result.structuredContent.node_type).toBe('Sprite2D');
    expect(result.structuredContent.parent).toBe('root');
    expect(result.structuredContent.persisted).toBe(true);
  });

  // B2(反馈批次 B, 2026-09-09): add_node parent 含场景根名前缀(query_scene_tree 拷贝形态
  // "Root/Main")——修复前文本路径报 "Parent node not found"(与 batch/GD 链分叉),
  // 修复后剥根名前缀对齐 GD 链 _resolve_parent_node,落盘 parent="Main"。
  it('add_node — parent 含场景根名前缀(Root/Main)剥根名后落盘(B2)', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'add_node',
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'B2Child',
      parent_node_path: 'Root/Main',
    }, ctx);
    expect(isSuccessful(result)).toBeTruthy();
    const { readFileSync } = await import('node:fs');
    const tscn = readFileSync(`${dirRef.path}/scenes/main.tscn`, 'utf-8');
    expect(tscn).toContain('[node name="B2Child" type="Node2D" parent="Main"]');
  });

  // B5(反馈批次 B): add_node 文本捷径产物落盘前过 verifySceneTree 自检(正常产物通过不打扰;
  // 自检失败的拒写形态由 tscn-editor-add-node.test.ts 的 verifySceneTree 单测覆盖)。
  it('add_node — 正常添加落盘(自检接线不误伤,B5)', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'add_node',
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'SelfCheckOk',
      parent_node_path: 'Main',
    }, ctx);
    expect(isSuccessful(result)).toBeTruthy();
    const { readFileSync } = await import('node:fs');
    const tscn = readFileSync(`${dirRef.path}/scenes/main.tscn`, 'utf-8');
    expect(tscn).toContain('SelfCheckOk');
  });

  // 审查 N2(2026-09-17): parent 前缀正则曾为 /^\/?root\/?/(尾斜杠可选),
  // "rootMain" 被误剥成 "Main" 静默指向错误节点;修正后不再误剥,如实报 not found。
  it('add_node — parent "rootMain" 不被误剥成 "Main"(审查 N2)', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'add_node',
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'N2Guard',
      parent_node_path: 'rootMain',
    }, ctx);
    // rootMain 节点不存在 → 如实报错(而非误剥成 Main 成功)
    // 注:addNode 失败走 textResult 无 isError 标志,isSuccessful 对 "Error:" 文本放行,故直接断言错误文本
    const text = result.content?.[0]?.text || '';
    expect(text).toContain('Parent node not found');
  });

  // P1-3 (2026-08-11 审查): add_node 错误路径 — 场景文件不存在 → FILE_NOT_FOUND
  // 注:重名/父节点无效/父不存在在 GD 侧(addNode 文本编辑不检测,spawn 路径 GD 侧检),
  // mock 鸿沟切断(靠 godot-matrix e2e 验证),此处覆盖 TS 侧可达错误路径。
  it('add_node 场景文件不存在 → FILE_NOT_FOUND(P1-3 TS 侧错误路径)', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'add_node',
      scene_path: 'res://nonexistent.tscn',
      node_type: 'Node',
      node_name: 'X',
    }, ctx);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/FILE_NOT_FOUND|not found/i);
  });

  // --- 用例 2: edit_node — 添加节点后修改位置 ---
  it('edit_node — add_node + edit_node position', async () => {
    await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'add_node',
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'MovableNode',
    }, ctx);

    const editResult = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'edit_node',
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/MovableNode',
      properties: { position: [100, 200] },
    }, ctx);
    expect(isSuccessful(editResult)).toBeTruthy();
  });

  // --- 用例 3: query_scene_tree — 查询场景树 ---
  it('query_scene_tree — 查询 main.tscn 场景树', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'read_scene',
      scene_path: 'res://scenes/main.tscn',
    }, ctx);
    expect(isSuccessful(result)).toBeTruthy();
    const text = result.content[0].text;
    expect(text).toContain('Root');
  });

  // --- 用例 4: full CRUD cycle — 创建 → 编辑 → 删除 ---
  it('full CRUD cycle — create, edit, remove', async () => {
    const scenePath = 'res://scenes/main.tscn';

    // 创建
    const addResult = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'add_node',
      scene_path: scenePath,
      node_type: 'Node2D',
      node_name: 'CRUDNode',
    }, ctx);
    expect(isSuccessful(addResult)).toBeTruthy();

    // 编辑
    const editResult = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'edit_node',
      scene_path: scenePath,
      node_path: 'root/Root/CRUDNode',
      properties: { position: [50, 75] },
    }, ctx);
    expect(isSuccessful(editResult)).toBeTruthy();

    // 删除
    const removeResult = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'remove_node',
      scene_path: scenePath,
      node_path: 'root/Root/CRUDNode',
    }, ctx);
    expect(isSuccessful(removeResult)).toBeTruthy();
  });

  // --- M-3: 只读查询 scene_path 防 ../ 逃逸（read 级信息泄露）---
  it('M-3: query_scene_tree 拒绝含 ../ 的 scene_path', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'query_scene_tree',
      scene_path: '../secret.tscn',
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text || '').toMatch(/INVALID_PATH|path traversal/);
  });

  it('M-3: inspect_node 拒绝含 ../ 的 scene_path', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'inspect_node',
      scene_path: '../secret.tscn',
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text || '').toMatch(/INVALID_PATH|path traversal/);
  });

  // --- 用例 5: remove_node confirmation token 流程 ---
  it('remove_node confirmation token — 无 token 时检查返回值', async () => {
    // 先添加节点
    await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'add_node',
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'TokenNode',
    }, ctx);

    // 尝试无 confirmation_token 删除
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'remove_node',
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/TokenNode',
    }, ctx);

    const text = result.content?.[0]?.text || '';

    // 如果返回 confirmation_token，使用它完成删除
    if (text.includes('confirmation_token')) {
      try {
        const parsed = JSON.parse(stripEnvelope(text));
        if (parsed.confirmation_token) {
          const confirmResult = await scene.handleTool('scene', {
            project_path: dirRef.path,
            action: 'remove_node',
            scene_path: 'res://scenes/main.tscn',
            node_path: 'root/Root/TokenNode',
            confirmation_token: parsed.confirmation_token,
          }, ctx);
          expect(isSuccessful(confirmResult)).toBeTruthy();
          return;
        }
      } catch { /* 非 JSON 格式，继续 */ }
    }

    // 无 confirmation_token 时，直接删除应成功
    expect(isSuccessful(result)).toBeTruthy();
  });

  // --- 用例 6: nonexistent scene — 读取不存在的场景 ---
  it('nonexistent scene — read_scene 不存在的 .tscn 应返回错误', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'read_scene',
      scene_path: 'res://scenes/DOES_NOT_EXIST.tscn',
    }, ctx);
    const text = result.content?.[0]?.text || '';
    expect(
      text.includes('not found') || text.includes('NOT_EXIST') || result.isError,
    ).toBeTruthy();
  });

  // P1-4（2026-07-31 补）：scene 操作状态反查断言。
  // 看板指控：isSuccessful()（:43-52）只判 isError 标志 + 文本 regex，从不验证节点真的加了/改了/删了。
  // 本组测试用 read_scene 反查真实 .tscn 文件状态（read_scene:123-133 走 readFileSync + parseTscn，
  // 不走 mock），验证操作真的落地。
  //
  // 关键洞察：add_node 的 P1 文本编辑路径（scene/index.ts:172-205）调 addNode() 纯文本编辑 +
  // writeFileSync 真写文件（无 fallback 到 spawnGodot 时）。所以 add_node(无 properties) 后
  // read_scene 反查能验证节点真落盘——这是有意义的真状态断言，非 mock 自证。
  //
  // 但 edit_node/remove_node 走 spawnGodot（mock 返固定文本不写文件），反查会暴露"mock 鸿沟"——
  // 即 mock 环境无法验证这些操作的真落地，真验证靠 godot-matrix e2e。这显式记录了看板自评的
  // "mock 环境价值有限"边界。
  describe('P1-4: 状态反查断言（read_scene 验证操作真落地）', () => {
    // 解析 read_scene 返回的 JSON，提取节点名列表
    function getNodeNames(readResult) {
      const text = readResult.content?.[0]?.text || '';
      try {
        const parsed = JSON.parse(stripEnvelope(text));
        // nodeTree 是根节点数组，每个节点有 name；递归收集所有节点名
        const names = [];
        const walk = (nodes) => {
          if (!Array.isArray(nodes)) return;
          for (const n of nodes) {
            if (n.name) names.push(n.name);
            if (n.children) walk(n.children);
          }
        };
        walk(parsed.nodeTree);
        return names;
      } catch {
        return null;  // 非 JSON（如错误文本）
      }
    }

    it('add_node 后 read_scene 反查 — 新节点真落盘（P1 文本编辑路径写文件）', async () => {
      // add_node 无 properties → 走 P1 文本编辑路径（index.ts:172-205）真写 .tscn
      const addResult = await scene.handleTool('scene', {
        project_path: dirRef.path,
        action: 'add_node',
        scene_path: 'res://scenes/main.tscn',
        node_type: 'Sprite2D',
        node_name: 'VerifiableNode',
      }, ctx);
      expect(isSuccessful(addResult), 'add_node 应成功').toBeTruthy();

      // read_scene 反查（走 readFileSync，不依赖 mock）
      const readResult = await scene.handleTool('scene', {
        project_path: dirRef.path,
        action: 'read_scene',
        scene_path: 'res://scenes/main.tscn',
      }, ctx);
      expect(isSuccessful(readResult), 'read_scene 应成功').toBeTruthy();

      const names = getNodeNames(readResult);
      expect(names, '应能解析出节点名列表').not.toBeNull();
      expect(names, '新节点 VerifiableNode 应真落盘').toContain('VerifiableNode');
    });

    it('add_node 不同节点名 — 反查验证多个节点都落盘（非巧合）', async () => {
      await scene.handleTool('scene', {
        project_path: dirRef.path,
        action: 'add_node',
        scene_path: 'res://scenes/main.tscn',
        node_type: 'Node2D',
        node_name: 'NodeA',
      }, ctx);
      await scene.handleTool('scene', {
        project_path: dirRef.path,
        action: 'add_node',
        scene_path: 'res://scenes/main.tscn',
        node_type: 'Node2D',
        node_name: 'NodeB',
      }, ctx);

      const readResult = await scene.handleTool('scene', {
        project_path: dirRef.path,
        action: 'read_scene',
        scene_path: 'res://scenes/main.tscn',
      }, ctx);
      const names = getNodeNames(readResult);
      expect(names, 'NodeA 应落盘').toContain('NodeA');
      expect(names, 'NodeB 应落盘').toContain('NodeB');
    });
  });
});
