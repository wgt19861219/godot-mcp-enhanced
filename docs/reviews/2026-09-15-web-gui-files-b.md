# Web GUI 资源管理 Plan B 最终审查报告(2026-09-15)

> 审查对象:分支 feat/web-gui-files-b(52d61cdb..d70dcbea,7 commits)
> 审查链:2 任务各配独立 reviewer + fix rounds(2+2,含一次 NOT ADDRESSED 打回)+ 全分支终审(孤立视角,断言实跑)+ 终审 fix wave + scoped 复审 3/3 ADDRESSED
> spec:docs/superpowers/specs/2026-09-15-web-gui-files-design.md §6.4/§8-4/§9-Plan B

## 总判定:READY(终审 fix wave 后无遗留 Blocking/Important)

五维度全 PASS;真机验收 13/13 + Playwright UI 抽查 PASS;controller 终验门禁 447 文件/6608 tests 全绿(本轮零 flaky)。

## 交付物

- **图片预览**:img 标签(raw URL 拼 JS 变量 token)/onerror 占位/onload 显示 naturalWidth×naturalHeight 尺寸
- **音频预览**:audio controls 同 raw 通道/onerror 占位
- **hex 视图**:三列网格(偏移 8 位 hex/16 字节两位 hex/ASCII 32-126 否则点号)/4KB 截断提示+下载链接/401 哨兵文案
- **顺手收**:M-3 目录路径 bad_request(消裸 EISDIR 500)/M-7 CM 注释勘误/Mi-1 adir.gd 真实覆盖 isDirectory 行

## 任务执行表

| 任务 | commit | 审查 | fix rounds |
|---|---|---|---|
| T1 图片/音频预览+M-3/M-7 | cd73b947 | SHIPPED WITH ONE FIX | r1: audio 断言注释桥接→锁真码(352d9762) |
| T2 hex 视图+真机验收 | 1991bd7f | SHIPPED WITH NITS | r1: 401 裸 return **NOT ADDRESSED**(14e8eeae)→r2: 哨兵对象+控制流实跑自证 4/4(5b0e66b1) |
| 终审 fix wave | d70dcbea | 3/3 ADDRESSED | CHANGELOG/audio onerror/img 尺寸 |

## Rulings(controller 裁决记录)

1. **hex 路由 rel 契约**(T2 审查):brief 写 `openPreview(name,'hex')` 但 hex 端点 path 契约相对项目根(子目录下传 name 必 404)——实现取 rel 是 brief 内部矛盾的唯二正确消解(img/audio 分支同构)。
2. **audio 断言桥接不可接受**(T1 审查):注释提供绿灯=断言测到注释而非行为;裁决"实现守纪律、断言锁真码"(au.controls = true)而非"断言守字面、注释来凑"。
3. **401 修法选哨兵对象**(T2 fix r2):复审给的修法 A——裸 return 的 undefined 穿透第二层 then 必抛 TypeError,返回哨兵让控制流落既有 !r.ok 三元文案(一字不动)。
4. **CHANGELOG 语义补登**(终审 I-1):机械门禁过≠语义覆盖——Plan B 用户可感知功能需独立条目。

## Deferred(带走项)

| 项 | 一句话 |
|---|---|
| 哨兵断言天花板 | 静态断言无法区分哨兵/裸 return 版;同构自证脚本一次性;可选加固=acceptance 补真机 401 步骤 |
| registry 历史残留 | ~60 pid 文件+projects.json 残条(Windows 强杀系统性);建议独立批做 server 启动清扫 |
| img 尺寸视觉确认 | naturalWidth 断言锁行为码,实际渲染待人工浏览 |
| Playwright 快照留存 | hex/audio UI 态无快照物证(evaluate 不落快照);流程改进:关键 UI 态补 take_snapshot |
| M-5/M-6(Plan A 遗留) | 备份编码注释措辞/..gd 边缘分歧,纯措辞与极罕见边界 |

## 工程教训(已登 memory)

1. **vitest 静态字符串断言不执行 promise 控制流**——同一 401 修复两次踩中(round 1 注释桥接假绿+裸 return 在 22 passed 全绿下仍是 undefined 穿透)。有效模式=断言锁行为码(避开注释可出现的字面量)+与落盘代码逐行同构的 promise 链实跑自证(含缺陷版对照复现)。
2. **server 鉴权层 401/403 是空响应体**(writeHead().end() 无 body)——前端任何 r.json() 消费前必须先判 r.ok/状态码,否则 parse('') 必 reject 落 catch 覆盖专门文案;对所有 fetch JSON 消费的通用约束。
