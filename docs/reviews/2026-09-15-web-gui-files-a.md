# Web GUI 资源管理 Plan A 最终审查报告(2026-09-15)

> 审查对象:分支 feat/web-gui-files-a(107eb83c..79c1303a,13 commits)
> 审查链:6 任务各配独立 reviewer(双裁决 Spec+质量)+ 2 个 fix round + 全分支终审(孤立视角,断言实测)+ 终审 fix wave + scoped 复审
> spec:docs/superpowers/specs/2026-09-15-web-gui-files-design.md(v2,设计期独立审阅 1B+7I+8M 已闭环)

## 总判定:READY(终审 fix wave 后无遗留 Blocking/Important)

五维度全 PASS;终审抓 2 Important+1 spec 注释漏落,fix wave(79c1303a)3/3 ADDRESSED 复审确认。

## 交付物

- **文件浏览**:项目行「文件」按钮 → 中列日志|文件 tab → 目录逐层导航(面包屑回跳/目录先字母序/.godot+.git 隐藏/fmtSize)
- **CodeMirror 编辑**:同源资产端点(/assets/* 枚举 6 文件,npm codemirror@5 构建期拷贝);gd→python 近似/json/md 高亮;动态一次加载(src 拼 JS 变量 token)
- **三重护栏保存**:readOnly 门(POST 403+前端只读横幅)→ mtime 乐观锁(409+latest 前端冲突条:重新加载/复制我的修改)→ 集中备份(~/.godot-mcp/web-gui/backups/,percent-encode,目录 0o700/文件 0o600)→ 原子写
- **端点与防线**(Plan B 消费):raw(hex 前 4KB 流式采样不占内存)响应头防线(CSP default-src 'none'+nosniff,堵 svg 直接导航 XSS);POST body content-length 600KB 预检;audit log 全分支

## 任务执行表

| 任务 | commit | 审查 | fix rounds |
|---|---|---|---|
| T1 files-api(安全链+三护栏) | bd571061 | Spec ✅+Approved | — |
| T2 server 端点+CSP+assets | ddc37e24 | 10/11 ✅+Approved | round1: readOnly 门(80d684f0,plan 缝隙) |
| T3 CM 构建链 | 88289630 | 10/10 ✅+Approved | — |
| T4 文件 tab+列表 | 2fa04a42 | 14/14 ✅+Approved | — |
| T5 编辑视图 | ee7b591a | 13/13 ✅+Approved | — |
| T6 接线+wiring+真机验收 | dee5d2be+c353cc6a | SHIPPED WITH ISSUES | round1: showConflict 漏修(a0ee181f) |
| 终审 fix wave | 79c1303a | 3/3 ADDRESSED | — |

## 验证证据

- 全量门禁:lint 0 错误/build ok(含 CM 6 文件拷贝)/**npm test 447 文件 6601 passed**(fixer 轮+controller 复验轮两轮全绿;中间一轮 2 failed 为已知 flaky 簇——registry EEXIST mkdir occupier.txt 竞态 WARN,失败文件名未捕获,与 files 改动无关)
- 真机验收 5/5 PASS(spec §8 1/2/3/5):浏览隐藏过滤/编辑保存落盘+percent-encode 备份旧内容/外部改写→409+latest 正确/READ_ONLY POST 403+GET 放行+磁盘未写/Playwright 实测 .CodeMirror DOM+首行内容
- CHANGELOG [Unreleased] 覆盖(check-changelog-sync STRICT 过);版本未 bump(默认不发版)

## Rulings(controller 裁决记录)

1. **dotfile 扩展矛盾**(pre-flight):node extname('.gdignore')='' 与 TEXT_EXTS 含 gdignore 矛盾——ext() 兜底 dotfile 整名去点;若错代价=gdignore 类误拒,T1 测试红即暴露
2. **readOnly 门 plan 缝隙划回 T2**(审查发现):spec §3.3-1 硬规则无任务落位——归 server 端点任务补丁而非 Task 6;若错代价=Task 6 验收返工
3. **readHex 流式改造落 T2**(T1 审查 Important):readFile 全量读入后才截 4KB 冲击同进程内存——open+read 前 4KB;接口不变
4. **备份编码以测试/spec 锁定**(T1 实施偏离):brief 实现含 /→%2F 但测试与 spec §3.3-3 只要求 \+:——实现对齐测试(Linux CI 必红路径)
5. **readOnly 下 GET text 放行**(T5 ⚠️ 项 controller 核实):readOnly 门在 POST 分支内,GET 放行=只读查看合理,前端 403 误导路径不存在

## Deferred(带走项,Plan B/后续批处理)

| 项 | 位置 | 一句话 |
|---|---|---|
| M-3 目录路径 EISDIR→500 | files-api.ts readText/readRaw/readHex | stat 后补 isDirectory→bad_request |
| M-5 备份编码注释措辞 | files-api.ts:126 | 「无碰撞」过强(编码集未含 %);或收紧 %25 |
| M-6 前后端 ..gd 边缘分歧 | html.ts fileExt | 多级点开头名字前后端判定不一,极罕见 |
| M-7 CM6 注释措辞 | copy-codemirror.mjs:1 | 「CodeMirror 6 文件」易误读为 CM6 |
| wiring mock 返回形状微漂移 | wiring-files.test.ts | {ok,mtime} vs 真实 {mtime},未被断言消费 |
| readJsonBody chunked 绕过 413 | server.ts(既有) | 无 content-length 时 body 无界;纵深后置 |
| conflict latestContent 无上限 | files-api.ts:115 | 外部改超大后 409 携带超大内容 |
| cm-build UMD 断言弱 | cm-build.test.ts:18 | toContain('CodeMirror');可强化 defineMode |
| flaky 簇 registry EEXIST | 全量测试间歇 | 失败文件名未捕获;排查 --reporter=json 落盘 |

## 工程教训(已登 memory)

1. vi.mock 手写 mock 形状必须从真实类锁定(wiring save vs saveText 自洽绿灯实证)——mock 断言自己=零保护
2. spec 硬规则成对权限常量逐项核对"两半"(目录 0o700+文件 0o600,只落一半);"对齐惯例"类要求 grep 先例逐参数比对
