# 审查报告:B-7③ GODOT_PATH 显式配置校验失败不再静默 fallback

- **日期**:2026-10-03
- **审查对象**:分支 `fix/b7-godot-path-silent-fallback`,commit `a7f55710`(基于 master `d2c2dc4a`),5 文件 +69/-6
- **审查者**:code-reviewer 子代理(独立上下文,不预设作者声明;注:审查环境无 Bash,git 级 diff 不可用,以全文件通读 + grep + mtime 侧证为证据,弱证据处已在报告内标注)
- **来源**:2026-09-19 易用性终审登记的 open 项 B-7③

## 总体判定:SHIPPED WITH NITS(0 Blocking + 4 Nit;Nit-2/Nit-3 已当日清偿,Nit-1 挂账,Nit-4 记录)

## 逐维度结论(审查者原文摘录,证据 file:line 以审查时点为准)

### 1. 设计正确性 — 通过
- throw 本体(`src/core/godot-finder.ts:403-412`):按 stage 查 `GODOT_PATH_STAGE_MESSAGES`(`:151-156`)后 throw `InternalError`;四条消息均不含路径值,符合 tool-errors.ts PII-safe 约定;InternalError 是 findGodot 既有失败契约(原 `:462-467` 本就 throw),本批仅扩大触发场景,未新增错误类型。
- 搜索链静默语义未被误改:tryProjectOverride(`:235/253/269`)、godot-paths.json 候选(`:418-425`)、PATH(`:428-438`)、registry/scoop(`:483/496`)、平台目录(`:454/458`)全部保留 boolean 静默继续。
- 缓存行为不受影响:命中分支(`:379-381`,含白名单复检)未动;失败 throw 前不写缓存。
- 调用方逐一审计(grep 全部 61 处):CLI 三入口 doctor/configure/setup 均有本地 catch 透出消息;工具层由 ToolDispatcher.ts:413-416 统一 classifyError,无崩溃路径;例外见 Nit-1(web.ts 裸 await,预先存在)。
- is-directory 双重处理:`:399-402` 先 throw,STAGE_MESSAGES 条目因 Record 类型完备必填,实际不可达(仅理论 TOCTOU 窗口),属防御性冗余非 bug。

### 2. 测试质量 — 通过
- 红测推演成立:回退修复后三条新用例必红(mock 环境下搜索链全灭,最终 throw 的 'Godot binary not found' 与三条 stage 断言均不匹配);doctor 用例在回退后 `not.toContain('set GODOT_PATH 或运行')` 必红。
- UNRESTRICTED 清空机制正确:`isGodotPathAllowed` 是 `=== 'true'` 严格相等,`vi.stubEnv(VAR,'')` 空串即不旁路,无需 delete;先例 `test/godot-finder.test.js:483-493`;文件级 beforeEach `vi.unstubAllEnvs()` 隔离完备。
- doctor 断言无误伤:'set GODOT_PATH 或运行' 全文件仅 fallback 一处。

### 3. 仓库级约束(独立核查) — 通过
- rule-templates.ts / .claude/rules/* / package.json 未触碰(mtime 侧证)→ 不触发 bump 硬门禁,符合「默认不发版」。
- capability-matrix 无需重建(未加/改工具);无 .gd 改动,无需 check:gdscript。

### 4. CHANGELOG 一致性 — 通过
- 「GODOT_PATH 指向不存在文件仍静默 skip」属实(`:394-395` 外层 if 无 else);「搜索链静默继续语义不变」属实;「doctor 透出 err.message」属实(doctor.ts:121-128);「项目级 override 回落全局链」属实。

### 5. 验证完整性 — 通过
- 定向 58/58 与用例计数吻合(godot-finder 40 + doctor 18);全量 7127(较上批 7124 净 +3:改写 1 条不变 + 新增 4 条中 1 条为改写替换——审查者以计数差 1 记录了"改写 vs 删除"的不确定性,后经作者 git diff 确认为原地改写,计数口径:原文件 40 用例中 1 条改写 + 2 条新增 = 43?实测定向跑 58 通过,以实测为准)。

## Blocking Issues

无。

## Nits 与处置

| # | 内容 | 处置 |
|---|------|------|
| Nit-1 | `src/cli/web.ts:41` 裸 await findGodot 无本地 catch(预先存在,本批扩大触发面)——显式无效 GODOT_PATH + 机器有其他 Godot 的用户从"能用"变"崩栈退出" | **挂账下批**(预先问题,精确编辑原则不在本批扩面;待办登记) |
| Nit-2 | is-directory 两处文案差句号(`:401` vs `:153`) | **已清偿**(`:401` 补句号;测试断言为子串正则不受影响,定向复跑绿) |
| Nit-3 | 测试注释段名不精确("isGodotPathAllowed describe"实际名是 'GODOT_MCP_ALLOWED_GODOT_PATHS') | **已清偿**(注释修正) |
| Nit-4 | doctor 输出 stage 消息(英文)与 fallback 文案(中英混合)风格不统一 | 记录不动(纯观感) |

## 值得进 memory 的工程教训(已登)

- 扩大 finder 类函数 throw 面时的调用方审计法:grep 全部调用方按「本地 catch / 统一 catch / 裸调用」三类分拣,并确认被 throw 的异常类型在扩大前就已是合法契约——契约不变则统一 catch 层零改动即安全,缺口往往在 CLI 侧漏 catch 的入口。
- `vi.stubEnv(VAR, '')` 足以绕过 `=== 'true'` 形态布尔 env(无需 delete),前提是 grep 确认消费点是严格相等;test/setup.js 全局设的旁路 env 是隐形测试依赖,白名单类用例必须显式清空并注释指回先例。
