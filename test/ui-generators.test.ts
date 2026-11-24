/**
 * P2-E (2026-08-08): ui-create/layout/draw 纯函数单测。
 *
 * src/tools/ui/ui-create.ts / ui-layout.ts / ui-draw.ts 的函数生成 GDScript 脚本字符串。
 * 这些是纯函数（无副作用），适合单测——验证生成的脚本含正确的关键结构
 * （_initialize/load_scene/instantiate/属性赋值/anchors 等）。
 */
import { describe, it, expect } from 'vitest';
import { genUiCreateControlScript, genUiContainerAddScript, genUiAnchorPresetScript } from '../src/tools/ui/ui-create.js';
import { genUiSetLayoutScript } from '../src/tools/ui/ui-layout.js';
import { genTokenPrefetchScript, genTokenSetScript, genTokenListScript } from '../src/tools/ui/ui-tokens.js';
import { genThemeCreateScript } from '../src/tools/ui/ui-theme.js';
import { DESIGN_TOKENS_TYPE } from '../src/tools/ui/types.js';

describe('P2-E: genUiCreateControlScript', () => {
  it('生成含 _initialize/load_scene/instantiate/add_child 的脚本', () => {
    const script = genUiCreateControlScript('res://main.tscn', 'Button', 'MyButton', '/root/Root');
    expect(script).toContain('func _initialize()');
    expect(script).toContain('_mcp_load_scene("res://main.tscn")');
    expect(script).toContain('ClassDB.instantiate("Button")');
    expect(script).toContain('node.name = "MyButton"');
    expect(script).toContain('parent.add_child(node)');
    expect(script).toContain('_mcp_output("created"');
    expect(script).toContain('_mcp_done()');
  });

  it('含 parent 查找 + null 守卫', () => {
    const script = genUiCreateControlScript('res://main.tscn', 'Label', 'MyLabel', '/root/Root/Panel');
    expect(script).toContain('_mcp_get_scene_node("/root/Root/Panel")');
    expect(script).toContain('Parent node not found');
    expect(script).toContain('Failed to instantiate');
  });

  it('properties 生成属性赋值行', () => {
    const script = genUiCreateControlScript('res://main.tscn', 'Label', 'L', '.', { text: 'Hello', visible: true });
    // genPropertyLines（types.ts）经 _mcp_set_prop 赋值（Task D5: 运行时按目标属性类型 coerce），非直接 node.text =
    expect(script).toContain('Hello');
    expect(script).toContain('_mcp_set_prop(node,'); // 属性经 _mcp_set_prop 赋值
  });

  it('无 properties 时不生成属性行', () => {
    const script = genUiCreateControlScript('res://main.tscn', 'Label', 'L', '.');
    // 无 properties 时不应有 node. 属性赋值（name 赋值除外）
    expect(script).toContain('node.name = "L"');
    // 不含额外属性行（text/visible 等）
    expect(script).not.toContain('node.text');
  });

  it('特殊字符经 gdEscape 转义', () => {
    const script = genUiCreateControlScript('res://main.tscn', 'Label', 'Na"me', '.');
    // gdEscape 应转义双引号
    expect(script).toContain('\\"');
  });
});

describe('P2-E: genUiContainerAddScript', () => {
  it('生成含 add_child 的容器脚本', () => {
    // 签名: (scenePath, nodePath, childType, childName)；childType 须在 CONTROL_TYPES 白名单
    const script = genUiContainerAddScript('res://main.tscn', '/root/Root', 'Button', 'MyButton');
    expect(script).toContain('ClassDB.instantiate("Button")');
    expect(script).toContain('add_child');
    expect(script).toContain('child.name = "MyButton"'); // container 用 child 非 node
  });

  it('拒绝非白名单 Control type', () => {
    expect(() => genUiContainerAddScript('res://main.tscn', '/root/Root', 'Node', 'N'))
      .toThrow(/INVALID_CONTROL_TYPE/);
  });
});

describe('P2-E: genUiAnchorPresetScript', () => {
  it('生成含 set_anchors_preset + Control 守卫的脚本', () => {
    // 签名: (scenePath, nodePath, presetValue: number, presetName: string)
    const script = genUiAnchorPresetScript('res://main.tscn', '/root/Root/Node', 15, 'full_rect');
    expect(script).toContain('_mcp_load_scene');
    expect(script).toContain('set_anchors_preset(15)'); // 用 set_anchors_preset 整体赋值
    expect(script).toContain('Control'); // Control 类型守卫
    expect(script).toContain('preset_applied');
  });
});

describe('P2-E: genUiSetLayoutScript', () => {
  it('anchors 生成 anchor_left/right/top/bottom 赋值', () => {
    const script = genUiSetLayoutScript('res://main.tscn', '/root/Root/Node', {
      left: 0, right: 1, top: 0, bottom: 1,
    });
    expect(script).toContain('node.anchor_left = 0');
    expect(script).toContain('node.anchor_right = 1');
    expect(script).toContain('node.anchor_top = 0');
    expect(script).toContain('node.anchor_bottom = 1');
  });

  it('offsets 生成 offset_left/right/top/bottom 赋值', () => {
    const script = genUiSetLayoutScript('res://main.tscn', '/root/Root/Node',
      undefined, // anchors
      { left: 10, right: -10, top: 5, bottom: -5 }, // offsets
    );
    expect(script).toContain('node.offset_left = 10');
    expect(script).toContain('node.offset_right = -10');
    expect(script).toContain('node.offset_top = 5');
    expect(script).toContain('node.offset_bottom = -5');
  });

  it('minSize 生成 custom_minimum_size Vector2 赋值', () => {
    const script = genUiSetLayoutScript('res://main.tscn', '/root/Root/Node',
      undefined, undefined,
      { x: 100, y: 50 }, // minSize
    );
    expect(script).toContain('node.custom_minimum_size = Vector2(100,');
    expect(script).toContain('node.custom_minimum_size = Vector2(node.custom_minimum_size.x, 50)');
  });

  it('customMinSize 生成完整 Vector2 覆盖', () => {
    const script = genUiSetLayoutScript('res://main.tscn', '/root/Root/Node',
      undefined, undefined, undefined,
      { x: 200, y: 100 }, // customMinSize
    );
    expect(script).toContain('node.custom_minimum_size = Vector2(200, 100)');
  });

  it('growDirection 映射成 grow_horizontal/grow_vertical', () => {
    // growDirection 经 dirMap 映射成 Control.GROW_DIRECTION_* 枚举，赋给 grow_horizontal/grow_vertical
    const script = genUiSetLayoutScript('res://main.tscn', '/root/Root/Node',
      undefined, undefined, undefined, undefined,
      'both',
    );
    expect(script).toContain('grow_horizontal');
    expect(script).toContain('grow_vertical');
    expect(script).toContain('Control.GROW_DIRECTION_BOTH');
  });

  it('全部 undefined 时不生成属性行（只有 header + load）', () => {
    const script = genUiSetLayoutScript('res://main.tscn', '/root/Root/Node');
    expect(script).toContain('_mcp_load_scene');
    expect(script).not.toContain('node.anchor_');
    expect(script).not.toContain('node.offset_');
  });
});

// ─── 批3 Task 3: $token 预取脚本生成器 ─────────────────────────────────────

describe('批3 Task 3: genTokenPrefetchScript', () => {
  it('含 load(themePath) + get_color_list + DesignTokens + token_map 输出键,无场景加载', () => {
    const script = genTokenPrefetchScript('res://themes/t.tres');
    expect(script).toContain('load("res://themes/t.tres")');
    expect(script).toContain('get_color_list');
    // 消费 DESIGN_TOKENS_TYPE 常量(扩名同步锚:生成产物必须出现 "DesignTokens" 字面量)
    expect(script).toContain(`get_color_list("${DESIGN_TOKENS_TYPE}")`);
    expect(script).toContain('_mcp_output("token_map"');
    expect(script).toContain('"colors"');
    expect(script).toContain('JSON.stringify');
    // 无场景加载:预取只 load 资源,不调用 _mcp_load_scene(header 定义仍在,断言调用形态)
    expect(script).not.toContain('if not _mcp_load_scene(');
  });

  it('null/非 Theme → theme_path load failed 错误分支(消息不含 "not found",不撞 mapper 首位)', () => {
    const script = genTokenPrefetchScript('res://themes/t.tres');
    expect(script).toContain('theme_path load failed: res://themes/t.tres');
    expect(script).toContain('_mcp_done()');
    // 错误消息子串与 NODE_NOT_FOUND 分支('not found')不相交——uiErrorMapper 分流前提
    expect('theme_path load failed').not.toContain('not found');
  });

  it('Color 先转 [r,g,b,a] 数组再入 dict(JSON roundtrip 通道,非裸 Color 对象)', () => {
    const script = genTokenPrefetchScript('res://themes/t.tres');
    // _colors[str(_name)] = [_c.r, _c.g, _c.b, _c.a] 形态:数组字面量四分量
    expect(script).toMatch(/_colors\[str\(_name\)\] = \[_c\.r, _c\.g, _c\.b, _c\.a\]/);
  });

  it('路径经 escapeForGdLiteral(反斜杠/引号安全)', () => {
    const script = genTokenPrefetchScript('res://a\\b"c.tres');
    // 反斜杠双写 + 引号转义后进入 load 字面量
    expect(script).toContain('load("res://a\\\\b\\"c.tres")');
  });

  it('DESIGN_TOKENS_TYPE === "DesignTokens" 同步锚(types.ts 常量与 GD 生成点共用)', () => {
    expect(DESIGN_TOKENS_TYPE).toBe('DesignTokens');
  });
});

// ─── 批3 Task 4: token_set/token_list 脚本生成器 ─────────────────────────────

describe('批3 Task 4: genTokenSetScript', () => {
  it('color 形态:set_color + Color( + DesignTokens + 原子落盘段(ResourceSaver.save/rename) + token_set 输出键', () => {
    const script = genTokenSetScript('res://themes/t.tres', 'brand', [0.5, 0.25, 0.75, 1]);
    expect(script).toContain('load("res://themes/t.tres")');
    expect(script).toContain('set_color("brand"');
    expect(script).toContain(`"${DESIGN_TOKENS_TYPE}"`);
    expect(script).toContain('Color(0.5, 0.25, 0.75, 1)');
    // 原子落盘段(复制 ui-theme.ts save case 模式):make_dir_recursive → tmp → save → rename
    expect(script).toContain('DirAccess.make_dir_recursive_absolute');
    expect(script).toContain('ResourceSaver.save');
    expect(script).toContain('DirAccess.rename_absolute');
    expect(script).toContain('_mcp_output("token_set"');
    expect(script).toContain('_mcp_done()');
  });

  it('color 3 元组不带 alpha:Color(r, g, b) 形态(引擎 alpha 默认 1)', () => {
    const script = genTokenSetScript('res://themes/t.tres', 'ink', [0.1, 0.2, 0.3]);
    expect(script).toContain('set_color("ink"');
    expect(script).toContain('Color(0.1, 0.2, 0.3)');
    expect(script).not.toContain('set_constant');
  });

  it('number 形态:set_constant + 数值,无 set_color 值行', () => {
    const script = genTokenSetScript('res://themes/t.tres', 'space_1', 8);
    expect(script).toContain(`_theme.set_constant("space_1", "${DESIGN_TOKENS_TYPE}", 8)`);
    expect(script).not.toContain('set_color');
    // set 值行非 Color 值形态(header 的 _mcp_set_prop coerce 段自带 Color(,故断言 set 行前缀)
    expect(script).not.toMatch(/set_(color|constant)\("[^"]+", "[^"]+", Color\(/);
  });

  it('theme 缺失分支:theme file not found(含建主题指引文案)', () => {
    const script = genTokenSetScript('res://themes/t.tres', 'brand', 8);
    expect(script).toContain('theme file not found: res://themes/t.tres');
    // brief 逐字指引文案(错误分支与成功分支同款)
    expect(script).toContain('先 theme_create(scene_path+save_path) 或 ui_set_theme create+save 建主题');
    expect(script).toContain('_mcp_done()');
  });

  it('路径与 token 名经 escapeForGdLiteral(反斜杠/引号安全)', () => {
    const script = genTokenSetScript('res://a\\b"c.tres', 'brand', 1);
    expect(script).toContain('load("res://a\\\\b\\"c.tres")');
  });
});

describe('批3 Task 4: genTokenListScript', () => {
  it('含 load + get_color_list + get_constant_list + DesignTokens 双通道 + token_list 输出键', () => {
    const script = genTokenListScript('res://themes/t.tres');
    expect(script).toContain('load("res://themes/t.tres")');
    expect(script).toContain(`get_color_list("${DESIGN_TOKENS_TYPE}")`);
    expect(script).toContain(`get_constant_list("${DESIGN_TOKENS_TYPE}")`);
    expect(script).toContain('_mcp_output("token_list"');
    expect(script).toContain('"colors"');
    expect(script).toContain('"constants"');
    expect(script).toContain('JSON.stringify');
    expect(script).toContain('_mcp_done()');
  });

  it('Color 先转 [r,g,b,a] 数组(JSON roundtrip 通道,非裸 Color 对象)', () => {
    const script = genTokenListScript('res://themes/t.tres');
    expect(script).toMatch(/_colors\[str\(_name\)\] = \[_c\.r, _c\.g, _c\.b, _c\.a\]/);
  });

  it('constants 通道经 get_constant 数值直读', () => {
    const script = genTokenListScript('res://themes/t.tres');
    expect(script).toMatch(/_constants\[str\(_name\)\] = _theme\.get_constant\(_name, "DesignTokens"\)/);
  });

  it('theme 缺失分支:theme file not found(与 token_set 同款指引文案)', () => {
    const script = genTokenListScript('res://themes/t.tres');
    expect(script).toContain('theme file not found: res://themes/t.tres');
    expect(script).toContain('先 theme_create(scene_path+save_path) 或 ui_set_theme create+save 建主题');
  });
});

// ─── 反馈 2026-11-18:theme_create 的 scene_path 依赖按 action 分支 ─────────────

describe('genThemeCreateScript(scene_path 依赖按 action 分支,反馈 2026-11-18)', () => {
  it('create: scenePath 为 null 也生成,脚本不调用 _mcp_load_scene', () => {
    const s = genThemeCreateScript(null, 'create', undefined, 'res://ui/theme.tres');
    expect(s).toContain('Theme.new()');
    expect(s).not.toContain('if not _mcp_load_scene(');
  });
  it('extract: 仍加载场景', () => {
    const s = genThemeCreateScript('res://a.tscn', 'extract', '/root/Panel', 'res://ui/theme.tres');
    expect(s).toContain('if not _mcp_load_scene("res://a.tscn")');
  });
  it('extract: scenePath 为 null → 抛 scene_path is required for extract action(生成器层契约,与 source_node_path 守卫同构)', () => {
    expect(() => genThemeCreateScript(null, 'extract', '/root/Panel', 'res://ui/theme.tres')).toThrow('scene_path is required for extract action');
  });
});
