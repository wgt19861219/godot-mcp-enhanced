# A-01/A-03 审查修复设计

**日期**: 2026-05-30
**来源**: 两天全量审查报告 ADVISORY 发现
**状态**: 已批准

---

## A-01: mergeTscn format=3 兼容性

### 问题

`mergeTscn`（`scene.ts:952-1079`）对所有 ext_resource 和 sub_resource 的 ID 统一重编号为 `"1"`, `"2"`, `"3"...`。这在以下场景会破坏场景文件：

1. **sub_resource 字符串 UID 被覆盖**：Godot 4.x format=3 的 sub_resource 常用字符串 UID（如 `id="BoxShape3D_gds123"`），重编号会丢失原始 ID 格式
2. **load_steps 未更新**：合并后 header 的 `load_steps` 仍是 ours 的原始值
3. **format 版本未检测**：ours 和 theirs 的 format 不同时无警告

### 方案：保留原始 ID，仅碰撞时重映射

#### 算法

```
输入: ours 内容, theirs 内容

1. 解析 header：提取 format 版本、load_steps
   - 如果 ours.format ≠ theirs.format，在输出中附加警告注释

2. 解析 ext_resource / sub_resource / node（保持现有 parseExt/parseSub/parseNodes）

3. 合并去重（保持现有逻辑：按 path 去重 ext、按 type+body 去重 sub、按 name 去重 node）

4. ID 分配：
   a. 收集 ours 所有已使用 ID 到 usedIds: Set<string>
   b. 遍历 mergedExt（ours 在前，theirs 新增在后）：
      - ours 资源：保留原始 ID，不修改
      - theirs 资源：
        - 如果 originalId ∉ usedIds → 保留 originalId，加入 usedIds
        - 如果 originalId ∈ usedIds → 分配新 ID（保持类型一致），加入 usedIds
   c. mergedSub 同理

5. 新 ID 生成规则（碰撞时）：
   - 数字 ID（匹配 /^\d+$/）：取 max(usedIds 中所有数字) + 1
   - 字符串 UID：原ID + "_m" + 序号（如 "Box3D_abc_m1"）

6. 引用重映射（仅对被重分配了新 ID 的资源）：
   - 替换 ExtResource("oldId") → ExtResource("newId")
   - 替换 SubResource("oldId") → SubResource("newId")
   - 未重映射的 ID 保持不变

7. 更新 header：
   - load_steps = mergedExt.length + mergedSub.length + 1
   - format 保持 ours 的值
```

#### ID 碰撞示例

```
ours:   ext_resource id="1" path="a.gd"
        ext_resource id="2" path="b.gd"

theirs: ext_resource id="1" path="a.gd"    ← 去重跳过（path 相同）
        ext_resource id="2" path="c.gd"    ← ID "2" 已被 ours 使用
        ext_resource id="3" path="d.gd"    ← ID "3" 未被使用

结果:   ext_resource id="1" path="a.gd"    ← ours 保留
        ext_resource id="2" path="b.gd"    ← ours 保留
        ext_resource id="3" path="c.gd"    ← theirs id="2" 碰撞，分配新 ID "3"... 但 "3" 也被 theirs 占用
                                            实际：取 max(1,2)=2, +1=3, 检查 3 是否在 usedIds...
                                            最终分配 "4" → id="4" path="c.gd"
        ext_resource id="3" path="d.gd"    ← theirs 保留原始 ID "3"
```

#### 修正 load_steps

```typescript
// 合并后更新 header 中的 load_steps
const totalResources = mergedExt.length + mergedSub.length;
// load_steps = resources + 1 (Godot convention)
header = header.replace(/load_steps=\d+/, `load_steps=${totalResources + 1}`);
```

#### format 版本检测

```typescript
const formatOf = (content: string): number | null => {
  const m = content.match(/\[gd_scene\s+.*format=(\d+)/);
  return m ? parseInt(m[1]) : null;
};
const oursFmt = formatOf(ours);
const theirsFmt = formatOf(theirs);
// 如果不一致，在输出中加一行注释
if (oursFmt !== theirsFmt) {
  parts.push(`; WARNING: format mismatch — ours=${oursFmt} theirs=${theirsFmt}`);
}
```

### 受影响文件

| 文件 | 变更 |
|------|------|
| `src/tools/scene.ts` | `mergeTscn` 函数 ID 分配逻辑重写（约 40 行改动） |
| `test/tools/merge-scene.test.ts` | 更新重编号测试 + 新增碰撞场景测试（约 30 行新增） |

### 测试计划

1. **现有测试全部通过**（回归）：ID 保留行为应兼容现有无碰撞场景
2. **新增：ID 碰撞测试** — ours 和 theirs 同 ID 不同 path，验证新分配
3. **新增：字符串 UID 测试** — sub_resource 用字符串 UID，验证保留
4. **新增：load_steps 更新测试** — 验证合并后 header 的 load_steps 正确
5. **新增：format 不匹配警告测试** — 验证警告注释生成

---

## A-03: DSL parser 严格输入校验

### 问题

`parseE2eDsl`（`workflow.ts:594-629`）用正则提取参数后直接传给 `sendToBridge`，无校验。潜在风险：

1. 路径不含 `root/` 前缀 → Bridge 调用失败
2. 超长字符串 → Bridge 内存/网络开销
3. 控制字符 → 意外行为
4. 超大坐标/时间值 → 游戏卡顿或崩溃

### 方案：内联校验 + _error 返回

#### 校验规则

| 命令 | 参数 | 校验规则 |
|------|------|----------|
| `waitFor("path")` | path | 必须匹配 `/^root(\/[\w]+)+$/`；长度 ≤ 1024 |
| `click(x, y, "button")` | x, y | 范围 `[0, 10000]` |
| | button | ∈ `["left", "right", "middle"]` |
| `press("key")` | key | 匹配 `/^[\w ]+$/`；长度 ≤ 64 |
| `typeText("text")` | text | 不含 `\n`/`\r`/`\x00-\x1F`；长度 ≤ 512 |
| `waitMs(ms)` | ms | 范围 `[0, 60000]` |

#### 通用校验

所有字符串参数共享：
- 不含控制字符（`\x00-\x1F` 除去 `\t`）
- 长度 ≤ 1024

#### 错误返回

校验失败返回 `_error` 命令：

```typescript
{ method: '_error', params: { message: 'waitFor: path must start with "root/" and use alphanumeric segments — got "abc"' } }
```

`null` 保留给"不是 DSL 命令"的情况。`_error` 明确表示"是 DSL 但参数非法"。

#### 调用方适配

`dev_loop` 中 DSL 处理循环（`workflow.ts` 中 `parseE2eDsl` 调用点）需识别 `_error`：

```typescript
const cmd = parseE2eDsl(line);
if (!cmd) continue; // 非 DSL 行，跳过
if (cmd.method === '_error') {
  dslErrors.push(cmd.params.message);
  continue; // 记录错误，继续解析下一行
}
// ... 正常发送到 Bridge
```

最终 `dslErrors` 合并到 `dev_loop` 的返回结果中。

#### 实现结构

在 `parseE2eDsl` 函数内，每个命令的 `return` 前插入校验：

```typescript
// waitFor("path")
const waitMatch = trimmed.match(/^waitFor\(\s*"([^"]+)"\s*\)$/);
if (waitMatch) {
  const path = waitMatch[1];
  // 校验
  if (!/^root(\/[\w]+)+$/.test(path))
    return { method: '_error', params: { message: `waitFor: invalid path "${path}" — must be root/X/Y format` } };
  if (path.length > 1024)
    return { method: '_error', params: { message: `waitFor: path exceeds 1024 chars` } };
  return { method: 'wait_for_node', params: { path } };
}
```

### 受影响文件

| 文件 | 变更 |
|------|------|
| `src/tools/workflow.ts` | `parseE2eDsl` 添加校验（约 45 行新增） |
| `src/tools/workflow.ts` | DSL 处理循环添加 `_error` 识别（约 5 行） |
| `test/tools/e2e-dsl.test.ts` | 新增校验失败测试（约 40 行新增） |

### 测试计划

1. **现有测试全部通过**（回归）：合法输入不受影响
2. **新增：waitFor 路径校验** — `waitFor("abc")` 返回 `_error`
3. **新增：click 坐标越界** — `click(-1, 99999)` 返回 `_error`
4. **新增：press 键名校验** — `press("Key<script>")` 返回 `_error`
5. **新增：typeText 控制字符** — `typeText("hello\x00world")` 返回 `_error`
6. **新增：waitMs 越界** — `waitMs(999999)` 返回 `_error`
7. **新增：超长参数** — 各命令超长输入返回 `_error`

---

## 不做什么

- 不支持 format=2 输入（Godot 3.x 兼容性），超出最小修复范围
- 不重构 DSL parser 为独立模块，5 个命令保持内联
- 不修改 `tscn-parser.ts`（它的 `parseInt` 问题独立于此）
