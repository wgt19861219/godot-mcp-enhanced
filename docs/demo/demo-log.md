# godot-mcp-enhanced 演示日志

> 测试日期：2026-04-29
> 测试项目：CardGame（Godot 4.5.1, GL Compatibility, 960x640）
> MCP 版本：godot-mcp-enhanced v0.3.0

---

## 1. 基础工具

### get_godot_version

```
4.5.1.stable.official.f62fdbde1
```

### get_project_info

| 属性 | 值 |
|------|-----|
| 项目名 | CardGame |
| 主场景 | res://scenes/main_menu/login_scene.tscn |
| 渲染器 | GL Compatibility |
| 分辨率 | 960x640 |
| GDScript 文件 | 206 个 |
| 场景文件 | 98 个 |
| JSON 配置表 | 202 个 |
| PNG 资源 | 7,190 个 |
| Autoload 单例 | 6 个 |

### list_files

对 CardGame 项目（18,000+ 文件）返回完整结果，支持按扩展名和子目录过滤。

---

## 2. 场景/脚本读取 — 闭环基础

### read_scene（main_scene.tscn）

```
外部资源：21 个（脚本7、纹理13、主题1）
节点总数：33 个
根节点：MainScene [Control]
```

### read_scene（login_scene.tscn）

```
外部资源：1 个（login_scene.gd）
节点总数：6 个
根节点：LoginScene [Control]
  - Background [ColorRect]
  - TitleLabel [Label] — "CardGame"
  - HintLabel [Label] — "点击屏幕进入游戏"
  - TouchArea [ColorRect]
  - LoadBar [ProgressBar]
```

---

## 3. 动态 GDScript 执行 — 核心亮点

### execute_gdscript — 数据表统计

输入代码查询 7 个配置表记录数：

| 表名 | 记录数 |
|------|--------|
| Unit | 101 |
| HeroStars | 5 |
| Skill | 434 |
| Stage | 535 |
| Shop | 7 |
| Buff | 278 |
| Item | NOT FOUND |
| Equip | 722 |
| **合计** | **2,082** |

执行耗时：563ms。返回结构化字段：success、compile_success、errors、outputs（键值对）。

### execute_gdscript — 结构化错误分析

故意使用混合缩进触发错误，MCP 返回：

```json
{
  "type": "parse_error",
  "message": "Mixed use of tabs and spaces for indentation.",
  "file": "godot-mcp-exec-8dl0qmrk.gd:15",
  "suggestion": "Syntax error: Mixed use of tabs and spaces..."
}
```

错误对象包含 type、file、line、message、suggestion。

---

## 4. 运行时场景树查询

### query_scene_tree（login_scene.tscn, max_depth=3）

实际实例化场景返回运行时属性值：

- LoginScene [Control] — 脚本已加载
  - Background [ColorRect] — 全屏背景色 (0.1, 0.1, 0.15, 1.0)
  - TitleLabel [Label] — "CardGame"，位置 (330,200)-(630,260)
  - HintLabel [Label] — "点击屏幕进入游戏"
  - TouchArea [ColorRect] — 透明全屏触摸区
  - LoadBar [ProgressBar] — visible=false

---

## 5. run_and_verify — 一键验证

```
场景：login_scene.tscn | 超时：15s
错误：0 | 警告：2（正常加载信息） | 打印：9 行
自动超时（正常：交互式项目不会自动退出）
```

---

## 6. 截图

4 张截图保存在 docs/demo/：

| 文件 | 场景 | 大小 |
|------|------|------|
| screenshot_login.png | 登录场景 | 63 KB |
| screenshot_main.png | 主界面 | 2.9 MB |
| screenshot_tavern.png | 酒馆场景 | 2.1 MB |
| screenshot_hero_list.png | 英雄列表 | 3.4 MB |

Windows 平台使用窗口模式截图。

---

## 7. validate_project — 项目验证

扫描发现 15 个问题（均在 tools/migration 临时目录）：

```
缺失资源（15 个 error）
  tools/migration/output/debuglogin.tscn → 2 个
  tools/migration/output/logo.tscn → 6 个
  tools/migration/output/newbie.tscn → 1 个
  tools/migration/output/selectserverwin.tscn → 2 个
  tools/migration/output/serverlogin.tscn → 2 个
  tools/migration/output/tavern.tscn → 1 个
```

---

## 闭环工作流

```
read_scene → 理解场景结构
read_script → 读取源码
execute_gdscript → 查询数据（2082 条记录）
query_scene_tree → 运行时属性验证
run_and_verify → 一键运行 + 错误分析
capture_screenshot → 可视化验证
validate_project → 静态资源检查
```

AI 可通过此工具链完成理解→编写→运行→验证→修复的完整闭环。
