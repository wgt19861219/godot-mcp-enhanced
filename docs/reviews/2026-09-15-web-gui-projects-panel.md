# Web GUI 项目面板批次 — 最终全分支审查报告

- **日期**: 2026-09-15
- **分支**: `feat/web-gui-projects-panel`（11 commits，d2f1e489..e26668a5）
- **流程**: 竞品调研（Godot PM/Unity Hub/Epic）→ spec v1→v2.1（独立审阅 1B+6I+6M 全闭环 + 复核 12 PASS）→ plan（5 任务）→ Subagent-Driven（5 任务各配独立审查，Task 4 经 fix round 1）→ 最终全分支审查
- **总体判定**: **READY WITH FOLLOW-UPS**——零 Blocking，五维度（跨任务一致性/仓库约束/安全/并发/验收）全 PASS

## 一、交付内容

| 组件 | 内容 |
|------|------|
| `src/tools/runtime.ts` | `executeRunProject` 抽取（189 行纯移动，工具与面板双消费，行为零变） |
| `src/core/` 三导出 | `isAliveStatus`（process-state）/ `getAllowedRealRoots`（path-utils，后成死导出见 F-3）/ `getContext()`（ToolDispatcher 只读 getter） |
| `src/web-gui/projects-store.ts` | 清单持久化（0o600+原子写+icacls）+ BFS 扫描（限深 4/跳过 5 目录/5000 上限/不跟符号链接）+ 并发三规则（单飞互斥/串行队列/合并 re-read）+ 损坏重建 + 200 上限 manual 豁免 |
| `src/web-gui/server.ts` | 5 端点（GET projects / scan / add / remove / start）全态（403 白名单·readOnly/404/503/400）+ SSE `projects` 事件三形态 + hello 扩展 |
| `src/web-gui/html.ts` | 左列改造（上项目 55%/下会话 45%）：扫描/添加/搜索/Run/Edit/移除（事件委托）+ Missing 禁用红标 + 相对时间 + sessions 帧徽章联动 |
| `src/GodotServer.ts` | 生产接线：getContext 真实链路 + preview:true + **假成功双判防线**（isError \|\| 'Error:' 前缀）+ editProject 六行复刻 + isReadOnly 同源 |

## 二、任务执行与审查记录

| Task | Commit | Review |
|------|--------|--------|
| 1 抽取+三导出 | 343d2c26 | Approved（纯移动独立验证：去缩进零差异 + 两个指纹佐证） |
| 2 projects-store | 87b98d93 | Approved（re-read 时序推演正确；Task 1 移交坏根 catch-跳过落实） |
| 3 5 端点+SSE | 270b3a20 | Approved（start 防线顺序/0-tick 探针微任务序推演成立） |
| 4 前端 | ccb48f59 + 902b7a83 | Spec ❌→fix round 1→re-review 两项 ADDRESSED |
| 5 接线+验收 | 55ff49ad | Approved（双判修正确凿：6 失败路径 5 条无 isError） |

+ e26668a5（gitignore 补 .superpowers/，仓库卫生）。

## 三、验证证据（controller 实跑）

```
npm run lint → exit 0
npm run build → exit 0（7 个 .gd + instructions + game-templates 拷贝完整）
npm test → 443 files / 6549 tests passed | 83 skipped（Duration 64.97s）
真机验收 → OVERALL: ACCEPTANCE PASS（GET 200 / scan 发现 e2e-project(name=MCP E2E Test Fixture) / add 白名单外 403 / start 200+running+stop 收尾）
```

## 四、Follow-up 清单（merge 后）

1. **F-1（优先）**：扫描失败兜底事件 `{scanning:false}` 无失败标记 → 前端误显"扫描完成"（server.ts:317 + html.ts:430，约 5 行：兜底事件加 `failed:true` + 前端识别 + 2 断言）
2. **F-2**：§8 人工项真机补验（Edit 编辑器弹窗 / readOnly 真机 403 至少两项；missing 红标/移除确认/并发已有逻辑层自动化覆盖）
3. **F-3**：`getAllowedRealRoots` 死导出回收（消费方已内联容错版 resolveScanRoots）
4. **F-4**：满员归一接缝（端点把未来无 reason 失败形态误报 full）
5. **F-5**：re-read 用例契约注释补强 / 前端键 toLowerCase 未 resolve 归一化（自愈面）
6. **F-6**：恒真断言 ×2 清理 / busy 空消息极端竞态（既有行为备注）

## 五、Rulings（controller 裁决清单）

1. **isError-only → 双判**：Task 3 裁决 runProject 检查 isError→throw；Task 5 实施者实测 6 失败路径仅 1 条 isError，修正为 `isError || 'Error:' 前缀`——controller 确认修正确凿（误伤面 0：成功前缀全列核对）。若错：成功消息被误判为失败（当前证据排除）。
2. **坏根 catch-跳过位置**：Task 1 移交项裁决"Task 2 消费侧 catch"——落实为 resolveScanRoots 内联（getAllowedRealRoots 成死导出，F-3 回收）。若错：多一层无害导出。
3. **Task 2 简报矛盾消解**：getAllowedRealRoots 数组级 map 与"逐条容错"矛盾——实施者以同链+catch 消解，审查认可。若错：扫描容错语义漂移（已测试锁定）。
4. **跨进程 last-writer-wins**（spec 级）：清单为可再生缓存型数据，锁文件不值得。若错：多 server 同时操作面板时清单条目丢失，重扫描即恢复。

## 六、值得进 memory 的教训（已登记）

1. 防线判据必须先枚举全部失败路径的实际返回形态再定（isError-only 裁决差点漏 5/6 路径）
2. 为下游预导出的 core 小函数，消费方语义变更时应回收（死导出实例）
3. 跨任务 SSE 契约的失败分支是接缝盲区——兜底事件与在场性消费各自正确、组合误导，失败形态应进 payload 约定

## 七、结论

批次历经调研对标 → spec 两轮审阅闭环 → 5 任务 TDD（Task 4 经修复环）→ 最终五维度审查，**READY WITH FOLLOW-UPS**。分支合并与 npm 发版待用户指令；F-1 建议 merge 后第一个小补丁。
