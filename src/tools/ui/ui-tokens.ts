// ui-tokens:批3 Task 3 的 DesignTokens token 生成器(GD 脚本层)。
// 与 ui-theme.ts(ui_set_theme/theme_* 生成器)、ui-measure.ts(measure 生成器)分工一致:
// token 相关的 GD 脚本生成独立成文件,不与主题挂载/测量逻辑混居。
// 翻译器纯函数(prototype-import.ts 的 resolveGeometryTokens)保持零 Godot 依赖——
// 本文件是它唯一的数据来源侧(theme 资源 → token map 的 GD 预取通道)。

import { escapeForGdLiteral, SCENE_TREE_HEADER } from '../shared.js';
import { DESIGN_TOKENS_TYPE } from './types.js';

/**
 * 批3 Task 3:theme DesignTokens colors 预取脚本——无场景加载(只 load 资源,
 * 不碰 _mcp_load_scene),headless 单次 spawn(loadAutoloads=false,调用方约定)即出:
 * - `load(themePath)` → null/非 Theme → `_mcp_output("error", "theme_path load failed: <path>")`
 *   (消息不含 "not found",不撞 uiErrorMapper 首位 NODE_NOT_FOUND 分支;由
 *   `includes('load failed')` → THEME_NOT_FOUND 分流);
 * - `get_color_list(DESIGN_TOKENS_TYPE)` 遍历,**Color 先转 [r,g,b,a] 数组再入 dict**
 *   (裸 Color 经 str() 序列化会退化成 "Color(r, g, b, a)" 字符串,JSON roundtrip 后
 *   无法还原数值——数组是 TS 侧 TokenColorMap 的直接形状);
 * - `_mcp_output("token_map", JSON.stringify({"colors": _colors}))`。
 * theme 无 DesignTokens type(裸 Theme)→ get_color_list 返回空 → 空 dict →
 * TS 侧 resolve 走缺键路径 TOKEN_NOT_FOUND(诚实点名,不静默)。
 * 路径 escapeForGdLiteral(纯字符串字面量内插,同 genThemeMountInit 先例)。
 */
export function genTokenPrefetchScript(themePath: string): string {
  const tp = escapeForGdLiteral(themePath);
  return `${SCENE_TREE_HEADER}
func _initialize():
\tvar _theme = load("${tp}")
\tif _theme == null or not _theme is Theme:
\t\t_mcp_output("error", "theme_path load failed: ${tp}")
\t\t_mcp_done()
\t\treturn
\tvar _colors := {}
\tfor _name in _theme.get_color_list("${DESIGN_TOKENS_TYPE}"):
\t\tvar _c: Color = _theme.get_color(_name, "${DESIGN_TOKENS_TYPE}")
\t\t_colors[str(_name)] = [_c.r, _c.g, _c.b, _c.a]
\t_mcp_output("token_map", JSON.stringify({"colors": _colors}))
\t_mcp_done()
`;
}
