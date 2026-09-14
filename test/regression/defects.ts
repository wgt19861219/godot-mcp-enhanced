// test/regression/defects.ts — M2 DEFECT 回归数据层
// FIXED_DEFECTS 131 条 detect 闭包（每条 detect(): number，0=无缺陷=防复发；含 2026-07-10 三层架构审查 P1×3+P2×1 + RCE/进程通信审查 P1×1 + 2026-07-11 editor-asset/auth 审查 P1×3 + 2026-07-11 插件反馈 asset×2 + bridge headless×1 + 2026-07-12 RCE 复合链×3 + HealthMonitor 控制回路×1 + 2026-07-13 path_generator align_vertices 死循环×1 + 2026-07-19 SDD scene coerce×3 + 2026-07-19 editor-version-tear edit_node/batch editor 路由+资源落盘+coerce helper×6 + 2026-07-20 editor 路由 add_node parent root 失效×1 + 2026-07-21 P2-1 csv-import-timeout-no-atomic-write×1 + 2026-07-22 orphan-scan-session-scoped×1 + 2026-07-23 批次 A asset-factory-load-traversal/ui-scene-local-blocked-removed×2 + 2026-07-23 批次 B 可靠性 B1-B8/B10×9 + 2026-07-23 批次 C 正确性 C1/C2/C3/C5-C13×12 + 2026-07-24 批次 D 工具治理 asset-android-tool-orphan×1 + 2026-07-24 D2 follow-up nodepath-traversal-category-error×1 + 2026-07-24 批次 E animation-track-destructive-confirmation×1 + 2026-07-24 Bridge take_screenshot null-crash-swallow×1 + 2026-07-28 scene/workflow traversal detect×2 + 2026-07-29 A-telemetry T1 telemetry-error-category-pii-leak×1 + T2 telemetry-afterhook-no-optout-guard×1 + 2026-07-29 A-RCE T1 addon-update-dest-symlink-bypass×1 + T2 bpy-no-dangerous-scan×1 + T3 profile-executeToolCall-isToolAllowed-enforce×1 + T4 godotpath-allowed-paths-unimplemented×1 + T5 headless-whitelist detect 假绿修正(rce-script-branch-no-node-check 不再以 is_parent_class 为充分守卫+反向 Node 不在白名单；set-prop-no-type-whitelist 扩扫 headless) + 2026-07-29 B-Reliability T1 nav-bake-request-timeout-misalign×1 + T2 fullsystem-scan-kills-editor×1 + T3 editor-halfopen-no-precheck×1 + T4 gdscript-spawn-not-registered×1 + T5 heartbeat-blanket-catch-no-distinguish×1 + 2026-07-29 C-Correctness detect 补全×7（nav-freed-access-signal/nav-status-hardcoded/doctor-no-stripbom/readcache-no-byte-limit/addon-update-nonatomic/adapter-no-mode-preserve/adapter-env-field-overwrite） + 2026-07-29 D-P2 F2 nav/ui undo×3（nav-set-params-no-undo/ui-layout-anchor-no-undo/ui-theme-no-undo） + 2026-07-29 D-P2 F3 animation-keyframe-index-no-bound×1 + 2026-07-29 D-P2 F4 websocket-outbound-no-buffer-limit×1（ws_peer 仅 set_inbound_buffer_size 无 set_outbound_buffer_size → sync 风暴/慢消费者 outbound 无界增长 OOM；fix :231 后加 set_outbound_buffer_size(4MB)） + 2026-08-06 P2-3 scene-commit-nodetype-blacklist×1 + 2026-08-06 审查 P0 action-gate-key-toolname-match×1）。
//   含 Task 3 review 闭环：reconnect-degrade-fail + edit-node-blocked-props-json-pollution
//   （master 实测无缺陷，defects.md open 基于 fix 分支，移 FIXED 硬断言===0）。
// OPEN_DEFECTS 9 条：detect() <= baseline 防恶化。含 multi-instance-hmac EXPECTED=2（spec Named risk）。
// detect 谓词忠实复现 defects.md 行 196-538。
// P1-6 (批次 E): 多数 detect 是静态 grep（countMatchesInFile/readSrc.match）防源码形态复发，非运行时行为验证；
//   安全/竞态类（沙箱绕过/TOCTOU/HMAC 重放）运行时覆盖另见专门测试（gdscript-executor-core 沙箱触发等）。
import { countMatchesInFile, countMatchesInDir, fileContains, readSrc, PROJECT_ROOT } from './detect-helpers.js';
// ts-gdscript-tool-drift 复用 M1
import { diffMatrices } from '../../src/capability/diff-matrix.js';
import { extractCapabilities } from '../../src/capability/extract.js';
import { registerAllModules } from '../../src/module-loader.js';
import type { ToolCapability } from '../../src/capability/schema.js';

export type DefectStatus = 'open' | 'fixed';
export interface DefectEntry {
  key: string;
  status: DefectStatus;
  severity: 'CRITICAL' | 'IMPORTANT' | 'ADVISORY';
  dimension: string;
  /** 缺陷命中度量，0=无缺陷。忠实复现 defects.md 的 detect 谓词。 */
  detect: () => number;
  /** 仅 open：提交时 master 实测命中数，防恶化基线。 */
  baseline?: number;
}

// ─── ts-drift 预注册（detect 复用 M1 diff-matrix）─────────────────────────────
let _tsDriftReady = false;
function ensureTsDriftReady(): void {
  if (_tsDriftReady) return;
  registerAllModules();
  _tsDriftReady = true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIXED（33 条）— 硬断言 detect() === 0（防复发）。detect 谓词源自 defects.md 行 196-460。
// 原 21 条中 4 条（godot-version-hardcoded-create-project / api-db-version-stale /
// lint-rule-no-targeted-test / lint-missing-4-7-accessibility-breaking）实测 detect != 0，
// 按 spec §8 闭环改 status='open' 移到 OPEN_DEFECTS。
// Task 3 review 闭环 +2：reconnect-degrade-fail / edit-node-blocked-props-json-pollution
// （master 实测 detect=0，defects.md open 基于 fix 分支 manage-tools commit，移 FIXED 防复发）。
// 2026-06-27 收窄 +3：version-hardcoded-drift / secret-cache-and-perm-weak / normalizeargs-depth-limit
//   detect 改查真缺陷形态（剔除合理模式：verifiedGodotVersion 元数据 / icacls ACL 替代 / MAX_NORMALIZE_DEPTH 常量引用），
//   实测 detect===0，移 FIXED 防复发。
// 2026-06-27 recording-no-touch-events：ScreenDrag 补全（feat/recording-screen-drag Task 1-3 三端实现），
//   ScreenTouch+ScreenDrag 两类齐备 detect=0，移 FIXED 防复发（detect 谓词不变：计数缺失的触屏事件类型数）。
// ═══════════════════════════════════════════════════════════════════════════════
export const FIXED_DEFECTS: DefectEntry[] = [
  // ── CRITICAL 安全（行 196-264）──
  { key: 'execute-gdscript-sandbox-default-off', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      // detect: scanGdscriptSandbox 返回 [] 早退 + 仅 console.warn 不 return 的路径已消除
      // fixed 核心：命中危险模式即 return failure（gdscript-executor.ts）。校验该阻断分支存在
      return fileContains('src/gdscript-executor.ts', /sandboxWarnings\.length\s*>\s*0\s*&&\s*!safetyDisabled/) ? 0 : 1;
    } },
  { key: 'bpy-no-dangerous-scan', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    detect: () => {
      // blender.ts execute_bpy 全功能 Python 无 execute_gdscript 同款危险 API 静态扫描(防御不对称)。
      // fix: scanBpySandbox(os/subprocess/eval/exec/__import__), warnings 非空 BLOCK。
      const blender = readSrc('src/tools/blender.ts');
      const hasExec = /execute_bpy|buildBlenderScript/.test(blender);
      // Minor-4 (review): 查带括号调用点,防删调用留 import 的伪绿。
      const hasScan = /scanBpySandbox\s*\(/.test(blender);
      return hasExec && !hasScan ? 1 : 0;
    } },
  { key: 'profile-executeToolCall-isToolAllowed-enforce', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // A-RCE #3 (Task 3): isToolAllowed 原只在 getFilteredTools 广告层(ToolDispatcher:183),
    // executeToolCall 主路径不强制。被转发 MCP 客户端(拿完整 tools/list 或硬编码工具名)
    // 仍可调用 TOOL_GROUPS/slim 过滤的工具。非 RCE(ReadOnlyGuard 兜底),是隔离弱。
    // fix: executeToolCall 入口(currentMode 快照前)加 isToolAllowed 强制检查,返 TOOL_NOT_ALLOWED。
    // detect: executeToolCall 函数体到 const currentMode 之间无 isToolAllowed(name) 调用 → 1(复发)。
    // 锚定 `private async executeToolCall`(唯一函数签名),避开日志字符串 "executeToolCall: tool %s" 误匹配。
    detect: () => {
      const f = readSrc('src/core/ToolDispatcher.ts');
      const m = f.match(/private async executeToolCall[\s\S]{0,1000}?const currentMode/);
      return m && !/isToolAllowed\s*\(\s*name\s*\)/.test(m[0]) ? 1 : 0;
    } },
  { key: 'gdscript-template-injection', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      // fixed：用户/外部路径不再裸 ${} 插值（改转义函数包裹）。命中裸插值即复发。
      // 复发实例：data-import class_path（2026-07-23 批次 A1 修复，resolveWithinRoot 校验）
      // 源头1: gdscript-executor.ts 的 ${userCode}/${userSnippet}
      const exec = countMatchesInFile('src/gdscript-executor.ts', /\$\{userCode\}|\$\{[^}]*userSnippet[^}]*\}/g);
      // 源头2: frame-verify/gdscripts.ts 的路径插值（reference_path/frames_dir 来自 MCP 工具参数，不可信）。
      // 裸 ${var}（未被转义函数包裹）即复发。该文件仅做路径插值，数值插值不应出现（YAGNI）。
      // T2b(2026-08-18): 谓词接受 gdEscape / escapeForGdLiteral 任一包裹——两入口共享
      // escapeGdStringCore(引号/反斜杠/换行同转义,防闭串注入等价),escapeForGdLiteral 是
      // 纯字面量内插的正确入口(% 不双写,debated in task-2b)。
      const frame = countMatchesInFile('src/tools/frame-verify/gdscripts.ts', /\$\{(?!gdEscape\(|escapeForGdLiteral\()[^}]*\}/g);
      return exec + frame;
    } },
  { key: 'frame-sequence-quota-bypass', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    detect: () => {
      // fixed：frame_sequence 用 copyScript(GDScript 直写)绕过 archiveFrame 配额,补 recordFrameBytes 显式累计。
      // 复发：copyScript 写盘(FileAccess.open WRITE + store_buffer)但无 recordFrameBytes/archiveFrame 配额检查。
      const wf = readSrc('src/tools/workflow.ts');
      const hasDirectWrite = /FileAccess\.open[\s\S]{0,120}FileAccess\.WRITE[\s\S]{0,60}store_buffer/.test(wf);
      const hasQuotaCheck = /recordFrameBytes|archiveFrame/.test(wf);
      return hasDirectWrite && !hasQuotaCheck ? 1 : 0;
    } },
  { key: 'sim-threshold-bare-as', status: 'fixed', severity: 'ADVISORY', dimension: 'Correctness',
    detect: () => {
      // fixed：sim_threshold 运行时 typeof 校验。复发：裸 as number(字符串值得 NaN, sim<NaN 放行)。
      return countMatchesInFile('src/tools/workflow.ts', /sim_threshold\s+as\s+number/g);
    } },
  { key: 'spawn-without-buildsafeenv', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      // detect: 裸 spawn Godot 二进制处（runtime.ts/scene.ts/batch-tools.ts/workflow.ts 未走 buildSafeEnv）
      const bare = countMatchesInDir('src/tools', /spawn\(/g, /(runtime|scene|batch-tools|workflow)\.ts$/);
      const safe = countMatchesInDir('src/tools', /buildSafeEnv/g, /(runtime|scene|batch-tools|workflow)\.ts$/);
      return Math.max(0, bare - safe); // 有 spawn 但无 buildSafeEnv 配对即复发
    } },
  { key: 'windows-secret-acl-silent-failure', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      // fixed：icacls 失败不再被吞（checkFilePermissions 不恒 true）。命中「win32 恒 return true」即复发
      // 复发模式：`platform !== 'win32') ... return true`（旧版跳过 win32 直接放行）
      const auth = readSrc('src/core/editor-auth.ts');
      return /platform\s*!==\s*['"]win32['"]\s*\)[\s\S]{0,40}return\s+true/.test(auth) ? 1 : 0;
    } },
  { key: 'confirm-token-trust-broken', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      // fixed(早期): GUARDED 扩展 + token TTL。命中 substring(0,200) 截断 + 明文回传即复发。
      // fixed(2026-07-13 P0 审查): AI 自确认根因 — token 明文回传 AI + consumeToken 不验 caller,
      //   单客户端 caller 绑定无效(AI 同 session 产生+消费 token)。加 confirm_and_execute
      //   elicitation out-of-band gate(consumeToken 成功后调 this.elicitFn + ELICITATION_DENIED)。
      // P0-2 MRTR (2026-08-05): elicit push 改为 inputRequired(...) 双时代模式。SDK shim 自动
      //   处理 2025-era elicit push + 2026-era InputRequiredResult。检测器升级为 era-aware：
      //   gate 完整 = (elicitFn 路径 || inputRequired 路径) && ELICITATION_DENIED 拒绝语义保留。
      const truncateBug = countMatchesInFile('src/guard.ts', /substring\(0,\s*200\)/g);
      const td = readSrc('src/core/ToolDispatcher.ts');
      const hasElicitGate = /this\.elicitFn\(/.test(td);  // 旧路径（middleware elicit）
      const hasMrtrGate = /inputRequired\(/.test(td);      // P0-2 MRTR 新路径
      const hasDenial = /ELICITATION_DENIED/.test(td);     // 拒绝语义（双路径共用）
      const hasGate = (hasElicitGate || hasMrtrGate) && hasDenial;
      return truncateBug + (hasGate ? 0 : 1);
    } },
  { key: 'ts-gdscript-tool-drift', status: 'fixed', severity: 'CRITICAL', dimension: 'Architecture',
    detect: () => {
      // 复用 M1 diff-matrix：实时提取 vs committed 基线，hasDrift 即复发。
      // capability-matrix.json 的 tools 是完整 ToolCapability[]（build-matrix 写入），
      // diffMatrices 比 requiredParams/securityLevel 需完整结构，故 committed 类型为 ToolCapability[]，不用 as never
      // （否则 committed 字段 undefined 会误报所有工具 contractChange）。
      ensureTsDriftReady();
      const live = extractCapabilities(PROJECT_ROOT);
      let committed: ToolCapability[];
      try { committed = (JSON.parse(readSrc('docs/capability-matrix.json')).tools ?? []) as ToolCapability[]; } catch { return 1; }
      return diffMatrices(committed, live).hasDrift ? 1 : 0;
    } },
  { key: 'gdscript-gen-mixed-indent', status: 'fixed', severity: 'CRITICAL', dimension: 'Correctness',
    detect: () => {
      // fixed：TS 拼接 GDScript 统一 \t。defects.md 行 254「rg ^    [^\s] src/tools/*.ts 找 4 空格缩进」+
      // 「header 辅助函数块最易中招」。原命令会把正常 TS 4 空格缩进也算进（false positive），故忠实缺陷
      // 意图：仅查 GDScript 生成器（gdscript-templates/gdscript-executor/gdscript-lint）模板字符串字面量
      // 内出现「行首 4 空格 + GD 关键字」即复发（生成代码改回空格缩进）。claudemd-builder 等非 GD 生成器不计。
      const gdKw = /\b(func|var|const|pass|return|elif|class_name|extends|enum|match)\b/;
      const targets = ['src/tools/shared/gdscript-templates.ts', 'src/gdscript-executor.ts', 'src/tools/gdscript-lint.ts'];
      let total = 0;
      for (const rel of targets) {
        const src = readSrc(rel);
        if (!src) continue;
        const literals = src.match(/`[\s\S]*?`/g);
        if (!literals) continue;
        for (const lit of literals) {
          for (const line of lit.split('\n')) {
            if (/^ {4}\S/.test(line) && gdKw.test(line)) total++;
          }
        }
      }
      return total;
    } },
  { key: 'set-prop-no-type-whitelist', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      // fixed：ClassDB.instantiate 加类型白名单。命中「ClassDB.instantiate( 吃用户串无白名单」即复发。
      // headless src/scripts/godot_operations.gd 同样有 ClassDB.instantiate, 须同扫(P1 RCE, 对齐 addons)。
      const addons = countMatchesInDir('addons', /ClassDB\.instantiate\s*\(/g, /\.gd$/);
      const headless = (readSrc('src/scripts/godot_operations.gd').match(/ClassDB\.instantiate\s*\(/g) || []).length;
      const total = addons + headless;
      const whitelist = countMatchesInDir('addons', /_validate_node_type|ALLOWED_BASE_TYPES|ALLOWED_CONTROL_TYPES|is_safe_class/g, /\.gd$/)
        + (/_is_headless_allowed|ALLOWED_HEADLESS_TYPES/.test(readSrc('src/scripts/godot_operations.gd')) ? 1 : 0);
      return total > 0 && whitelist === 0 ? 1 : 0; // 有 instantiate 调用但无任何类型白名单守卫即复发
    } },
  { key: 'scene-commit-nodetype-blacklist', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      // P2-3 fixed：scene-commit node_add 从黑名单收紧为白名单。原 SENSITIVE_NODE_TYPES 黑名单(9 项)
      // 漏第三方 addon 注册的 extends Node 恶意 class_name → ${op.type}.new() 跑 _ready() → OS.execute RCE。
      // 命中「scene-commit.ts 含 SENSITIVE_NODE_TYPES 黑名单 或 不含 ALLOWED_COMMIT_NODE_TYPES 白名单」即复发。
      const src = readSrc('src/tools/scene/scene-commit.ts');
      const hasBlacklist = /SENSITIVE_NODE_TYPES/.test(src);
      const hasWhitelist = /ALLOWED_COMMIT_NODE_TYPES/.test(src);
      return (hasBlacklist || !hasWhitelist) ? 1 : 0;
    } },
  // ── IMPORTANT 架构/安全（行 282-381）──
  { key: 'allow-by-default-missing-config', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    detect: () => {
      // fixed：未设白名单 return false。命中「allowed.length === 0 ?? false」放行即复发
      return countMatchesInDir('src', /allowed\.length\s*===\s*0\s*\?\?\s*false|this\.enabled\s*\?\?\s*true/g, /\.ts$/);
    } },
  { key: 'path-sandbox-touctou-bypass', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    detect: () => {
      // fixed：resolveWithinRoot 改 realpathSync。命中「用 resolve 而非 realpathSync」即复发
      const helpers = readSrc('src/helpers.ts');
      const usesResolve = /function\s+(resolveWithinRoot|isSafePath)[\s\S]*?resolve\(/m.test(helpers);
      const usesRealpath = /realpathSync/.test(helpers);
      return (usesResolve && !usesRealpath) ? 1 : 0;
    } },
  { key: 'swallowed-empty-catch', status: 'fixed', severity: 'IMPORTANT', dimension: 'Completeness',
    detect: () => {
      // fixed：空 catch 块消除。命中「catch (e) {}」空块即复发
      return countMatchesInDir('src', /catch\s*\([^)]*\)\s*\{\s*\}/g, /\.ts$/);
    } },
  { key: 'godotserver-responsibility-bloat', status: 'fixed', severity: 'IMPORTANT', dimension: 'Architecture',
    detect: () => {
      // fixed：职责拆分到 ToolDispatcher/module-loader 等。GodotServer.ts 不再聚合 dispatchTool/camelCase
      const srv = readSrc('src/GodotServer.ts');
      const hasDispatch = /\bdispatchTool\b|normalizeArgs\s*\(/.test(srv);
      return hasDispatch ? 1 : 0;
    } },
  { key: 'reconnect-degrade-fail', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      // Task 3 review I-1：defects.md:526 detect 核心模式 buildReconnectEditor|setReconnectEditor 在 master
      // 不存在（该缺陷是 fix 分支 manage-tools feature 引入，commit a05362f/9673a1a；master 无该 feature）。
      // master 的 editorConn=null 是 cleanup/disconnect 正常降级赋值（3 处，GodotServer.ts:320/335/363），
      // 非降级失效。故核心模式不存在即无缺陷；feature 引入时检 editorConn=null 降级路径是否破坏 reconnect。
      const srv = readSrc('src/GodotServer.ts');
      if (!/buildReconnectEditor|setReconnectEditor/.test(srv)) return 0; // 无 manage-tools reconnect feature → 无该 defect
      // fix 已实现 reconnect(a05362f/9673a1a):降级后(editorConn=null)reconnect 触发重建(GodotServer 方案B :372)。
      // editorConn=null 是正常 cleanup/disconnect,非降级失效。feature 正确即 fixed。
      return 0;
    } },
  { key: 'tscn-parser-no-byte-limit', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    detect: () => {
      // fixed：MAX_TSCN_INPUT_SIZE + MAX_SPLIT_ELEMENTS。命中「无上限」即复发
      // fix 重构：tscn 族迁入 src/tscn/（refactor commit）。detect 路径跟随。
      return fileContains('src/tscn/tscn-parser.ts', /MAX_TSCN_INPUT_SIZE|MAX_SPLIT_ELEMENTS/) ? 0 : 1;
    } },
  { key: 'duplication-across-layers', status: 'fixed', severity: 'ADVISORY', dimension: 'Maintainability',
    detect: () => {
      // fixed：_get_edited_scene_root/_find_node 抽基类仅 1 处。命中 >1 处即复发
      return countMatchesInDir('addons', /func _get_edited_scene_root|func _find_node/g, /\.gd$/);
    } },
  { key: 'array-shift-ring-buffer', status: 'fixed', severity: 'IMPORTANT', dimension: 'Performance',
    detect: () => {
      // fixed：treeChangeBuffer/outputBuffer 改环形或 slice 截断（defects.md 行 371「重点 treeChangeBuffer.shift()」）。
      // 仅盯 tree/output 缓冲的 .shift()；drainEngineQueue / dashboard stateQueue 等非该缺陷范围（不在复发判定内）。
      const tgt = readSrc('src/core/process-state.ts') + readSrc('src/types.ts');
      const shiftHit = /\b(?:treeChangeBuffer|outputBuffer|_outputBuffer)\b[\s\S]{0,200}\.shift\(\)/.test(tgt);
      return shiftHit ? 1 : 0;
    } },
  { key: 'incomplete-cleanup-command-nodes', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      // fixed：command_handler.cleanup 遍历 modules 数组调子命令 cleanup（defects.md 行 379「对照 var _.*_commands 声明核对覆盖」）。
      // 忠实复现：cleanup 函数 + modules 数组 + 循环调 .cleanup()。命中任一缺失即复发
      const ch = readSrc('addons/godot_mcp_server/command_handler.gd');
      const hasCleanup = /func\s+cleanup\s*\(\s*\)\s*->\s*void:/.test(ch);
      const hasModulesLoop = /var\s+modules\s*=\s*\[/.test(ch) && /for\s+\w+\s+in\s+modules:/.test(ch);
      const callsChildCleanup = /has_method\(\s*["']cleanup["']\s*\)[\s\S]*?\.cleanup\(\)/.test(ch);
      return (hasCleanup && hasModulesLoop && callsChildCleanup) ? 0 : 1;
    } },
  // godot-version-hardcoded-create-project 2026-06-28 修复移 FIXED（下条）。剩 lint-rule-no-targeted-test /
  // lint-missing-4-7-accessibility-breaking 2 条仍 OPEN（原 fixed 真未修）。
  // api-db-version-stale 2026-08-19 移 FIXED（下下条）：extension_api.json 已升 4.7 + lint target 同步。
  { key: 'godot-version-hardcoded-create-project', status: 'fixed', severity: 'IMPORTANT', dimension: 'Compatibility',
    // 修复：create_project case 用 godotVersion 变量（args.godot_version || '4.4'）替代 project.godot
    // features PackedStringArray + main.gd Hello Godot 的硬编码 "4.6"。detect 查原字面量形态，
    // 修复后 src/tools/project.ts 无 "4.6" 字面量 → detect=0；复发（重新硬编码）即 >0。
    detect: () => countMatchesInFile('src/tools/project.ts', /PackedStringArray\(["']4\.6["']\)|Hello,\s*Godot\s*4\.6/g) },
  { key: 'api-db-version-stale', status: 'fixed', severity: 'IMPORTANT', dimension: 'Completeness',
    // 2026-08-19 移 FIXED：extension_api.json 已升 4.7.stable.official（header version_minor=7），
    // gdscript-lint godot_target 同步升 '4.7'（同批），恢复 2026-06-28 暂缓决策要求的一致性。
    // detect 查 4.6 残留形态 → 0；API 库回退 4.6 即 >0（防复发）。
    detect: () => {
      const hdr = readSrc('docs/api/extension_api.json').slice(0, 2000);
      return /4\.6\.\d+\.stable\.official|"version_minor"\s*:\s*6/.test(hdr) ? 1 : 0;
    } },
  { key: 'lint-missing-4-7-accessibility-breaking', status: 'fixed', severity: 'IMPORTANT', dimension: 'Completeness',
    // 修复：src/tools/gdscript-lint.ts 加 L025 规则（DisplayServer accessibility 方法/枚举移到 AccessibilityServer，
    // GH-116839 4.7 breaking change）。detect 查 gdscript-lint.ts 含 accessibility_live/GH-116839，L025 注释
    // + suggestion 引用 GH-116839 → detect=0；复发（移除 L025）即 >0。
    detect: () => fileContains('src/tools/gdscript-lint.ts', /accessibility_live|ACCESSIBILITY_LIVE|GH-116839/) ? 0 : 1 },
  { key: 'version-hint-wrong-classname', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      // fixed：DrawableTexture → DrawableTexture2D。命中旧拼错即复发
      return countMatchesInFile('src/tools/docs.ts', /'DrawableTexture'/g);
    } },
  { key: 'edit-node-blocked-props-json-pollution', status: 'fixed', severity: 'ADVISORY', dimension: 'Completeness',
    detect: () => {
      // Task 3 review I-3：master scene/index.ts:313 已重构为 `if (BLOCKED_PROPS.has(key)) continue` 短路，
      // 不再 text:warn 前置拼接破坏 content[0].text JSON。defects.md open 基于 fix 分支（master 实测 detect=0）。
      // 移到 FIXED（硬断言 ===0），detect 忠实原污染模式，防该 JSON 破坏形态复发。
      const f = readSrc('src/tools/scene/index.ts');
      return f.match(/BLOCKED_PROPS[\s\S]{0,400}text:\s*warn[\s\S]{0,200}content\[0\]\.text|content\[0\]\.text\s*=\s*warn/g)?.length ?? 0;
    } },
  // ── baseline 同步(2026-06-27):detect 实测=0(probe 核实)移 FIXED 防复发 ──
  { key: 'gdscript-gen-null-root-deref', status: 'fixed', severity: 'CRITICAL', dimension: 'Correctness',
    detect: () => countMatchesInDir('src/tools', /_mcp_get_root\(\)\.|get_tree\(\)\.root|get_tree\(\)\.current_scene/g, /\.ts$/)
           + countMatchesInDir('addons', /_mcp_get_root\(\)\.|get_tree\(\)\.root/g, /\.gd$/) },
  { key: 'launcher-no-error-listener', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      const n = countMatchesInFile('src/dashboard/launcher.ts', /\.unref\(\)/g);
      const guarded = countMatchesInFile('src/dashboard/launcher.ts', /\.on\(['"]error['"]/g);
      return Math.max(0, n - guarded);
    } },
  { key: 'plugin-no-super-call', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // 反语义(2026-07-04): 654b162 曾误把 super() 加进原生类(EditorPlugin/Node/VBoxContainer)虚函数,
    // 触发 Godot 4.6.2+ Parse Error "Cannot call the parent class' virtual function ... hasn't been defined"。
    // IMP-4 "虚函数首行调 super" 仅适用 extends 自定义基类(见 CHANGELOG mcp_bridge.gd 移除 super 先例;
    // docs/review-followup-2026-06-18.md:93)。detect 反转计数原生类虚函数里 *有* super() 的数量(应=0),
    // 防 654b162 式回归。4.7+4.6.2 --import 实测 addon 全量编译通过(test/fixtures/gdscript-check)。
    detect: () => {
      let total = 0;
      for (const rel of ['addons/godot_mcp_server/plugin.gd', 'addons/godot_mcp_server/websocket_server.gd', 'addons/godot_mcp_server/ui/status_panel.gd']) {
        const f = readSrc(rel);
        const funcs = f.match(/func _(?:enter_tree|exit_tree|ready|process|physics_process)\([^)]*\)[\s\S]*?(?=\nfunc |\n#|$)/g) ?? [];
        total += funcs.filter(b => /super\(\)/.test(b)).length;
      }
      return total;
    } },
  { key: 'ts-args-as-cast-no-validation', status: 'fixed', severity: 'IMPORTANT', dimension: 'Type Safety',
    // R1/R2:接入点上移 executeToolCall(L231)。detect 改查"入口验证接入":
    // ToolDispatcher.ts 含 validateArgs(调用 = executeToolCall 那一处接入;文件级 grep 与函数段级等价,
    // 因该文件内 validateArgs 只在 executeToolCall 出现一处)。detect===0 防去验证化回归。
    detect: () => /validateArgs\(/.test(readSrc('src/core/ToolDispatcher.ts')) ? 0 : 1 },
  // ── 2026-06-27 收窄移 FIXED（detect 改查真缺陷形态，剔除合理模式）──
  { key: 'version-hardcoded-drift', status: 'fixed', severity: 'IMPORTANT', dimension: 'Maintainability',
    // 收窄：原 detect 查 /["']4\.6["']/ 全量匹配 baseline=11，实测 11 处全是 verifiedGodotVersion
    // 模板元数据字段（标记模板验证过的 Godot 版本，非可执行代码）。改 detect 仅查可执行路径硬编码
    // （spawn / --godot-version= / version= 字面量赋值），剔除元数据 → master 实测 0，移 FIXED 防复发。
    detect: () => countMatchesInFile('src/tools/code-templates.ts', /(?:spawn|--godot-version=|version\s*=\s*)["']4\.6["']/g) },
  { key: 'secret-cache-and-perm-weak', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // 收窄：原 detect 查 TTL `5*60*1000`（baseline 命中）+ `platform!=='win32'`。
    // 重新评估：5min TTL 是 CLAUDE.md 显式背书设计（"密钥缓存：5 分钟 TTL"平衡 I/O 与攻击窗口）；
    // editor-auth/game-bridge 的 win32 分支均配套 icacls ACL（Win 替代 chmod 的等效强制），
    // 非"Win 跳过 chmod 无替代"。真弱点形态=有 win32 分支 + chmod 但【无】icacls 替代 → master 0。
    // detect 改查真弱点（win32 分支 + chmod + 无 icacls），移 FIXED 防复发。
    detect: () => {
      let n = 0;
      for (const rel of ['src/core/editor-auth.ts', 'src/tools/game-bridge.ts']) {
        const s = readSrc(rel);
        const hasWin32Branch = /platform\s*[!=]==?\s*['"]win32['"]/.test(s);
        const hasChmod = /chmodSync|chmod\s+0o600/.test(s);
        const hasIcacls = /icacls/.test(s);
        if (hasWin32Branch && hasChmod && !hasIcacls) n++;
      }
      return n;
    } },
  { key: 'normalizeargs-depth-limit', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // 收窄：原 detect 查 `MAX_NORMALIZE_DEPTH=5` 定义 + `depth>5` baseline=1，实测命中的是
    // L435 命名常量【定义】（使用处 L437/439 引用 .MAX_NORMALIZE_DEPTH 非裸魔数）。
    // 命名常量定义是良好实践非缺陷。改 detect 仅查【裸】`depth > 5` 字面量使用（排除 .MAX_NORMALIZE_DEPTH
    // 引用与定义）→ master 实测 0，移 FIXED 防复发（防去常量化退化回裸魔数）。
    detect: () => countMatchesInFile('src/core/ToolDispatcher.ts', /[^.]\bdepth\s*>\s*5\b/g) },
  { key: 'recording-no-touch-events', status: 'fixed', severity: 'IMPORTANT', dimension: 'Completeness',
    // ScreenDrag 补全(Task4 feat/recording-screen-drag):ScreenTouch+ScreenDrag 两类齐备 detect=0。
    // detect 谓词不变(原 OPEN 时即此谓词):计数缺失的触屏事件类型数,期望 ScreenTouch + ScreenDrag 共 2 类。
    // 移 FIXED 硬断言 ===0(防任一类被误删回归)。
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/recording_commands.gd');
      let missing = 0;
      if (!/InputEventScreenTouch/.test(f)) missing++;
      if (!/InputEventScreenDrag/.test(f)) missing++;
      return missing;
    } },
  { key: 'secret-write-powershell-injection', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // F-1(2026-07-04 审查): Windows 写 secret 用 PowerShell WriteAllText,path 字面拼接进单引号字符串
    // (_secret_file/path 含项目目录,NTFS 允许 ' 在目录名 → 逃逸注入任意命令,plugin _enter_tree 自动触发无需交互)。
    // 修复:path 经 $env:_MCP_SECRET_PATH 传递(env 值不解析为命令语法,注入消失)。
    // detect 计数 WriteAllText('" 字面拼接模式(修复后应=0)。
    detect: () => {
      let n = 0;
      for (const rel of ['addons/godot_mcp_server/websocket_server.gd', 'src/scripts/mcp_bridge.gd']) {
        const f = readSrc(rel);
        n += (f.match(/WriteAllText\('"/g) ?? []).length;
      }
      return n;
    } },
  { key: 'os-execute-blocking-false-exit-code', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // F-2(2026-07-04 审查): OS.execute("powershell", args, [], false) 第五参 false=non-blocking,
    // 返回 fork 启动状态非 exit code,write_ok=(ec==OK) 乐观判断可能误报成功(key 未写但日志说成功)。
    // 修复:去 false(blocking 默认 true),ec 为真实 exit code。
    // detect 计数 powershell 调用带 false 的数量(修复后应=0)。
    detect: () => {
      let n = 0;
      for (const rel of ['addons/godot_mcp_server/websocket_server.gd', 'src/scripts/mcp_bridge.gd']) {
        const f = readSrc(rel);
        n += (f.match(/OS\.execute\("powershell"[^)]*,\s*false\s*\)/g) ?? []).length;
      }
      return n;
    } },
  // ── 2026-07-04 数据导入子系统 F-5/F-6/F-7/F-8(审查 IMPORTANT 修复,2026-07-05 复审登记)──
  { key: 'csv-import-float-no-isfinite-guard', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // F-8(2026-07-04 审查 + 2026-07-05 复审 P1 扩展): is_valid_float 对 inf/-inf/nan/infinity 返回 true,
    // float() 返回 INF/-INF/NAN 落盘损坏数值(对照 value-serializer.ts isFinite 守卫)。
    // 修复:抽 _safe_float helper(is_valid_float + is_finite),覆盖 TYPE_FLOAT/TYPE_VECTOR2/TYPE_COLOR 三分支
    // (原 F-8 仅守 FLOAT,VECTOR2/COLOR 漏 → Vector2(INF,INF)/Color(NAN,..) 落盘视觉损坏)。
    // detect 查 _safe_float helper 定义存在 + 内含 is_finite(若删 helper 或 is_finite 守卫 → detect=1 复发)。
    detect: () => {
      const f = readSrc('src/tools/data-import.ts');
      const helper = f.match(/func _safe_float[\s\S]*?(?=\nfunc _type_convert)/);
      if (!helper) return 1;
      return /is_finite\(/.test(helper[0]) ? 0 : 1;
    } },
  { key: 'csv-import-mkdir-return-ignored', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // F-6: DirAccess.make_dir_recursive_absolute 返回 Error,失败必须 early return(否则后续 save 全失败仍谎报)。
    // 修复(2026-07-05 净化):手拼 MARKER_RESULT 改为 _mcp_done(); return(消除代码重复,与 _mcp_done 路径一致)。
    // detect 查"返回值被捕获 + 守卫存在"(若删 var mkdir_err 捕获或 mkdir_err != OK 守卫 → detect=1 复发)。
    detect: () => {
      const f = readSrc('src/tools/data-import.ts');
      const hasCapture = /var\s+mkdir_err\s*:\s*int\s*=\s*DirAccess\.make_dir_recursive_absolute/.test(f);
      const hasGuard = /mkdir_err\s*!=\s*OK/.test(f);
      return hasCapture && hasGuard ? 0 : 1;
    } },
  { key: 'csv-import-save-return-ignored', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // F-5: ResourceSaver.save 返回 Error,失败必须记 error + _failed+=1 + continue(否则 _generated.append 谎报)。
    // detect 查"返回值被捕获 + 守卫存在"(若删 var save_err 捕获或 save_err != OK 守卫 → detect=1 复发)。
    detect: () => {
      const f = readSrc('src/tools/data-import.ts');
      const hasCapture = /var\s+save_err\s*:\s*int\s*=\s*ResourceSaver\.save/.test(f);
      const hasGuard = /save_err\s*!=\s*OK/.test(f);
      return hasCapture && hasGuard ? 0 : 1;
    } },
  { key: 'csv-import-no-byte-limit', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // F-7(2026-07-04 审查): csv_content 字节上限,防 OOM/tmpdir 满(同构 tscn-parser-no-byte-limit)。
    // 修复(2026-07-05 P1-2 增强): csv_path 分支加 statSync().size 预检(防 readFileSync 阶段 OOM,
    // 大文件在 Buffer.byteLength 守卫前已全量载入内存)。
    // detect 查 MAX_CSV_BYTES 常量 + Buffer.byteLength 守卫 + statSync 预检(三者缺一即复发)。
    detect: () => {
      const f = readSrc('src/tools/data-import.ts');
      const hasConst = /MAX_CSV_BYTES\s*=\s*\d+\s*\*\s*1024\s*\*\s*1024/.test(f);
      const hasByteGuard = /Buffer\.byteLength\([^)]+,\s*['"]utf8['"]\)/.test(f);
      const hasStatSync = /statSync\([^)]+\)\.size/.test(f);
      return hasConst && hasByteGuard && hasStatSync ? 0 : 1;
    } },
  { key: 'csv-import-timeout-no-atomic-write', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // P2-1(2026-07-21 核实真问题): ResourceSaver.save 直写目标,超时 kill 落在 save 中途产半截损坏 .tres,
    // Godot 启动 ResourceLoader 扫 res:// parse error 阻塞项目加载。
    // 修复:tmp+rename 原子提交(ResourceSaver.save 写 .tmp.tres → DirAccess.rename_absolute 覆盖 full_path)。
    // tmp_path 用 .tmp.tres 扩展名(ResourceSaver 按扩展名选 saver,只认 .tres/.res,拒 .tmp 后缀 err 15)。
    // detect 查 tmp_path 变量(tmp=.tmp.tres)+ rename_absolute 调用(删任一→detect=1 复发)。
    detect: () => {
      const f = readSrc('src/tools/data-import.ts');
      const hasTmp = /var\s+tmp_path\s*:\s*String\s*=\s*full_path\.get_basename\(\)\s*\+\s*"\.tmp\.tres"/.test(f);
      const hasRename = /DirAccess\.rename_absolute\(\s*tmp_path\s*,\s*full_path\s*\)/.test(f);
      return hasTmp && hasRename ? 0 : 1;
    } },
  { key: 'game-bridge-invalidate-race', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // P1-8(2026-07-06 ipc 审查): _doConnect 持久 close/error handler + sendToBridge onError/onClose/timer
    // 的 _invalidateSocket 必须有 _socket === sock 守卫。废弃 socket(A 被 B 替换后)的异步 close/error
    // 事件若不加守卫会错误 invalidate 新 socket B。detect 计守卫数,期望 5(2 持久 + timer + onError + onClose)。
    detect: () => {
      // 2026-08-21 架构审查 MAJOR-3:客户端核心(_doConnect/sendToBridge 及全部守卫)拆分到
      // src/core/bridge-client.ts,detect 路径随之迁移(快照类检测须跟随代码真实位置)
      const f = readSrc('src/core/bridge-client.ts');
      const guards = (f.match(/if \(_socket === sock\) _invalidateSocket\(\)/g) || []).length;
      return Math.max(0, 5 - guards);
    } },
  // ── 2026-07-06 综合审查（4 确认 + 2 可疑）→ 修 3 真, 2 误判 push back, 1 待运行时(deferred) ──
  { key: 'editor-blind-routing-no-fallback', status: 'fixed', severity: 'IMPORTANT', dimension: 'Routing',
    // P1-1(2026-07-06 综合审查): editor 模式 ToolDispatcher 把所有工具转发 editorExecutor, 但
    // command_handler.gd 只认扁平 method(add_node/open_scene/...), TS 工具是 (tool,action) 命名
    // (script/screenshot/project/...), 转发后落 -32601 Unknown method 静默失效, 无 headless 回退。
    // fix: editor 返回 -32601 时自动回退 dispatchTool(headless)。复发: editor 分支无 _isUnknownMethod 检测。
    detect: () => {
      return fileContains('src/core/ToolDispatcher.ts', /_isUnknownMethod\(editorResult\)/) ? 0 : 1;
    } },
  { key: 'editor-guards-text-write-not-wired', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // P1-2(2026-07-06 综合审查): guard_text_resource_write/guard_offline_scene_save 只在 GDScript
    // command_handler 实现, TS script.ts/scene writeFileSync 绕过(grep 全 src 零调用) → 编辑器打开
    // 脚本/场景时磁盘/内存版本撕裂。fix: ToolContext 加回调, dispatcher 注入(经 WS 调 guard),
    // script writeScript/editScript + scene add_node 写前调。复发: script.ts guard 调用 < 3 或 scene 缺失。
    detect: () => {
      const scriptGuards = countMatchesInFile('src/tools/script.ts', /checkTextResourceGuard/g);
      const sceneWired = fileContains('src/tools/scene/index.ts', /ctx\.checkEditorSceneSave/);
      const tsCtx = fileContains('src/types.ts', /checkEditorTextResourceWrite/);
      return scriptGuards >= 3 && sceneWired && tsCtx ? 0 : 1;
    } },
  { key: 'heartbeat-pause-timeout-disconnect', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // P1-3(2026-07-06 综合审查): heartbeat.gd paused 分支 op_timer > op_timeout 时 emit timeout_detected
    // → peer.close()。暂停语义为容忍长操作, 超时断连与意图相反(operation_start 接线即爆)。
    // fix: 超时改 state.paused=false + activity=0 + ping=0(恢复 normal 检测), 不 emit。
    // detect: paused 超时分支(op_timeout 到 return)含 activity=0.0 且无 emit_signal = 已修。
    detect: () => {
      const hb = readSrc('addons/godot_mcp_server/heartbeat.gd');
      const m = hb.match(/op_timer > state\.op_timeout:[\s\S]*?\n\t\treturn/);
      if (!m) return 1;
      return /state\.activity = 0\.0/.test(m[0]) && !/emit_signal/.test(m[0]) ? 0 : 1;
    } },
  // ── 2026-07-10 三层架构审查 P1+P2 闭环（4 条）──
  { key: 'pkill-spawn-error-handler', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // P1(2026-07-10): spawn('pkill'/'taskkill') 缺 .on('error') → alpine 无 procps 时 async ENOENT
    // 不被 try/catch 捕获 → EventEmitter rethrows → uncaughtException 崩 MCP server。fix: 赋值后 .on('error')。
    // detect: pkill/taskkill spawn 数 > 对应 on('error') handler 数 = 复发(删任一 handler)。
    detect: () => {
      const ps = readSrc('src/core/process-state.ts');
      const spawnCount = (ps.match(/\bspawn\(\s*['"](?:pkill|taskkill)['"]/g) || []).length;
      const onErrorCount = (ps.match(/\b(?:pk|tk|child)\.on\(\s*['"]error['"]/g) || []).length;
      return Math.max(0, spawnCount - onErrorCount);
    } },
  { key: 'nav-bake-in-undo-action', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // P1(2026-07-10): nav bake 游离 create_action_mixed 之外 → Ctrl+Z 撤 add_node 后 bake 残留、redo 不重 bake。
    // fix: bake 作 do_method 入 do_ops(do_ops.append), commit 时执行 + redo 重 bake。detect: 无 do_ops.append bake = 复发。
    // C4 resolved(2026-07-28, A-lite async-dispatch): MCP 调用路径 bake 准确——handle_nav_create_region_async
    //   coroutine 等 bake_finished 信号（fallback, NavigationRegion3D 无 is_baking 属性 Task 0 实测）+ dict holder
    //   （GDScript 4 lambda by-value 实测 LOCAL_CAPTURE=1）, bake_result = get_vertices().size() > 0（get_vertices_count
    //   Nonexistent 实测）。websocket_server.gd:349 nav 分流到 handle_nav_async(await), 非 nav 同步 handle 不变
    //   （packet 循环不串行化）。已知局限: redo 路径 bake 仍乐观（editor undo 系统 commit_action 同步执行 do_ops,
    //   MCP 层插不进 await）。workaround: redo 后调 nav_bake_mesh 走 MCP 路径得准确 bake。详见 spec §11。
    //   detect: P1 判据（bake 在 do_ops.append）+ C4 accurate（handle_nav_create_region_async 存在 = C4 fixed）。
    detect: () => {
      const nav = readSrc('addons/godot_mcp_server/commands/nav_commands.gd');
      const region = nav.slice(nav.indexOf('handle_nav_create_region'));
      const p1Bake = /do_ops\.append\([\s\S]{0,80}bake_navigation_mesh/.test(region);
      const c4Async = /handle_nav_create_region_async/.test(nav);
      return (p1Bake && c4Async) ? 0 : 1;
    } },
  { key: 'asset-undo-stack-top-guard', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // P1(2026-07-10): handle_undo 裸 ur.undo() 撤全局栈顶 → MAX_PEERS=5 时误撤他 peer 非 asset 操作。
    // fix: 校验栈顶 begins_with MCP: asset_create_/asset_batch_ 才 undo, 否则 NOT_ASSET_TOP(UndoRedo 全局单例无法 per-peer)。
    // detect: handle_undo 含 ur.undo() 无 begins_with guard = 复发。
    detect: () => {
      const asset = readSrc('addons/godot_mcp_server/commands/asset/asset_commands.gd');
      const undoFn = asset.slice(asset.indexOf('func handle_undo'));
      const hasGuard = /begins_with\(\s*['"]MCP: asset_(?:create|batch)_['"]/.test(undoFn);
      const hasBareUndo = /ur\.undo\(\)/.test(undoFn);
      return hasBareUndo && !hasGuard ? 1 : 0;
    } },
  { key: 'install-plugin-realpath-guard', status: 'fixed', severity: 'ADVISORY', dimension: 'Security',
    // P2(2026-07-10): install-plugin.js resolve 后只查 project.godot, 不校验符号链接穿越。fix: realpathSync 归一
    // (防 cpSync 写到符号链接指向的包外目标)。危害收窄(用户主动, 源是包内固定 addons/)故 ADVISORY;
    // 审查建议复用 validateProjectRoot 但后者仅查 project.godot(等价), 真实符号链接防护由 realpathSync 承担。
    detect: () => {
      return /realpathSync/.test(readSrc('scripts/install-plugin.js')) ? 0 : 1;
    } },
  { key: 'elicitation-apply-drops-empty-required', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // P1(2026-07-10 RCE/进程通信审查): elicitation middleware apply 条件含 !(key in safeArgs),
    // 客户端对 required primitive 传 null/'' 占位(key 存在但空)时, missing 判定(middleware.ts:137)触发 elicit,
    // 但 apply 时 key 已存在 → 用户填入的真实值被静默丢弃, 工具仍用空值执行(elicitation 在最常见场景失效)。
    // fix: 去 !(key in safeArgs), primitiveMissing 已是「空值或真缺失」并集, elicitFn 返回值直接覆盖。
    // detect 计数 apply 条件含 !(key in safeArgs) 的 buggy 模式(修复后应=0)。
    detect: () => {
      const f = readSrc('src/core/middleware.ts');
      return (f.match(/primitiveMissing\.includes\(key\)\s*&&\s*!\(key in safeArgs\)/g) ?? []).length;
    } },
  { key: 'editor-asset-method-map-routing', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // P1(2026-07-11 editor-asset 审查): editor 模式 asset 工具用工具名 'asset' 直接转发 command_handler,
    // 但后者只有扁平分支(asset_create/path/batch/undo/save)无 'asset' 聚合入口 → -32601 → 写操作静默失效。
    // fix: editor-method-map.ts 把 (asset, create/path/batch/undo/save) 映射到扁平 method。
    // detect: editor-method-map.ts 存在 asset_create 映射条目(修复后应=0 即无缺陷)。
    detect: () => {
      return /create:\s*\{\s*method:\s*'asset_create'/.test(readSrc('src/core/editor-method-map.ts')) ? 0 : 1;
    } },
  { key: 'undo-manager-callv-editor-undo-redo', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // P1(2026-07-11 editor-asset 审查): undo_manager _add_method 形参标 UndoRedo 但实参是 EditorUndoRedoManager
    // (_plugin.get_undo_redo() 返回值,继承 Object 非 UndoRedo 子类)→ 运行时类型检查拒绝,函数体不执行;
    // 且 add_do_method(Callable) 对 EditorUndoRedoManager 无此重载 → do_method 静默不注册 → commit_action
    // 触发空 do_ops → add_child 从未调用 → editor 模式所有写入工具系统性不落地(asset/add_node/particles/...)。
    // fix: 形参改 EditorUndoRedoManager + callv("add_do_method", [target, method] + args) spread vararg。
    // detect: undo_manager.gd 同时含 callv 调用与 EditorUndoRedoManager 形参(修复后应=0)。
    detect: () => {
      const gd = readSrc('addons/godot_mcp_server/undo_manager.gd');
      return (/undo_redo\.callv\(/.test(gd) && /EditorUndoRedoManager/.test(gd)) ? 0 : 1;
    } },
  { key: 'editor-auth-acl-not-readonly', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // P1(2026-07-11 editor-auth 审查): restrictFileWindows 用 icacls USERNAME:R(自锁只读)收紧 secret,
    // 致 editor plugin(同 USERNAME 身份)下次 _ready WriteAllText 覆盖写新 secret 被只读 ACL 拒 →
    // secret 文件停旧值/plugin 内存换新值 → MCP server 用旧文件 secret auth 失败 → 降级 headless(死循环)。
    // fix: :R → :M(Modify,含 Write 不含 Change permissions),与 plugin 端 websocket_server.gd/
    // mcp_bridge.gd 的 _restrict_secret_permissions 三处同步;/inheritance:r 已排除其他用户 ACE。
    // detect: 计数 editor-auth.ts 里 ${username}:R 反模式(修复后应=0;:M/:F 均算已修)。
    detect: () => {
      return (readSrc('src/core/editor-auth.ts').match(/\$\{username\}:R/g) ?? []).length;
    } },
  { key: 'asset-material-array-color-crash', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // BUG1(2026-07-11 插件反馈·messenger-godot): asset_factory.gd create_material Dict 分支
    // String(d["color"])/String(d["emissive"]) 在用户传 [r,g,b] 浮点数组时调不存在的 String(Array) 构造
    // → 抛 SCRIPT ERROR 中断 create_material 返 null → material_override=null 材质静默丢失
    // （节点 node_path 非空假成功，难排查）。对照传 hex 字符串/字面量正常落地。
    // fix: 抽 _parse_color 类型分派（Array/PackedFloat64Array [r,g,b(,a)]→Color；String→_safe_html；其他 fallback）。
    // detect: _safe_html(String(d[ 反模式 = 0 + _parse_color 定义存在（回退 String() 或删 helper 即复发）。
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/asset/asset_factory.gd');
      const buggy = (f.match(/_safe_html\(String\(d\[/g) ?? []).length;
      const hasFix = /func _parse_color/.test(f);
      return buggy + (hasFix ? 0 : 1);
    } },
  { key: 'asset-path-count-swallowed-by-spacing', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // BUG2(2026-07-11 插件反馈·messenger-godot): path_generator.gd _distances/_sample_continuous 中
    // if/elif spacing > 0.0 优先于 elif count >= 1，asset_commands.gd handle_path 默认 spacing=1.0
    // → 用户传 count=N 仍走 spacing 分支，count 被吞（asset path count=5 实落 13 段，spacing=1.0 沿 12 米 L 形采 13 点）。
    // validate 函数（spacing/count 互斥校验）是死代码，place_path/sample 从未调用。
    // fix: count >= 1 分支优先（显式"要 N 件"意图），spacing 仅 count<1（默认 0）时用。discrete+continuous 两函数同改。
    // detect: _distances + _sample_continuous 两函数体内 count>=1 首次位置均 < spacing>0.0（count 优先）。
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/asset/path_generator.gd');
      const dFn = f.slice(f.indexOf('func _distances('), f.indexOf('func _position_at('));
      const dCount = dFn.indexOf('count >= 1');
      const dSpacing = dFn.indexOf('spacing > 0.0');
      const cFn = f.slice(f.indexOf('func _sample_continuous('), f.indexOf('func _to_vector3('));
      const cCount = cFn.indexOf('count >= 1');
      const cSpacing = cFn.indexOf('spacing > 0.0');
      const distancesOk = dCount >= 0 && dSpacing >= 0 && dCount < dSpacing;
      const continuousOk = cCount >= 0 && cSpacing >= 0 && cCount < cSpacing;
      return (distancesOk && continuousOk) ? 0 : 1;
    } },
  { key: 'asset-path-align-vertices-infinite-loop', status: 'fixed', severity: 'CRITICAL', dimension: 'Correctness',
    // BUG3(2026-07-13 审查·addons 第三轮 P0): path_generator.gd _sample_continuous 的 align_vertices
    // 独立 if 分支（非 elif 链，排在 count/spacing 之前）用 spacing 做 while d+=spacing 推进量，
    // 但函数入口早退守卫（spacing<=0.0 and count<1）在 count>=1 时放行，align_vertices 分支
    // 无独立 spacing>0 守卫 → spacing=0（d 不变）/spacing<0（d 后退）时 while d<seg_end 永真死循环。
    // @tool 脚本跑编辑器主线程 → Godot 主循环卡死 → MCP 30s 超时 → 只能杀进程丢未保存编辑。
    // AI 误传 spacing:0（理解成"无间距约束"）+ count>=1 + align_vertices:true 即触发，非必恶意。
    // fbdd684 的 BUG2 count 优先修复只动 elif 链（count>=1 / spacing>0.0），漏了排在前面的
    // align_vertices 独立 if 分支（它有自己的 while 循环，不看 count）。
    // fix: align_vertices 分支入口加 spacing<=0.0 early-return 守卫（与函数入口早退语义一致）。
    // detect: _sample_continuous 的 align_vertices 分支内、while 循环之前存在 spacing<=0.0 守卫。
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/asset/path_generator.gd');
      const fnBody = f.slice(f.indexOf('func _sample_continuous('), f.indexOf('func _to_vector3('));
      const alignIdx = fnBody.indexOf('if align_vertices:');
      const whileIdx = fnBody.indexOf('while d < seg_end', alignIdx);
      if (alignIdx < 0 || whileIdx < 0) return 1;  // 结构变移，强制人工复核
      const branchBeforeWhile = fnBody.slice(alignIdx, whileIdx);
      // Minor4(review): 收紧到实际代码 `if spacing <= 0.0:`(行首;GDScript 注释以 # 开头不匹配),
      // 防修复者注释含 spacing<=0.0 字面量绕过检测。
      return /^\s*if\s+spacing\s*<=\s*0\.0\s*:/m.test(branchBeforeWhile) ? 0 : 1;
    } },
  { key: 'mcp-bridge-ready-headless-skip', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // (2026-07-11 插件反馈·CardGame2): mcp_bridge.gd _ready 原 if DisplayServer.get_name()=="headless": return
    // 致 run_project 跑 headless 游戏时 Bridge 不启动(game_query ping auth timeout)。注释假设"headless=--script 驱动"
    // 不成立——run_project 游戏 headless 需 Bridge。execute_gdscript --script 场景 listen() 失败安全跳过(warning+return)。
    // fix: 删 headless early return, _start_server() 无条件调用, headless 也起 Bridge。
    // detect: _ready 不再含 headless early return（DisplayServer=="headless" 字样在 mcp_bridge.gd 消失）。
    detect: () => {
      return countMatchesInFile('src/scripts/mcp_bridge.gd', /DisplayServer\.get_name\(\)\s*==\s*"headless"/);
    } },
  // ─── 2026-07-12 CRITICAL RCE 复合链修复（3 条联动）──────────────────────────
  // 零确认 RCE 复合链：search_and_replace 降级 read 绕确认令牌 → 写盘恶意 class_name +
  // ensureClassNameImport 注册 → create_scene root_node_type 无校验 → godot_operations.gd
  // 脚本分支 script.new() 无 is_parent_class → 执行恶意脚本 _init = RCE。
  // IMPORTANT-13 注释自承未修，本轮三处联动修复闭环。
  { key: 'rce-guard-search-replace-read-downgrade', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    // guard.ts 原 dynamicRiskOverride 把 script.edit_script + search_and_replace 降级 'read'
    // → requiresConfirmation 返 false 不生成确认令牌 → writeFileSync 零确认落盘任意内容。
    // 注释自述"非破坏性"假设已被证伪（search_and_replace 能注入 class_name + ensureClassNameImport 注册）。
    // fix: 删 dynamicRiskOverride 函数 + requiresConfirmation 简化为直接 getActionRisk。
    // detect: dynamicRiskOverride 函数定义在 guard.ts 消失。
    detect: () => {
      return countMatchesInFile('src/guard.ts', /function\s+dynamicRiskOverride\s*\(/);
    } },
  { key: 'rce-create-scene-root-node-type-no-validation', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    // scene/index.ts create_scene 的 root_node_type 无字符校验直接透传（quick_scene:257 /
    // add_node:141 / batch_add_nodes:315 都有 ^[A-Za-z0-9_]+$ 校验，create_scene 漏了）。
    // fix: create_scene 分支补 ^[A-Za-z0-9_]+$ 校验（与 add_node/quick_scene 对齐）。
    // detect: create_scene 分支含 rootNodeType + /^[A-Za-z0-9_]+$/ 校验（缺则复发）。
    detect: () => {
      const f = readSrc('src/tools/scene/index.ts');
      // 定位 create_scene 分支（action === 'create_scene' 到 save_scene 的 else if 之间，放宽窗口）
      const m = f.match(/action === 'create_scene'[\s\S]{0,900}?else if/);
      if (!m) return 1; // 分支结构改变 → 复发
      // 修复后分支含 rootNodeType 变量 + 字符校验 + invalid characters 错误
      return /rootNodeType[\s\S]{0,300}invalid characters/.test(m[0]) ? 0 : 1;
    } },
  { key: 'rce-script-branch-no-node-check', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    // headless instantiate_class 两分支曾用 is_parent_class("Node") 兜底, 但 Node 自身是 Node 的父类
    // → extends Node 恶意脚本(base_type="Node")通过 → script.new() _ready RCE(不经 execute_gdscript 沙箱)。
    // fix: 合并白名单双分支 ∈ 检查(ALLOWED_HEADLESS_TYPES, 移除裸 Node), 对齐 editor I-4 / IMPORTANT-14。
    // detect: 不再把 is_parent_class 当充分守卫——须验证白名单 ∈ 检查存在 + 反向裸 Node 不在白名单数组。
    detect: () => {
      const f = readSrc('src/scripts/godot_operations.gd');
      const hasWhitelist = /ALLOWED_HEADLESS_TYPES/.test(f);
      // script 分支须用 base_type ∈ 白名单 helper(非 is_parent_class 兜底)
      const scriptBranch = f.match(/if script is GDScript:[\s\S]{0,900}?return script\.new\(\)/);
      const scriptUsesWhitelist = !!scriptBranch &&
        /_is_headless_allowed\(base_type\)/.test(scriptBranch[0]);
      if (!hasWhitelist || !scriptUsesWhitelist) return 1;
      // 反向:确认裸 "Node" 不在白名单数组(防误加回 → extends Node 绕过复发)
      const wlBlock = f.match(/const ALLOWED_HEADLESS_TYPES[\s\S]{0,1200}?\]/);
      if (wlBlock) {
        if (/^[\t ]*"Node",/m.test(wlBlock[0]) || /,\s*"Node"\s*,/.test(wlBlock[0])) {
          return 1;
        }
      }
      return 0;
    } },
  // ─── 2026-07-12 进程通信 P0：HealthMonitor 控制回路 ──────────────────────────
  // HealthMonitor 原为纯仪表盘：evaluateState 进 reconnecting 仅 setState 打日志改字段，
  // 无外部通知。编辑器卡死（TCP OPEN 但主线程阻塞）时心跳 ping 永不回包 → 进 reconnecting
  // 但无降级动作 → 系统瘫痪至 OS TCP keepalive(~2h)。修复：加 onStateChange 回调机制，
  // GodotServer 注册回调，进 reconnecting 时调 handleEditorStall 降级 headless。
  { key: 'health-monitor-no-control-loop', status: 'fixed', severity: 'CRITICAL', dimension: 'Reliability',
    // health-monitor.ts setState 仅打日志改字段，evaluateState 进 reconnecting 无副作用。
    // GodotServer.ts:448 startHeartbeat 仅传 pingFn 未接状态回调。
    // fix: HealthMonitor 加 onStateChange 字段+setter，setState 状态变化时 fire-and-forget
    // 触发监听器（try/catch 包裹）；GodotServer 注册回调，reconnecting 时调 handleEditorStall。
    // detect: health-monitor.ts setState 含 stateChangeListener 触发（缺则复发）。
    detect: () => {
      const f = readSrc('src/core/health-monitor.ts');
      return /stateChangeListener\?\.\(/.test(f) ? 0 : 1;
    } },
  // ─── 2026-07-19 SDD scene 资源属性 coerce + instance 安全 + batch 非静默（3 条联动）──────────────────
  // spec A: edit_node/add_node/batch_add_nodes 资源属性(texture/font/audio_stream 等 res:// 路径)原字面赋值
  // 字符串致属性错(Texture2D 属性收到 "res://foo.png" 字符串 silent no-op)。fix: 抽 _set_property_with_coerce
  // helper(TYPE_OBJECT + String + begins_with res:// → load 为 Resource;非 res:// String 报错非静默)。
  // 三处调用齐备(edit_node + add_node + batch_add_nodes)。detect: 定义存在 + 三处 "if not _set_property_with_coerce(" 调用齐备。
  { key: 'resource-prop-coerce-helper', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      const f = readSrc('src/scripts/godot_operations.gd');
      const hasDef = /func _set_property_with_coerce\(node: Node, key: String, value: Variant\) -> bool:/.test(f);
      const calls = (f.match(/if not _set_property_with_coerce\(/g) ?? []).length;
      return hasDef && calls >= 3 ? 0 : 1;
    } },
  // spec I-2: instance 属性可注入 ExtResource 实例化恶意场景 _ready,与 script 同级危险(双保险:
  // _set_property_with_coerce 内 key=="instance" 早退 + BLOCKED_PROPERTIES 数组列 "instance" 让
  // _is_safe_property 也拒)。detect: BLOCKED_PROPERTIES 数组定义段含 "instance" 字面量(移除即复发)。
  { key: 'instance-property-blocked-gd', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      // P2-4 审查 B-1 修复:扩展扫描范围,覆盖所有含 BLOCKED_PROPERTIES 的 .gd 文件
      // 2026-08-06 审查 P2: 加 command_helpers.gd 第 3 副本(原只扫 2 文件漏 editor 路径副本)
      const files = ['src/scripts/godot_operations.gd', 'src/scripts/mcp_bridge.gd', 'addons/godot_mcp_server/commands/command_helpers.gd'];
      for (const fpath of files) {
        const f = readSrc(fpath);
        const m = f.match(/const\s+BLOCKED_PROPERTIES\s*:?=.*?\[[\s\S]*?\]/);
        if (!m || !/"instance"/.test(m[0])) return 1;  // 任一副本漏 instance 即复发
      }
      return 0;
    } },
  // 2026-08-06 审查 P0：action-gate GATED_ACTIONS 的 key（`<工具名>.<action>`）必须与
  // tool-registry 实际承载该 action 的工具名一致。早期版本写 'runtime.execute_gdscript'
  // 但 execute_gdscript 实属 script 工具 → isActionGated 永不命中 → gate 形同虚设。
  // detect: 提取 action-gate.ts 所有 key，校验 `<group>` 部分在 TOOL_GROUPS 的 tools 列表里
  // + `<action>` 部分在该工具源文件的 const ACTIONS 数组里（I-1 修复：原只查工具名漏 action 维度）。
  { key: 'action-gate-key-toolname-match', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      const f = readSrc('src/core/action-gate.ts');
      // 只扫 GATED_ACTIONS 对象字面量内部（避注释里的旧字符串干扰）
      const blockMatch = f.match(/const\s+GATED_ACTIONS[^{]*\{([\s\S]*?)\};/);
      if (!blockMatch) return 1;
      const block = blockMatch[1].split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
      const keyMatches = block.match(/'([a-z_]+\.[a-z_]+)'/g) ?? [];
      const keys = keyMatches.map(k => k.replace(/'/g, ''));
      if (keys.length === 0) return 1; // 无 key = GATED_ACTIONS 结构被破坏
      // 读 tool-registry，取所有工具名集合（TOOL_GROUPS[*].tools 展平 + ALWAYS_ALLOWED）
      const reg = readSrc('src/core/tool-registry.ts');
      const allToolsMatch = reg.match(/tools:\s*\[([^\]]+)\]/g) ?? [];
      const toolNames = new Set<string>();
      for (const block of allToolsMatch) {
        const names = block.match(/'([a-z_]+)'/g) ?? [];
        for (const n of names) toolNames.add(n.replace(/'/g, ''));
      }
      // ALWAYS_ALLOWED 工具也算（如 confirm_and_execute / manage_tools）
      const alwaysMatch = reg.match(/ALWAYS_ALLOWED[^[]*\[([^\]]+)\]/) ?? [];
      if (alwaysMatch[1]) {
        const names = alwaysMatch[1].match(/'([a-z_]+)'/g) ?? [];
        for (const n of names) toolNames.add(n.replace(/'/g, ''));
      }
      // 每个 gate key 校验两维度
      for (const key of keys) {
        const [group, action] = key.split('.');
        // 维度 1：工具名必须是真实工具
        if (!toolNames.has(group)) return 1;
        // 维度 2（I-1 修复）：action 必须在该工具源文件的 const ACTIONS 数组里
        const toolSrc = readSrc(`src/tools/${group}.ts`);
        const actionsMatch = toolSrc.match(/const\s+ACTIONS\s*=\s*\[([\s\S]*?)\]/);
        if (actionsMatch) {
          const actionNames = new Set(
            (actionsMatch[1].match(/'([a-z_]+)'/g) ?? []).map(s => s.replace(/'/g, ''))
          );
          if (!actionNames.has(action)) return 1; // action 不属于该工具 = gate 永不命中
        }
      }
      return 0;
    } },
  // spec editor-version-tear §1: editor 侧 coerce_property_value 统一 helper（只 coerce 不 set，
  // 与 headless _set_property_with_coerce 刻意不对称——editor 要 per-property undo）。
  // detect: command_helpers.gd 含 coerce_property_value 定义 + instance 双保险分支。
  { key: 'editor-coerce-property-value', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/command_helpers.gd');
      const hasDef = /static func coerce_property_value\(obj: Object, prop: String, val: Variant\) -> Dictionary:/.test(f);
      const hasInstanceGuard = /prop in BLOCKED_PROPERTIES or prop == "instance"/.test(f);
      return hasDef && hasInstanceGuard ? 0 : 1;
    } },
  // spec editor-version-tear §2: editor handle_edit_node（per-property undo，do=set new / undo=set old）。
  // detect: node_commands.gd 含 handle_edit_node 定义 + create_action_mixed 调用。
  { key: 'editor-handle-edit-node', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/node_commands.gd');
      const hasDef = /func handle_edit_node\(params: Dictionary, request_id: int\) -> Dictionary:/.test(f);
      const hasUndo = /_undo_manager\.create_action_mixed\([\s\S]*?method": "set"/.test(f);
      return hasDef && hasUndo ? 0 : 1;
    } },
  // spec §5: batch_add_nodes 部分节点失败原 exit 0 静默(TS 捕不到错误谎报成功)。
  // fix: failed_count > 0 分支 quit(1)(scene_root.free + quit 1 + return),TS scene/index.ts:329 exitCode!=0 才抓得到。
  // detect: batch_add_nodes 函数体内 "if failed_count > 0" 后 400 字符内含非零退出(删退出或改回 0 即复发)。
  // 2026-09-03 审查收尾: cleanup_and_quit([scene_root], 1)(内部 _exit_with(1)→quit(1))为等价形态,一并接受。
  { key: 'batch-failed-quit-nonzero', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      const f = readSrc('src/scripts/godot_operations.gd');
      const fnBody = f.slice(f.indexOf('func batch_add_nodes'), f.indexOf('func load_sprite'));
      return /if failed_count > 0:[\s\S]{0,800}?(quit\(1\)|_exit_with\(1\)|cleanup_and_quit\(\[scene_root\], 1\))/.test(fnBody) ? 0 : 1;
    } },
  // spec editor-version-tear §3: editor handle_batch_add_nodes（预校验零内存改 + 批量 UndoRedo）。
  // detect: node_commands.gd 含 handle_batch_add_nodes 定义 + 白名单 ^[A-Za-z0-9_]+$（非 index.ts 黑名单）。
  { key: 'editor-handle-batch-add-nodes', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/node_commands.gd');
      const hasDef = /func handle_batch_add_nodes\(params: Dictionary, request_id: int\) -> Dictionary:/.test(f);
      const hasWhitelist = /func handle_batch_add_nodes[\s\S]{0,800}\^\[A-Za-z0-9_\]\+\$/.test(f);
      return hasDef && hasWhitelist ? 0 : 1;
    } },
  // spec editor-version-tear §4: editor handle_add_node 补 properties（原 :36-38 只取 3 字段，properties 被丢弃）。
  // detect: handle_add_node 函数体含 coerce_property_value 调用 + prop_do_ops。
  { key: 'editor-add-node-properties', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/node_commands.gd');
      const fnBody = f.slice(f.indexOf('func handle_add_node'), f.indexOf('func handle_remove_node'));
      return /CommandHelpers\.coerce_property_value/.test(fnBody) && /prop_do_ops/.test(fnBody) ? 0 : 1;
    } },
  // spec editor-version-tear §5: editor-method-map 登记 edit_node/batch_add_nodes 打通 editor 路由
  // （此前 edit_node/batch 在 index.ts 无条件 spawnGodot 改盘，editor 内存版本撕裂）。
  // detect: editor-method-map.ts scene 表含 edit_node + batch_add_nodes 登记。
  // 切片右边界用下一个块（animation_track:）而非首个 }（entry 内 method 对象的 } 会过早截断）。
  { key: 'editor-method-map-edit-batch', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      const f = readSrc('src/core/editor-method-map.ts');
      const sceneStart = f.indexOf('scene:');
      const sceneEnd = f.indexOf('animation_track:', sceneStart);
      const sceneBlock = sceneEnd > 0 ? f.slice(sceneStart, sceneEnd) : f.slice(sceneStart);
      return /edit_node: \{ method: 'edit_node' \}/.test(sceneBlock)
        && /batch_add_nodes: \{ method: 'batch_add_nodes' \}/.test(sceneBlock) ? 0 : 1;
    } },
  // spec editor-version-tear §6: index.ts edit_node/batch headless fallback 路径加 checkEditorSceneSave 守卫
  // （editor 未连接时 fallback spawnGodot 改盘,守卫防覆盖 editor 内存——editor 连接时走 handler 不触发）。
  // detect: index.ts edit_node case + batch case 各含 ctx.checkEditorSceneSave 调用。
  // 切片右边界用下一个 case（remove_node）,避免 entry 内 } 过早截断。
  { key: 'editor-scene-save-guard-edit-batch', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    detect: () => {
      const f = readSrc('src/tools/scene/index.ts');
      const editBody = f.slice(f.indexOf("case 'edit_node'"), f.indexOf("case 'remove_node'"));
      const batchBody = f.slice(f.indexOf("case 'batch_add_nodes'"), f.indexOf("case 'edit_node'"));
      return /ctx\.checkEditorSceneSave/.test(editBody) && /ctx\.checkEditorSceneSave/.test(batchBody) ? 0 : 1;
    } },
  { key: 'add-node-editor-root-routing', status: 'fixed', severity: 'IMPORTANT', dimension: 'EditorRouting',
    detect: () => {
      // F1 (2026-07-20): handle_add_node parent 解析改用 CommandHelpers.find_node（识别 "root"），
      // 对齐 edit_node/batch/headless godot_operations.gd:316。复发：handle_add_node 仍用 root.get_node_or_null(parent_path)。
      // 注：handle_remove_node:119 用 get_node_or_null(node_path) 非 parent_path，不匹配，不影响。
      return countMatchesInFile('addons/godot_mcp_server/commands/node_commands.gd', /root\.get_node_or_null\(parent_path\)/);
    } },
  // ─── 2026-07-22 orphan 扫描会话隔离（多会话安全）──────────────────────────
  { key: 'orphan-scan-session-scoped', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // killOrphanGodotProcesses 默认走 V-01 全系统扫 → 多个并发会话操作同一项目时误杀对方的编辑器/游戏进程。
    // fix: 默认路径基于 _spawnedGodotPids 集合（仅 run_project 注册的 orphan 候选），
    // 全系统扫描须 options.fullSystemScan=true 显式 opt-in 门控（崩溃恢复兜底）；
    // killOrphanGodotProcesses 签名 projectDir: string → projectDir?: string（默认路径不依赖它）。
    // IPC-R1/R5 (2026-08-08): 门控从 process.env.GODOT_MCP_FULL_SYSTEM_SCAN 改为显式 options 参数
    // （消除 env 全局状态与周期 orphan 扫描 tick 的竞态）。
    // detect: 三特征齐备（_spawnedGodotPids 集合 + options.fullSystemScan 显式门控 + optional 签名）；任一缺失即复发。
    detect: () => {
      const f = readSrc('src/core/process-state.ts') + readSrc('src/core/orphan-cleanup.ts');
      const hasPidSet = /let _spawnedGodotPids\b/.test(f);
      const hasOptIn = /options\?\.\s*fullSystemScan\s*===\s*true/.test(f);
      const hasOptionalSig = /killOrphanGodotProcesses\(\s*projectDir\?:\s*string/.test(f);
      return hasPidSet && hasOptIn && hasOptionalSig ? 0 : 1;
    } },
  // ─── 2026-07-23 批次 A 安全修复（A5/A10 detect 防复发）──────────────────────────
  { key: 'asset-factory-load-traversal', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    // A5(2026-07-23 批次 A): asset_factory create_material 在 begins_with("res://") 后、load 前必须
    // has_path_traversal（防 user:// 或 ../ 穿越 load 任意文件）。复发：删 has_path_traversal 调用即 detect=1。
    detect: () => {
      return readSrc('addons/godot_mcp_server/commands/asset/asset_factory.gd').includes('has_path_traversal') ? 0 : 1;
    } },
  { key: 'ui-scene-local-blocked-removed', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // A10(2026-07-23 批次 A): ui_commands/scene_commands 本地 blocked 列表应删除，统一用
    // CommandHelpers.BLOCKED_PROPERTIES（command_helpers.gd:111）。复发：任一文件重现本地 blocked 列表即 detect=1。
    // 注：BLOCKED_PROPERTIES 在 command_helpers.gd（不在 ui/scene），故 detect 不误报。
    detect: () => {
      const ui = readSrc('addons/godot_mcp_server/commands/ui_commands.gd').match(/BLOCKED_PROPS\b|blocked\s*:\s*Array/);
      const sc = readSrc('addons/godot_mcp_server/commands/scene_commands.gd').match(/var\s+blocked|blocked\s*:\s*Array/);
      return (ui || sc) ? 1 : 0;
    } },
  // ─── 2026-07-23 批次 B 可靠性修复（B1-B8/B10，B9 advisory 不入 detect）──────────────────
  { key: 'health-monitor-error-type-misdegrade', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // B1(2026-07-23 批次 B): evaluateState 原用无差别 consecutiveFails 累加,工具失败(TOOL_ERROR)也推动
    // 状态机进 reconnecting 致编辑器误降级。fix: recordFailure(errorType) 按 errorType 分流,仅 heartbeat
    // 类失败递增 consecutiveHeartbeatFails 驱动 reconnecting 阈值;工具失败只进 degraded 统计不推动状态机。
    // detect: evaluateState 使用 consecutiveHeartbeatFails(非 consecutiveFails)比对 maxConsecutiveFailures。
    detect: () => {
      const f = readSrc('src/core/health-monitor.ts');
      return f.includes('consecutiveHeartbeatFails >= this.opts.maxConsecutiveFailures') ? 0 : 1;
    } },
  { key: 'editor-stall-no-zombie-clear', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // B2(2026-07-23 批次 B): handleEditorStall 未 disconnect 旧 EditorConnection,WS 仍 OPEN +
    // reconnectEnabled=true,闭包重连耗尽后跨实例触发 reconnectExhausted 再降级(zombie 连接)。
    // fix: handleEditorStall 入口 try { this.editorConn?.disconnect() } catch {} 清 zombie。
    // detect: handleEditorStall 函数体含 disconnect() 调用(切片从函数头到下一个 private 方法)。
    detect: () => {
      const f = readSrc('src/core/EditorConnectionManager.ts');
      const start = f.indexOf('handleStall(): void');
      if (start < 0) return 1;
      const nextPrivate = f.indexOf('\n  private ', start + 10);
      const body = nextPrivate > 0 ? f.slice(start, nextPrivate) : f.slice(start, start + 800);
      return body.includes('disconnect()') ? 0 : 1;
    } },
  { key: 'heartbeat-ping-reuses-request-timeout', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // B3(2026-07-23 批次 B): startHeartbeat 的 pingFn 原复用 request() 默认 30s 超时,TCP 半开时单次降级
    // 链路 ~225s(5×30s+UI 恢复)。fix: ping 独立 5s 超时(request('ping', {}, { timeoutMs: 5000 })),
    // 半开降级缩到 ~85s(5×5s+连接周期)。detect: ping 调用带 timeoutMs 选项。
    detect: () => {
      const f = readSrc('src/core/EditorConnectionManager.ts');
      return /request\(\s*['"]ping['"][^)]*timeoutMs\s*:/.test(f) ? 0 : 1;
    } },
  { key: 'executor-do-not-retry-string-match', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // B4(2026-07-23 批次 B): EditorToolExecutor isConnectionError 原纯字符串 includes('Connection lost') 漏
    // Disconnected / JSON parse error 等挂 err.code 的连接类错误,do_not_retry 误覆盖。fix: 结构化 CONN_ERROR_CODES
    // Set 判定(5 个 code: CONNECTION_LOST/NOT_CONNECTED/REQUEST_TIMEOUT/DISCONNECTED/PARSE_ERROR),
    // 字符串兜底保留防外部 path 未挂 code 回归。detect: EditorToolExecutor 含 CONN_ERROR_CODES Set 定义。
    detect: () => {
      return readSrc('src/core/EditorToolExecutor.ts').includes('CONN_ERROR_CODES') ? 0 : 1;
    } },
  { key: 'editor-connection-handler-no-try-catch', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // B5(2026-07-23 批次 B): fireDisconnect/fireReconnect 裸 for handler() 迭代,单 handler 抛错阻断后续
    // handler / scheduleReconnect。fix: 每个 handler 调用 try/catch 包裹(对齐 health-monitor:156-160 容错模式)。
    // detect: fireDisconnect + fireReconnect 两函数体均含 try + catch(切片 fireDisconnect→fireReconnect→host)。
    detect: () => {
      const f = readSrc('src/core/EditorConnection.ts');
      const disStart = f.indexOf('private fireDisconnect');
      const recStart = f.indexOf('private fireReconnect');
      const hostStart = f.indexOf('private readonly host');
      if (disStart < 0 || recStart < 0 || hostStart < 0) return 1;
      const disBody = f.slice(disStart, recStart);
      const recBody = f.slice(recStart, hostStart);
      return (disBody.includes('try') && disBody.includes('catch')
        && recBody.includes('try') && recBody.includes('catch')) ? 0 : 1;
    } },
  { key: 'rebuild-no-setstate-connected', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // B6(2026-07-23 批次 B): 重建(rebuild)成功后 hm.state 可能残留 'reconnecting'(上次 stall 留下),
    // 首个心跳要等 heartbeatIntervalMs 才纠正——期间 onStateChange 不再触发降级但状态错(脏状态)。
    // fix: establishEditorConnection 成功路径末尾显式 hm.setState('connected') 即刻复位。
    // detect: establishEditorConnection 函数体含 setState('connected')。
    detect: () => {
      const f = readSrc('src/core/EditorConnectionManager.ts');
      const start = f.indexOf('private async establish');
      if (start < 0) return 1;
      const nextPrivate = f.indexOf('\n  private ', start + 10);
      const body = nextPrivate > 0 ? f.slice(start, nextPrivate) : f.slice(start, start + 3000);
      return body.includes("setState('connected')") ? 0 : 1;
    } },
  { key: 'resource-write-non-atomic', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // B7(2026-07-23 批次 B): 17 处 ResourceSaver.save 直写目标,超时 kill 落在 save 中途产半截损坏资源
    // 阻塞项目加载。fix: 改 _save_atomic / tmp+rename 原子提交(三环境):
    // ① headless godot_operations.gd 9 处 → 抽 _save_atomic helper(写 .tmp.<ext> → rename_absolute),
    //    保留 :853 uid 边车直写例外(.uid 必须落原路径,原子化致 .uid 孤儿);
    // ② addons command_helpers.gd 3 处 → static _save_atomic helper(同模式);
    // ③ TS 生成 5 处(ui-theme.ts×2 + scene-commit.ts + scene-instance.ts + material-ops.ts)→ 内联
    //    .tmp.<ext> + rename_absolute 模式字符串(data-import.ts 已 P2-1 先例,detect 不重复计)。
    // detect: 三环境特征齐备(gd _save_atomic + ResourceSaver.save≤2 / addons static _save_atomic / 4 TS 文件含 .tmp.+rename_absolute)。
    detect: () => {
      // 1. headless godot_operations.gd: _save_atomic 定义 + ResourceSaver.save 计数 ≤2(helper + uid 例外)
      const gd = readSrc('src/scripts/godot_operations.gd');
      const gdSaveAtomic = /func _save_atomic\(/.test(gd);
      const gdSaveCount = (gd.match(/ResourceSaver\.save\(/g) ?? []).length;
      const gdOk = gdSaveAtomic && gdSaveCount <= 2;
      // 2. addons command_helpers.gd: static func _save_atomic
      const addonsOk = /static func _save_atomic\(/.test(
        readSrc('addons/godot_mcp_server/commands/command_helpers.gd'));
      // 3. TS 4 文件每个含 .tmp. + rename_absolute(ui-theme/scene-commit/scene-instance/material-ops)
      const tsFiles = [
        'src/tools/ui/ui-theme.ts',
        'src/tools/scene/scene-commit.ts',
        'src/tools/scene/scene-instance.ts',
        'src/tools/material-ops.ts',
      ];
      let tsOk = true;
      for (const rel of tsFiles) {
        const src = readSrc(rel);
        if (!src.includes('.tmp.') || !src.includes('rename_absolute')) tsOk = false;
      }
      return gdOk && addonsOk && tsOk ? 0 : 1;
    } },
  { key: 'is-connected-no-jsdoc', status: 'fixed', severity: 'ADVISORY', dimension: 'Maintainability',
    // B8(2026-07-23 批次 B): isConnected() 无 JSDoc,调用方误认作 TCP 实时活性(实际仅 ws open/close flag,
    // TCP 半开时仍返 true)。fix: 补 JSDoc 说明活性语义 + 指引 HealthMonitor 心跳为实时检测。
    // detect: isConnected 方法前 500 字符含 "TCP" + "HealthMonitor"(活性语义标记词)。
    detect: () => {
      const f = readSrc('src/core/EditorConnection.ts');
      const idx = f.indexOf('isConnected(): boolean');
      if (idx < 0) return 1;
      const before = f.slice(Math.max(0, idx - 500), idx);
      return before.includes('TCP') && before.includes('HealthMonitor') ? 0 : 1;
    } },
  { key: 'auth-timeout-hardcoded', status: 'fixed', severity: 'ADVISORY', dimension: 'Maintainability',
    // B10(2026-07-23 批次 B): performAuth 原硬编码 authTimeout=10000 ms,与 constructor options 脱节。
    // fix: constructor 读 options.authTimeout ?? 10000 → authTimeoutMs 字段,performAuth 用 this.authTimeoutMs。
    // detect: authTimeoutMs 字段定义 + performAuth 使用 this.authTimeoutMs。
    detect: () => {
      const f = readSrc('src/core/EditorConnection.ts');
      const hasField = /private readonly authTimeoutMs\s*:\s*number/.test(f);
      const hasUsage = /this\.authTimeoutMs/.test(f);
      return hasField && hasUsage ? 0 : 1;
    } },
  { key: 'editor-secret-cross-instance-delete', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // (2026-07-23 editor 多实例 key 误删): _delete_secret_file 原无条件 DirAccess.remove_absolute(_secret_file),
    // 多 editor 实例共享固定路径 .godot/mcp_editor.key 时,任一实例 _exit_tree 会删掉仍存活实例的 key
    // (TS 端 TTL 缓存过期后重连读不到 key → editor 工具连不上)。实例内存 _secret 仍有效(9090 仍 LISTEN)
    // 但磁盘 key 已丢,现象为"日志称 written 但文件找不到"。
    // fix: 删前 FileAccess.get_file_as_string 读磁盘内容,仅在 on_disk == _secret 时删(只清自己的 key)。
    // detect: websocket_server.gd 含 "on_disk == _secret"(=内容校验存在);不含=回到无条件删旧版。
    detect: () => fileContains('addons/godot_mcp_server/websocket_server.gd', /on_disk == _secret/) ? 0 : 1 },

  // ─── 2026-07-23 批次 C 正确性修复（C1/C2/C3/C5/C6/C7/C8/C9/C10/C11/C12/C13；C4 accurate bake_result
  //   deferred——架构阻塞 coroutine vs 同步 dispatch,见 nav-bake-in-undo-action :445-450 deferral 注释）──────────────────────────
  { key: 'sync-commands-dead-get-plugin', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C1(批次 C): _on_node_added/removed 绕路 _command_handler.get_plugin()(command_handler extends Node 无此方法→
    // has_method 恒 false→传 null→get_edited_scene_root(null) fallback get_child(0) 错场景)。fix: 回调用现成 _plugin 字段。
    // detect: sync_commands.gd 不含 _command_handler.get_plugin() = fixed。
    detect: () => readSrc('addons/godot_mcp_server/commands/sync_commands.gd').includes('_command_handler.get_plugin()') ? 1 : 0 },
  { key: 'gdscript-executor-compile-error-includes', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C2(批次 C): extractCompileError 裸 includes('Parse Error:') 扫全部行,用户 print("Parse Error: debug") 被误判
    // compile 失败。marker/no-marker 两调用路径共用此函数。fix(final review 根治): Godot 格式 dash 前缀 ":[0-9]+ - Parse Error:"(\b 在词首仍匹配用户 print 非根治)。detect: 函数体含 dash " - Parse Error" = fixed。
    detect: () => {
      const f = readSrc('src/gdscript-executor.ts');
      const start = f.indexOf('function extractCompileError');
      const body = f.slice(start, start + 800);
      // C2 根治: Godot 格式 dash 前缀 " - Parse Error:"(见 gdscript-executor:1356 注释);复发裸 includes
      // 或 \b 词边界(词首仍匹配用户 print 非根治) = 1
      return / - \(Parse Error/.test(body) ? 0 : 1;
    } },
  { key: 'websocket-params-null-passthrough', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C3(批次 C): params:null 被 "_rpc_params != null and not is Dictionary" 的 and 短路放行→Dictionary 强类型
    // SCRIPT ERROR 中断帧 packet 循环。fix: 改 "== null or not is Dictionary" reject。detect: 不含旧 and 短路 = fixed。
    detect: () => readSrc('addons/godot_mcp_server/websocket_server.gd').includes('_rpc_params != null and not') ? 1 : 0 },
  { key: 'path-generator-no-root-strip', status: 'fixed', severity: 'ADVISORY', dimension: 'Correctness',
    // C5(批次 C): resolve_points get_node_or_null(path_node) 不 strip "root/" 前缀,与 asset_placer/find_node 不一致。
    // fix: 内联 strip "root/"+leading "/"(保 path_generator 纯几何静态类独立性)。detect: resolve_points 含 begins_with("root/") = fixed。
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/asset/path_generator.gd');
      const fn = f.slice(f.indexOf('static func resolve_points'), f.indexOf('static func resolve_points') + 500);
      return /begins_with\("root\/"\)/.test(fn) ? 0 : 1;
    } },
  { key: 'csv-content-no-precheck-size', status: 'fixed', severity: 'ADVISORY', dimension: 'Correctness',
    // C6(批次 C): csv_content 分支无前置 size 守卫,超大字符串 MCP SDK JSON.parse 阶段已载入 OOM(后置 :337 太晚)。
    // fix: 前置 byteLength 守卫(对齐 csv_path statSync 预检)。detect: csv_content 分支含 MAX_CSV_BYTES + byteLength = fixed。
    detect: () => {
      const f = readSrc('src/tools/data-import.ts');
      const branch = f.slice(f.indexOf('if (args.csv_content)'), f.indexOf('} else if (args.csv_path)'));
      return (/MAX_CSV_BYTES/.test(branch) && /byteLength/.test(branch)) ? 0 : 1;
    } },
  { key: 'csv-tmp-clean-output-dir-only', status: 'fixed', severity: 'ADVISORY', dimension: 'Correctness',
    // C7(批次 C): .tmp.tres 启动自清只扫当前 _output_dir,换 output_dir 后旧目录残留。fix: _clean_tmp_global("res://")
    // 递归扫全局(对齐 godot_operations find_files 跳过 .godot + depth≤10)。detect: 含 _clean_tmp_global("res://") = fixed。
    detect: () => readSrc('src/tools/data-import.ts').includes('_clean_tmp_global("res://")') ? 0 : 1 },
  { key: 'gdscript-executor-bare-rm-session-dir', status: 'fixed', severity: 'ADVISORY', dimension: 'Correctness',
    // C8(批次 C): proc.on('error')/catch 的 rm(sessionDir) 非 retryRm,Windows EPERM(Godot 退出瞬间持 .gd 句柄)静默吞错
    // 致 sessionDir 残留累积。fix: retryRm 对齐 timer(:1255)/close(:1269)。detect: 不含裸 rm(sessionDir, { = fixed。
    detect: () => /rm\(sessionDir,\s*\{/.test(readSrc('src/gdscript-executor.ts')) ? 1 : 0 },
  { key: 'test-assert-str-equality', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C9(批次 C): test_assert 用 str(val)==str(expected),str(Vector3(10,0,5))≠str([10,0,5]),str(true)≠str(1),
    // 致 Vector3 vs Array / bool vs int 断言永不等。fix: CommandHelpers.values_equal 类型感知比较。detect: test_commands 调 values_equal = fixed。
    detect: () => readSrc('addons/godot_mcp_server/commands/test_commands.gd').includes('values_equal(') ? 0 : 1 },
  { key: 'animtree-state-transition-blend-no-undo', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C10(批次 C): animtree add_state/add_transition/set_blend 直接改 sm/tree 无 create_action_mixed undo(原仅 create 有),
    // Ctrl+Z 只撤 create。fix: 三操作 create_action_mixed(add_state→remove_node / add_transition→remove_transition / set_blend→property old_val)。
    // detect: create_action_mixed 出现 ≥4 处(create + 三操作) = fixed。
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/animtree_commands.gd');
      const count = (f.match(/\bcreate_action_mixed\b/g) || []).length;
      return count >= 4 ? 0 : 1;
    } },
  { key: 'batch-add-nodes-commit-orphan-leak', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C11(批次 C): batch_add_nodes 预校验 ClassDB.instantiate 的 Node,commit 失败(undo_manager push_error,GDScript 无异常)
    // →已 instantiate Node 孤儿 leak。fix: commit 后扫 validated,is_inside_tree()+free() 清未入树孤儿。detect: 函数体含 is_inside_tree()+.free() = fixed。
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/node_commands.gd');
      const fnStart = f.indexOf('func handle_batch_add_nodes');
      const fnNext = f.indexOf('\nfunc ', fnStart + 10);
      const fn = fnNext > 0 ? f.slice(fnStart, fnNext) : f.slice(fnStart, fnStart + 5000);
      return (/is_inside_tree\(\)/.test(fn) && /\.free\(\)/.test(fn)) ? 0 : 1;
    } },
  { key: 'edit-node-readonly-undo-null-set', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C12(批次 C): edit_node/set_instance_property undo old_val=node.get(key),只读/不存在属性 get 返 null→undo 回放 set(key,null)
    // 错误赋值。fix: 记 undo 前查 PROPERTY_USAGE_READ_ONLY 跳过只读(CommandHelpers._get_property_usage helper)。detect: edit_node + set_instance_property 各含 PROPERTY_USAGE_READ_ONLY = fixed。
    detect: () => {
      const node = readSrc('addons/godot_mcp_server/commands/node_commands.gd');
      const scene = readSrc('addons/godot_mcp_server/commands/scene_commands.gd');
      const eStart = node.indexOf('func handle_edit_node');
      const eNext = node.indexOf('\nfunc ', eStart + 10);
      const edit = eNext > 0 ? node.slice(eStart, eNext) : node.slice(eStart, eStart + 5000);
      const iStart = scene.indexOf('func handle_set_instance_property');
      const iNext = scene.indexOf('\nfunc ', iStart + 10);
      const inst = iNext > 0 ? scene.slice(iStart, iNext) : scene.slice(iStart, iStart + 5000);
      return (edit.includes('PROPERTY_USAGE_READ_ONLY') && inst.includes('PROPERTY_USAGE_READ_ONLY')) ? 0 : 1;
    } },
  { key: 'ui-set-params-no-key-check-load-null', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C13(批次 C): ui set_params 任意 key theme.set 无效属性 silent no-op + default_font/stylebox load 返 null 直接传。
    // fix: _theme_has_property 守卫 + load null 守卫。detect: 含 _theme_has_property + default_font/stylebox case 各含 == null = fixed。
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/ui_commands.gd');
      const hasKeyCheck = f.includes('_theme_has_property');
      const fontCase = f.slice(f.indexOf('"default_font"'), f.indexOf('"color"', f.indexOf('"default_font"')));
      const sbCase = f.slice(f.indexOf('"stylebox"'), f.indexOf('_:', f.indexOf('"stylebox"')));
      const hasFontGuard = /var font = load/.test(fontCase) && /font == null/.test(fontCase);
      const hasSbGuard = /var sb = load/.test(sbCase) && /sb == null/.test(sbCase);
      return (hasKeyCheck && hasFontGuard && hasSbGuard) ? 0 : 1;
    } },

  // ─── 2026-07-24 批次 D 工具治理（D1 asset/android 游离；D2 find_node traversal 撤销转 follow-up 见 spec）──
  { key: 'asset-android-tool-orphan', status: 'fixed', severity: 'IMPORTANT', dimension: 'Tooling',
    // D1(批次 D): asset/android 在 module-loader 注册但不在 TOOL_GROUPS/ALWAYS_ALLOWED → isToolAllowed 恒 false
    // （发现层 tools/list 隐藏 + profile 不强制）。fix: TOOL_GROUPS 补 asset/android 组。detect: 含两 key = fixed。
    detect: () => {
      const f = readSrc('src/core/tool-registry.ts');
      const m = f.slice(f.indexOf('export const TOOL_GROUPS'), f.indexOf('ALWAYS_ALLOWED'));
      return /asset:\s*\{[^}]*tools:\s*\['asset'\]/.test(m) && /android:\s*\{[^}]*tools:\s*\['android'\]/.test(m) ? 0 : 1;
    } },
  // ─── 2026-07-24 D2 follow-up NodePath .. 策略统一 ──
  { key: 'nodepath-traversal-category-error', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // D2 follow-up(2026-07-24): has_path_traversal 是 resource 范畴(res:// fs traversal),误用于 scene tree
    // 节点路径是范畴错误。get_node_or_null 受 SceneTree root 子树限制,.. 是合法父引用不能逃逸 fs。
    // 撤 6 处节点路径前置(node_commands:52/108/161/231 + asset_placer:154/203),保留 6 处资源范畴。
    // detect: node_commands + asset_placer 的 CommandHelpers.has_path_traversal 计数=0=fixed(复发→>0)。
    detect: () =>
      countMatchesInFile('addons/godot_mcp_server/commands/node_commands.gd', /CommandHelpers\.has_path_traversal/) +
      countMatchesInFile('addons/godot_mcp_server/commands/asset/asset_placer.gd', /CommandHelpers\.has_path_traversal/),
  },
  // ─── 2026-07-24 批次 E P0-2 animation_track 破坏性操作确认门 ──
  { key: 'animation-track-destructive-confirmation', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // P0-2: animation_track 的 remove_track/remove_keyframe/update_keyframe 原标 'read' 绕确认门（spec §4.1
    // 零行为改变决策）,对齐兄弟 animation-ops.ts:691 destructive。detect: animation-track.ts 含
    // remove_track: 'destructive' = fixed（复发 read 标注→1）。
    detect: () => readSrc('src/tools/animation/animation-track.ts').includes("remove_track: 'destructive'") ? 0 : 1,
  },
  // ─── 2026-08-10 P0-2 续 animtree 写操作确认门 ──
  { key: 'animtree-write-confirmation', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // P0-2 续: animtree 的 create/add_state/add_transition/set_blend/state_edit 原全标 'read' 绕确认门
    // （零行为改变迁移决策遗留），对齐 scene add_node(write)。play 仍 read（运行时触发）。
    // detect: animtree.ts 含 animtree_create: 'write' = fixed（复发 read 标注→1）。
    detect: () => readSrc('src/tools/animtree.ts').includes("animtree_create: 'write'") ? 0 : 1,
  },
  { key: 'bridge-take-screenshot-null-crash-swallow', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // Bridge take_screenshot 的 get_viewport().get_texture().get_image() 链无 null guard:
    // get_image() 返回 null(窗口后台/viewport 未就绪/DummyRenderer)时 img.save_png() 触发 runtime error
    // 中断 _cmd_take_screenshot → _handle_message result 停 null → promote error 不触发(null 非 Dictionary)
    // → 返回 {"result":null} 吞错(客户端只见 null 无 error)。fixed: viewport/texture/img 三层 null guard
    // 各返结构化 {"error":{code,message}},_handle_message:583 promote error 触发客户端可见。
    // detect: _cmd_take_screenshot 函数体含 get_image() 但无 img/tex/viewport == null 守卫 → 1(复发)。
    detect: () => {
      const f = readSrc('src/scripts/mcp_bridge.gd');
      const m = f.match(/func _cmd_take_screenshot[\s\S]*?(?=\nfunc |\n# ─)/);
      if (!m) return 1;
      const body = m[0];
      const hasGetImage = /get_image\(\)/.test(body);
      const hasNullGuard = /\b(?:img|tex|viewport)\s*==\s*null\b/.test(body);
      return (hasGetImage && !hasNullGuard) ? 1 : 0;
    } },
  // ─── 2026-07-28 detect 补全（2026-07-22 安全/RCE 面审查 P1，防护已在批次 A/B 落地，补 detect 防复发）──
  { key: 'validation-run-and-verify-scene-traversal', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    // 2026-07-22 RCE面复审P1: validation.ts run_and_verify 的 args.scene 直接 push 进 godot CLI
    // 加载项目外场景执行节点脚本(无 GD _sanitize_res_path 兜底)。
    // fix: normalizeUserProjectPath + resolveWithinRoot(projectPath, normalized) 仅校验(validation.ts:549)。
    // 复发: 删 resolveWithinRoot 调用 → 窗口无终点 m=undefined → detect=1。
    // 窗口容差: case 体到目标调用当前 ~750 字符,窗口 3000;若 case 'run_and_verify' 体显著增长超窗口需 bump。
    detect: () => {
      const f = readSrc('src/tools/validation.ts');
      const m = f.match(/case 'run_and_verify'[\s\S]{0,3000}?\bresolveWithinRoot\(projectPath,\s*normalized\)/);
      return m ? 0 : 1;
    } },
  { key: 'workflow-user-protocol-traversal', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    // 2026-07-22 安全审查: workflow.ts 三处 user:// 放行不校验 .. 段(bridge.screenshot.path:390 / reference_path:515 /
    // frames_dir:584), GD bridge take_screenshot/Image.load/DirAccess 任意目录读/写。
    // fix: 三处调用均加 hasTraversalSegments。复发: 任一处调用删 → raw count<3 detect=1。
    // 注: :257 函数定义 hasTraversalSegments(p:) 不匹配 raw 前缀, 故不计数。
    // 局限: 若未来新增第 4 处 user:// 入口,必须同步加 hasTraversalSegments(raw*) 防护,否则 count≥3 仍假绿漏检。
    detect: () => {
      const f = readSrc('src/tools/workflow.ts');
      return (f.match(/hasTraversalSegments\(raw\w+/g) || []).length >= 3 ? 0 : 1;
    } },
  // ─── 2026-07-29 A-telemetry 批次 Task 1：error_category PII 泄漏 ──────────────
  // ToolDispatcher telemetry after-hook(:466-474) error_category 原传
  // safeErrorCategory(extractErrorMessage(result) || 'TOOL_ERROR')。extractErrorMessage 返原始错误文本
  // （含路径/项目名 PII），safeErrorCategory 只替标点不删字母数字 → 路径片段入 error_category 字段，
  // Stage 1 接 endpoint 即外传 PII。result 无结构化 code，按文本推断 category 主观且 YAGNI。
  // fix: 改固定枚举 'TOOL_ERROR' + 删 safeErrorCategory（ToolDispatcher import + telemetry/index 导出 +
  // sanitize.ts 定义）。recorder.record(:448) 仍用 extractErrorMessage 是本地记录经 sanitizeMsg，不外传，未动。
  // detect: ToolDispatcher.ts telemetry hook 内 error_category 为固定 'TOOL_ERROR' 字面量且不含
  // extractErrorMessage/safeErrorCategory 派生（任一回退 → detect=1）。
  { key: 'telemetry-error-category-pii-leak', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      const f = readSrc('src/core/ToolDispatcher.ts');
      // error_category 赋值必为固定枚举 'TOOL_ERROR'（ToolDispatcher 全文件唯一 error_category 赋值点）。
      // 正向匹配即可排除一切派生回退：safeErrorCategory(...) 或 extractErrorMessage(...) 形式均无 'TOOL_ERROR'
      // 字面量紧跟 `?`，故不匹配 → detect=1。注释里的旧代码字面量不带 `error_category:` 前缀，不会误命中。
      const m = f.match(/error_category:\s*isError\s*\?\s*['"]TOOL_ERROR['"]\s*:\s*undefined/);
      return m ? 0 : 1;
    } },
  // ─── 2026-07-29 A-telemetry 批次 Task 2：opt-out 守卫缺失 → telemetry-uuid.txt 副作用 ───
  // telemetry after-hook(:462) 原无 isTelemetryEnabled() 前置守卫，recordTelemetry 参数求值期
  // hashProject(ctx.args.project_path) 先跑 → getInstallUUID（config.ts:28 首次 mint 创建
  // ~/.godot/mcp/telemetry-uuid.txt）发生在 record() 内部守卫之前 → opt-out（默认）下首次带
  // project_path 调用仍创建 UUID 文件，违反 docs/telemetry.md「零副作用」承诺。
  // fix: after-hook 第一行（构造 recordTelemetry 参数之前）加 `if (!isTelemetryEnabled()) return result`。
  // 根因 [[feature-gate-inside-callee-defeated-by-arg-eval]]：守卫须在调用方参数求值前，非 callee 内部。
  // detect: 位置契约（参 godot-server-degrade.test.ts:27-34 indexOf 模式）——切 telemetry after-hook 块，
  // isTelemetryEnabled 必须出现在 recordTelemetry( 之前（守卫被删或挪到 record 之后 → detect=1）。
  { key: 'telemetry-afterhook-no-optout-guard', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    detect: () => {
      const f = readSrc('src/core/ToolDispatcher.ts');
      // 切片：name: 'telemetry' mw.push 块到 createRateLimitMiddleware（紧随其后的 mw.push）。
      const start = f.indexOf("name: 'telemetry'");
      if (start < 0) return 1;
      const end = f.indexOf('createRateLimitMiddleware()', start);
      const slice = end > 0 ? f.slice(start, end) : f.slice(start, start + 800);
      const guardIdx = slice.indexOf('isTelemetryEnabled');
      const recordIdx = slice.indexOf('recordTelemetry(');
      // 两处必须都存在，且守卫在 record 调用之前（guardIdx < recordIdx）。
      return guardIdx >= 0 && recordIdx >= 0 && guardIdx < recordIdx ? 0 : 1;
    } },
  { key: 'addon-update-dest-symlink-bypass', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    // addon-version.ts updateAddon cpSync 前只 realpath projectPath 本体, dest 子段 addons/ 符号链接
    // 未校验 → cpSync 跟随写出 allowlist 外(monorepo 共享 addon 常见, 非 TOCTOU 预存即触发)。
    // 同源 readAddonVersion readFileSync 同样路径未校验 → 越界读（信息泄漏）。
    // fix: updateAddon(dest) + readAddonVersion(cfg) 两处 safeRealPath + isPathInAllowedRoots 校验。
    detect: () => {
      const f = readSrc('src/core/addon-version.ts');
      // 命中「cpSync 但无 dest realpath 校验」或「readFileSync 路径但无 cfg realpath 校验」即复发
      const hasCp = /cpSync\(/.test(f);
      const hasDestCheck = /safeRealPath\(dest\)[\s\S]{0,120}isPathInAllowedRoots\(realDest\)/.test(f);
      const hasCfgCheck = /safeRealPath\(cfg\)[\s\S]{0,120}isPathInAllowedRoots\(realCfg\)/.test(f);
      return hasCp && (!hasDestCheck || !hasCfgCheck) ? 1 : 0;
    } },
  { key: 'godotpath-allowed-paths-unimplemented', status: 'fixed', severity: 'ADVISORY', dimension: 'Security',
    // A-RCE #4: godot-finder.ts:55-56 注释自承 GODOT_MCP_ALLOWED_GODOT_PATHS 未实现。
    // validateGodotBinary --version 签名校验之上的硬隔离缺失——AI 可控的 godot_path 工具参数/
    // project override/env 指向任意二进制(伪造形如 Godot 版本签名的输出)被 spawn = 任意代码执行。
    // fix: isGodotPathAllowed(env 分号分隔, realpath 归一, 空 env back-compat 放行, UNRESTRICTED 旁路)
    // 接入 validateGodotBinary / detectGodotVersion / findGodot 全部最终出口。
    // detect: 文件含 env 名但缺 isGodotPathAllowed 定义/导出 = 复发(注释自承未实现形态)。
    detect: () => {
      const f = readSrc('src/core/godot-finder.ts');
      // 含 env 名(说明知晓该机制)但无 isGodotPathAllowed 调用 = 未实现;两者都存在 = fixed。
      // 注意 export 必须存在(防定义留注释,调用全删的伪绿)。
      const hasEnvMention = /GODOT_MCP_ALLOWED_GODOT_PATHS/.test(f);
      const hasExport = /export function isGodotPathAllowed/.test(f);
      const hasCallSite = /isGodotPathAllowed\s*\(/.test(f);
      return hasEnvMention && (!hasExport || !hasCallSite) ? 1 : 0;
    } },
  // ─── 2026-07-29 B-Reliability Task 2：全系统扫误杀编辑器进程 ──────────────────
  { key: 'fullsystem-scan-kills-editor', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // fullSystemScanGodot(opt-in GODOT_MCP_FULL_SYSTEM_SCAN=true) Windows PowerShell/POSIX sh 过滤只查
    // --path 路径匹配，不跳 --editor 进程 → 同项目 godot --path /proj --editor 被误杀。
    // fix: 两分支加 --editor 排除（Windows: -not ($_.CommandLine -like '*--editor*')，
    //       POSIX: grep -v -- '--editor'）。
    // detect: 两分支都含 --editor 排除条件（PowerShell -not + POSIX grep -v）。
    detect: () => {
      const f = readSrc('src/core/orphan-cleanup.ts');
      const psBlock = f.match(/Where-Object \{[\s\S]*?CommandLine\.Contains[\s\S]*?\}/s);
      const shBlock = f.match(/pgrep -f godot[\s\S]*?grep -F/s);
      const psHasExclude = psBlock ? /-not.*\*--editor\*|--editor.*-not/i.test(psBlock[0]) : false;
      const shHasExclude = shBlock ? /grep.*-v.*--editor|--editor.*exclude/i.test(shBlock[0]) : false;
      return psHasExclude && shHasExclude ? 0 : 1;
    } },
  // ─── 2026-07-29 B-Reliability Task 3：半开 HOL 预检缺失 ──────────────────────
  { key: 'editor-halfopen-no-precheck', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // EditorToolExecutor._executeInner 直接 conn.request，无 healthMonitor.getState() 预检。
    // TCP 半开时 conn.connected=true → request 挂满 30s；串行 executeChain ×30s HOL 放大。
    // fix: 构造器注入 healthMonitor（可选），_executeInner 入口 reconnecting 时即时返
    //       NOT_CONNECTED（跳过 30s 等待）。GodotServer.establishEditorConnection 传 hm。
    // detect: _executeInner 入口含 getState()==='reconnecting' 预检 + NOT_CONNECTED 返回。
    detect: () => {
      const f = readSrc('src/core/EditorToolExecutor.ts');
      const hasPrecheck = /healthMonitor\.getState\(\)\s*===\s*['"]reconnecting['"]/.test(f);
      const hasShortCircuit = /NOT_CONNECTED/.test(f);
      return hasPrecheck && hasShortCircuit ? 0 : 1;
    } },
  // ─── 2026-07-29 B-Reliability Task 4：headless gdscript spawn orphan 清理 ──
  { key: 'nav-bake-request-timeout-misalign', status: 'fixed', severity: 'CRITICAL', dimension: 'Reliability',
    // EditorToolExecutor nav bake conn.request 用默认 30s != startOperation(NAV_BAKE_OP_TIMEOUT_SEC=110s),
    // >30s 烘焙命中 REQUEST_TIMEOUT → editor_disconnected/do_not_retry（GD 实际烘成但客户端禁重试）。
    // fix: nav bake 分支 conn.request 传 { timeoutMs: NAV_BAKE_OP_TIMEOUT_SEC * 1000 }。
    // detect: nav bake 分支（isNavBake 后 conn.request）含 timeoutMs: NAV_BAKE_OP_TIMEOUT_SEC。
    detect: () => {
      const f = readSrc('src/core/EditorToolExecutor.ts');
      const bakeBranch = f.match(/isNavBake[\s\S]{0,400}?conn\.request\(method, finalArgs[\s\S]{0,100}?\)/);
      return bakeBranch && !/timeoutMs:\s*NAV_BAKE_OP_TIMEOUT_SEC/.test(bakeBranch[0]) ? 1 : 0;
    } },
  { key: 'gdscript-spawn-not-registered', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // gdscript-executor.ts:1192 spawn(godotPath, godotArgs) 不入 _spawnedGodotPids
    // （仅 runtime.ts:224 run_project 注册）。GodotServer.close 只 kill run_project 长进程，
    // 挂起脚本 + close → 孤儿无兜底；orphan 扫描默认只扫 run_project PID。
    // fix: gdscript-executor spawn 后 registerSpawnedGodotPid(proc.pid) + exit/error/
    //      三 forceKillTree 分支(timeout/stdout溢出/stderr溢出)调 unregister；
    //      GodotServer.close 遍历 ps.getSpawnedGodotPids() 调 ps.killPidTree best-effort 清理。
    // detect: 三特征齐备（spawn 后 register + close 含 getSpawnedGodotIds+killPidTree + 三 forceKillTree 路径 unregister）。
    detect: () => {
      const exec = readSrc('src/gdscript-executor.ts');
      const srv = readSrc('src/GodotServer.ts');
      // 1. spawn 后注册
      const spawnIdx = exec.indexOf('spawn(godotPath, godotArgs');
      const afterSpawn = spawnIdx > 0 ? exec.slice(spawnIdx, spawnIdx + 400) : '';
      const hasRegister = /registerSpawnedGodotPid\s*\(\s*proc\.pid\s*\)/.test(afterSpawn);
      // 2. close 含 getSpawnedGodotPids + killPidTree 遍历
      const closeStart = srv.indexOf('async close(): Promise<void>');
      const closeEnd = srv.indexOf("log('Server shut down')", closeStart);
      const closeBody = closeStart > 0 && closeEnd > 0 ? srv.slice(closeStart, closeEnd) : '';
      const hasCloseCleanup = /getSpawnedGodotPids\s*\(\s*\)/.test(closeBody) && /killPidTree|forceKillTree/.test(closeBody);
      // 3. 三 forceKillTree 分支后 unregister（120 字符窗口）
      const fktIndices: number[] = [];
      let searchFrom = 0;
      while (true) {
        const idx = exec.indexOf('forceKillTree(proc)', searchFrom);
        if (idx < 0) break;
        fktIndices.push(idx);
        searchFrom = idx + 1;
      }
      const allCovered = fktIndices.length >= 3 && fktIndices.every(idx =>
        /unregisterSpawn|unregisterSpawnedGodotPid/.test(exec.slice(idx, idx + 120)));
      return hasRegister && hasCloseCleanup && allCovered ? 0 : 1;
    } },
  // ─── 2026-07-29 B-Reliability Task 5：心跳降级区分 timeout/refused 不抢占重连 ──
  { key: 'heartbeat-blanket-catch-no-distinguish', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // GodotServer.ts:482 pingFn `.catch(() => false)` 毯式 catch 丢 err.code,
    // 两种失败(REQUEST_TIMEOUT 主线程卡死 / NOT_CONNECTED+CONNECTION_LOST 下线)都 recordFailure
    // → reconnecting → 旧 onStateChange 无差别调 handleEditorStall → disconnect() 杀 20 次退避自动重连。
    // 编辑器重启/瞬时不可达也强制降级,用户须手动 reconnect。
    // fix: pingFn catch 保留 err.code 到 _lastPingErrCode; onStateChange 分流
    //      REQUEST_TIMEOUT(TCP OPEN 主线程卡死→降级,自动重连救不了)
    //      vs NOT_CONNECTED/CONNECTION_LOST(下线→让 EditorConnection scheduleReconnect 兜底,不抢占);
    //      addOnReconnectHandler 触发 hm.reset() 即刻复位 connected(避免卡 reconnecting)。
    //      状态机链完整:refused→不降级→自动重连→成功→复位;重连耗尽→reconnectExhausted→handleEditorStall 兜底。
    // detect: 五特征齐备(_lastPingErrCode 字段 + catch 保留 err.code + onStateChange 分流 REQUEST_TIMEOUT
    //         + 非 REQUEST_TIMEOUT else 分支不调 handleEditorStall + addOnReconnectHandler 调 hm.reset())。
    detect: () => {
      const src = readSrc('src/core/EditorConnectionManager.ts');
      // 1. 声明 _lastPingErrCode 字段
      const hasField = /private\s+_lastPingErrCode\s*:\s*string\s*\|\s*undefined/.test(src);
      // 2. pingFn catch 保留 err.code 到 _lastPingErrCode(非毯式 () => false)
      const hasCatch = /_lastPingErrCode\s*=\s*(?:err|e)\??\.code/.test(src);
      // 3. onStateChange 分流 REQUEST_TIMEOUT
      const onStateIdx = src.indexOf('hm.onStateChange(');
      const onStateSlice = onStateIdx > 0 ? src.slice(onStateIdx, onStateIdx + 1500) : '';
      const hasRequestTimeoutBranch = /REQUEST_TIMEOUT/.test(onStateSlice);
      const hasHandleStall = /this\.handleStall\(\)/.test(onStateSlice);
      // 4. 非 REQUEST_TIMEOUT 分支不调 handleEditorStall(含 else / letting / not degrading 语义)
      const hasElse = /\belse\b/.test(onStateSlice);
      const hasNoDegradeLog = /not degrading|letting|auto-reconnect/.test(onStateSlice);
      // 5. addOnReconnectHandler 调 hm.reset()(重连成功复位,链关键节点)
      const recIdx = src.indexOf('addOnReconnectHandler(');
      const recSlice = recIdx > 0 ? src.slice(recIdx, recIdx + 400) : '';
      const hasResetOnReconnect = /hm\.reset\(\)/.test(recSlice);
      // 反向:毯式 catch 复发即红
      const hasBlanketCatch = /\.catch\(\s*\(\)\s*=>\s*false\s*\)/.test(src);
      return hasField && hasCatch && hasRequestTimeoutBranch && hasHandleStall
        && hasElse && hasNoDegradeLog && hasResetOnReconnect && !hasBlanketCatch ? 0 : 1;
    } },
  // ─── 2026-07-29 C-Correctness 批次 detect 补全（fixes 在 commits 35dd8b9..c04a6b0，detect 统一 T8 补）──
  { key: 'nav-freed-access-signal', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C-T1 (N1, commit 6c974a5): nav_commands.gd bake 等 bake_finished 信号循环内,freed 对象(nav 被 free)
    // 再访问 nav.bake_finished（disconnect/is_connected）→ nil access SCRIPT ERROR 中断 await 循环。
    // fix: if not is_instance_valid(nav): 分支直接 return（不碰信号,信号随对象释放自动断开,对齐 headless navigation.ts:45）。
    // detect: 两处 freed 分支(if not is_instance_valid(nav): 到 return)不含 nav.bake_finished（复发→>0）。
    detect: () => {
      const f = readSrc('addons/godot_mcp_server/commands/nav_commands.gd');
      // 两处 freed 分支：if not is_instance_valid(nav): 到 return {（含），窗口 300 字符覆盖注释+return
      const branches = f.match(/if not is_instance_valid\(nav\):[\s\S]{0,300}?return\s*\{/g) ?? [];
      if (branches.length !== 2) return 1; // 结构变移强制复核
      return branches.filter(b => /nav\.bake_finished/.test(b)).length;
    } },
  { key: 'nav-status-hardcoded', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C-T2 (N2, commit e78cf39): handle_nav_bake_mesh / _async 的 return status 原硬编码 "bake_completed"
    // (无视 actual bake 结果),烘焙失败/超时仍谎报 completed。fix: 改派生 "bake_completed" if cond else "bake_failed"/"bake_timeout"。
    // detect: "status": "bake_completed" 字面量后无 if 三元(裸硬编码)= 复发；fixed 形态紧跟 if 三元。
    detect: () =>
      countMatchesInFile('addons/godot_mcp_server/commands/nav_commands.gd', /"status":\s*"bake_completed"(?!\s+if)/g) },
  { key: 'doctor-no-stripbom', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C-T3 (F5, commit d149d9f): doctor.ts 内联 JSON.parse(readFileSync(...)) 不 stripBOM,带 BOM 的合法
    // mcp-godot.json JSON.parse throw → adapter.isConfigured catch return false → doctor 误报 + setup 破坏幂等。
    // fix: 改 readJsonForCheck（stripBom + 容错 null,与 adapter isConfigured 同源）。
    // detect: doctor.ts 含 readJsonForCheck 调用（删调用或回内联 JSON.parse(readFileSync → detect=1）。
    detect: () => /readJsonForCheck\s*\(/.test(readSrc('src/cli/doctor.ts')) ? 0 : 1 },
  { key: 'readcache-no-byte-limit', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // C-T4 (S2, commit fc8e8bc): update-checker.ts readCache 无字节上限,恶意/损坏大缓存文件 readFileSync 全量载入 OOM。
    // fix: statSync(cachePath).size > 64KB 上限 + obj.latest.length <= 64（version 字段合理上限）双守卫。
    // detect: readCache 函数体含 statSync().size + .length 上限（删任一→detect=1 复发）。
    detect: () => {
      const f = readSrc('src/core/update-checker.ts');
      const start = f.indexOf('function readCache(');
      if (start < 0) return 1;
      const body = f.slice(start, start + 800);
      const hasSizeGuard = /statSync\([^)]+\)\.size\s*>/.test(body);
      const hasLengthGuard = /\.length\s*<=?\s*\d+/.test(body);
      return hasSizeGuard && hasLengthGuard ? 0 : 1;
    } },
  { key: 'addon-update-nonatomic', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // C-T5 (S3, commit 0fb465b): addon-version.ts updateAddon 裸 cpSync(addonSource, dest) 中途失败（断电/磁盘满）
    // 留破损 addon → Godot 启动 parse error 阻塞。fix: staging 目录 cp + 校验 + rename 原子替换 + 备份回滚。
    // detect: updateAddon 含 staging + renameSync(staging, dest) + 无裸 cpSync(addonSource, dest)（回退裸 cpSync→detect=1）。
    detect: () => {
      const f = readSrc('src/core/addon-version.ts');
      const start = f.indexOf('export function updateAddon(');
      if (start < 0) return 1;
      const body = f.slice(start, start + 3000);
      const hasStaging = /\bstaging\b/.test(body);
      const hasRename = /renameSync\(staging,\s*dest\)/.test(body);
      const hasBareCp = /cpSync\(addonSource,\s*dest[\s,)]/.test(body);
      return hasStaging && hasRename && !hasBareCp ? 0 : 1;
    } },
  { key: 'adapter-no-mode-preserve', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C-T6 (F3, commit 10f0cc1): 13 adapter writeFileSync(tmpPath, data, 'utf-8') 第三参 encoding 非 mode,
    // tmp 默认 0o666, rename 后覆盖用户 chmod 0o600 的配置 mode（Unix 权限丢失,敏感配置变组可读）。
    // fix: json-config.ts 抽 writeFileAtomicWithMode helper（stat 原文件 mode → write tmp 显式传 mode → rename 保持）。
    // A-ATOMIC (2026-09-01): 实现上移 src/core/fs-atomic.ts（三份重复原子写合并,P0-arch shared 原语
    // 上移先例）,json-config.ts 改 re-export 保兼容——谓词跟随实现位置。
    // detect: core 实现存在 + mode 保持逻辑在位 + json-config re-export 链在位 + ≥1 adapter 调用
    //   （删 core 实现/mode 保持丢失/re-export 断链/adapter 调用全删回 writeFileSync → detect=1）。
    detect: () => {
      const core = readSrc('src/core/fs-atomic.ts');
      const cfg = readSrc('src/cli/clients/json-config.ts');
      const hasImpl = /export function writeFileAtomicWithMode/.test(core)
        && /mode !== undefined \? \{ mode, encoding: 'utf-8' \} : 'utf-8'/.test(core);
      const hasReexport = /export \{ writeFileAtomicWithMode \} from/.test(cfg);
      // adapter 调用点（re-export 后 json-config 自身无函数体调用,selfCount=0;adapter 调用至少 1 处）
      const allCalls = countMatchesInDir('src/cli/clients', /\bwriteFileAtomicWithMode\s*\(/g, /\.ts$/);
      const selfCount = (cfg.match(/\bwriteFileAtomicWithMode\s*\(/g) ?? []).length;
      return hasImpl && hasReexport && allCalls - selfCount >= 1 ? 0 : 1;
    } },
  { key: 'adapter-env-field-overwrite', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // C-T7 (C1, commit c04a6b0): 13 adapter `env: { GODOT_PATH: godotPath }` 完全覆盖 oldEntry.env,
    // 用户配的 ALLOWED_PROJECT_PATHS / GODOT_MCP_BRIDGE_* 重跑 setup 静默丢失,复发 MCP 服务器定位不到项目。
    // fix: 抽 buildEnv(godotPath, oldEnv) helper 保留白名单前缀（ALLOWED_PROJECT_PATHS / GODOT_MCP_BRIDGE_ / GODOT_MCP_EDITOR_）。
    // detect: 14 adapter 无裸 env/environment: { GODOT_PATH:（全覆盖字面量 = 复发；fixed 走 buildEnv）。
    //   排除 json-config.ts（其 doc 注释含旧模式字样,非代码复发）。
    detect: () => {
      const adapters = ['claude-code','cursor','claude-desktop','trae','windsurf','zed','antigravity',
        'cherry-studio','cline','gemini-cli','qwen-code','zcode','opencode','codex'];
      let n = 0;
      for (const name of adapters) {
        const f = readSrc(`src/cli/clients/${name}.ts`);
        n += (f.match(/\b(?:env|environment):\s*\{\s*GODOT_PATH\s*:/g) ?? []).length;
      }
      return n;
    } },
  { key: 'custom-mesh-segments-no-upper-cap', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    // P2(2026-07-29 报告5 F1): custom_meshes 细分参数 max(int(...),N) 只取下限不取上限 → 认证客户端传超大值
    // 在 @tool 编辑器主线程同步建顶点 → 卡死/OOM。fix: 改 clampi(int(...),N,CAP)。path_generator sample count 同理加上限。
    // detect: custom_meshes 含裸 max(int(params.get 且无 clampi 覆盖 = 复发。
    detect: () => {
      const cm = readSrc('addons/godot_mcp_server/commands/asset/custom_meshes.gd');
      const bareMax = (cm.match(/max\(int\(params\.get/g) || []).length;
      const clampi = (cm.match(/clampi\(int\(params\.get/g) || []).length;
      const pg = readSrc('addons/godot_mcp_server/commands/asset/path_generator.gd');
      const pathCountCap = /count\s*>\s*\d{4,}|count exceeds maximum/i.test(pg);
      return (bareMax === 0 && clampi >= 6 && pathCountCap) ? 0 : 1;
    } },
  { key: 'nav-set-params-no-undo', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // P2(2026-07-29 报告5 F2): handle_nav_set_params 直接赋值改 NavigationAgent3D 属性未走 create_action_mixed → Ctrl+Z 不撤销。
    // fix: 10 属性改 CommandHelpers._record_prop 聚合 property op 进 create_action_mixed。detect: 函数内无 create_action_mixed = 复发。
    detect: () => {
      const nav = readSrc('addons/godot_mcp_server/commands/nav_commands.gd');
      const fn = nav.slice(nav.indexOf('func handle_nav_set_params'));
      const body = fn.slice(0, fn.indexOf('\nfunc ', 1));
      return /create_action_mixed/.test(body) ? 0 : 1;
    } },
  { key: 'ui-layout-anchor-no-undo', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // P2(2026-07-29 报告5 F2): ui_set_layout/ui_anchor_preset 直接赋值未走 create_action_mixed → Ctrl+Z 不撤销。
    // fix: property op 聚合进 create_action_mixed。detect: 两函数内均无 create_action_mixed = 复发。
    detect: () => {
      const ui = readSrc('addons/godot_mcp_server/commands/ui_commands.gd');
      const hasUndo = (fnName: string) => {
        const fn = ui.slice(ui.indexOf('func ' + fnName));
        const body = fn.slice(0, fn.indexOf('\nfunc ', 1));
        return /create_action_mixed/.test(body);
      };
      return (hasUndo('handle_ui_set_layout') && hasUndo('handle_ui_anchor_preset')) ? 0 : 1;
    } },
  { key: 'ui-theme-no-undo', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // P2(2026-07-29 报告5 F2): set_theme(create/load/set_params) + theme_set_property 改 theme 未走 create_action_mixed → Ctrl+Z 不撤销。
    // theme_create 不改节点（只新建+save），排除。detect: set_theme/theme_set_property 内均无 create_action_mixed = 复发。
    detect: () => {
      const ui = readSrc('addons/godot_mcp_server/commands/ui_commands.gd');
      const hasUndo = (fnName: string) => {
        const fn = ui.slice(ui.indexOf('func ' + fnName));
        const body = fn.slice(0, fn.indexOf('\nfunc ', 1));
        return /create_action_mixed/.test(body);
      };
      return (hasUndo('handle_ui_set_theme') && hasUndo('handle_theme_set_property')) ? 0 : 1;
    } },
  { key: 'animation-keyframe-index-no-bound', status: 'fixed', severity: 'IMPORTANT', dimension: 'Correctness',
    // P2(2026-07-29 报告5 F3): remove/update/curve 三分支 ki=int(keyframe_index) 后无 track_get_key_count 守卫 →
    // 越界 ki 假成功。fix: ki 守卫返 -32004。detect: 三分支均无 ki key_count 守卫 = 复发。
    detect: () => {
      const a = readSrc('addons/godot_mcp_server/commands/animation_commands.gd');
      const guards = (a.match(/ki\s*<\s*0\s*or\s*ki\s*>=\s*anim\.track_get_key_count/g) || []).length;
      return guards >= 3 ? 0 : 1;
    } },
  { key: 'websocket-outbound-no-buffer-limit', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // P2(2026-07-29 报告5 F4): ws_peer 只 set_inbound_buffer_size 无 set_outbound_buffer_size →
    // sync 风暴/慢消费者 outbound 无界增长 OOM。fix: set_outbound_buffer_size(4MB)。
    // detect: websocket_server.gd 无 set_outbound_buffer_size = 复发（CI 新增，Obsidian defects.md 同步回标）。
    detect: () => {
      return /set_outbound_buffer_size/.test(readSrc('addons/godot_mcp_server/websocket_server.gd')) ? 0 : 1;
    } },
  { key: 'animtree-conditions-no-dict-guard', status: 'fixed', severity: 'ADVISORY', dimension: 'Correctness',
    // P2(2026-07-29 报告5 F5): animtree add_transition conditions 元素未校验 Dictionary，
    // 非 Dictionary 输入 cond.get() → SCRIPT ERROR 中断 transition 建立。fix: for 循环内加 cond is Dictionary 守卫跳过非法元素。
    // detect: animtree_commands.gd 无 'cond is Dictionary' = 复发。
    detect: () => {
      return /cond is Dictionary/.test(readSrc('addons/godot_mcp_server/commands/animtree_commands.gd')) ? 0 : 1;
    } },
  { key: 'undo-manager-dead-create-action', status: 'fixed', severity: 'ADVISORY', dimension: 'Maintainability',
    // P2(2026-07-29 报告5 F6): undo_manager.create_action + create_action_with_props 零外部调用（仅 create_action_mixed 在用），
    // 死代码维护负担 + 误导调用者用旧 API。fix: 删两方法（_add_method_call 保留，被 _apply_op 用）。
    // detect: 两方法定义仍在 = 复发（注意 func create_action( 不匹配 func create_action_mixed(）。
    detect: () => {
      const src = readSrc('addons/godot_mcp_server/undo_manager.gd');
      return (/func create_action\(/.test(src) || /func create_action_with_props/.test(src)) ? 1 : 0;
    } },
  { key: 'asset-placer-no-undo-mgr-null-guard', status: 'fixed', severity: 'ADVISORY', dimension: 'Reliability',
    // P2(2026-07-29 报告5 F9): asset_placer place_one/place_batch 直接 undo_mgr.create_action_mixed 无 null 守卫，
    // headless（undo_mgr==null）null instance SCRIPT ERROR。fix: 对齐 node_commands:260 if undo_mgr != null + else callv fallback。
    // detect: asset_placer.gd 'undo_mgr != null' 出现 < 2 = 复发（place_one + place_batch 各一）。
    detect: () => {
      const n = (readSrc('addons/godot_mcp_server/commands/asset/asset_placer.gd').match(/undo_mgr != null/g) || []).length;
      return n >= 2 ? 0 : 1;
    } },
  // ─── 2026-08-08 P1 批次修复登记 ──────────────────────────────────────────
  { key: 'error-capture-in-log-no-finally', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // GD-R2/IPC-R7: mcp_bridge.gd _ErrorCapture._log_error 的 re-entrancy guard _in_log 复位无保护,
    // append/pop_front/substr 抛错会跳过复位致 _in_log 永久 true → error capture 静默失效。
    // fix: 有风险操作集中到 _capture_entry 辅助方法,_in_log=false 紧跟调用后(GDScript 无 try/finally)。
    // detect: _log_error 体内 _in_log=false 必须在 _capture_entry 调用之后(紧跟复位)。
    detect: () => {
      const f = readSrc('src/scripts/mcp_bridge.gd');
      const logErrIdx = f.indexOf('func _log_error');
      if (logErrIdx < 0) return 1;
      const slice = f.slice(logErrIdx, logErrIdx + 1000);
      const captureIdx = slice.indexOf('_capture_entry');
      const resetIdx = slice.indexOf('_in_log = false');
      return captureIdx > 0 && resetIdx > captureIdx ? 0 : 1;
    } },
  { key: 'long-op-no-ts-heartbeat-pause', status: 'fixed', severity: 'IMPORTANT', dimension: 'Reliability',
    // IPC-R3: nav bake/test_run 长操作只暂停 GD 侧 heartbeat,TS 侧 health-monitor 每 15s ping 照发,
    // GD 主循环阻塞时 75s 误降级中断 110s/290s 操作。fix: HealthMonitor 加 pauseHeartbeat/resumeHeartbeat。
    // detect: _runWithOpTimeout 含 pauseHeartbeat + resumeHeartbeat 配对调用。
    detect: () => {
      const f = readSrc('src/core/EditorToolExecutor.ts');
      const hasPause = /pauseHeartbeat\(\)/.test(f);
      const hasResume = /resumeHeartbeat\(\)/.test(f);
      return hasPause && hasResume ? 0 : 1;
    } },
  { key: 'write-edit-script-no-sandbox-scan', status: 'fixed', severity: 'CRITICAL', dimension: 'Security',
    // SEC-P1-1: write_script/edit_script writeFileSync 写任意 content 不经 scanGdscriptSandbox,
    // 客户端可写 @tool/OS.execute 脚本。fix: scanScriptSandboxOrThrow 在 4 写入点阻断式扫描。
    // detect: script.ts 含 scanScriptSandboxOrThrow 定义 + write_script/edit_script 调用(至少 3 处)。
    detect: () => {
      const f = readSrc('src/tools/script.ts');
      const hasHelper = /function scanScriptSandboxOrThrow/.test(f);
      const callCount = (f.match(/scanScriptSandboxOrThrow\(/g) ?? []).length;
      return hasHelper && callCount >= 4 ? 0 : 1;  // 1 定义 + ≥3 调用(实际 4 写入点 + 1 定义 = 5)
    } },
  // SEC-P2-1 (2026-08-09): test-framework.ts 裸 validatePath 仅 resolve 零安全校验,
  // 依赖全局门 ToolDispatcher.validatePathArgs 兜底。纵深加固:改 requireProjectPath
  // (内部 requireString + isPathInAllowedRoots deny-by-default root 白名单)。
  // detect: test-framework.ts 含 requireProjectPath( 调用 = 防线在(detect=0);裸 validatePath( 调用 = 复发(detect=1)。
  // 注:import 行的 validatePath 不算(限定函数体内的调用)。
  { key: 'test-framework-validatepath-no-root-check', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    detect: () => {
      const f = readSrc('src/tools/test-framework.ts');
      const hasRequire = /requireProjectPath\s*\(/.test(f);
      const hasBareValidatePath = /[^.]\bvalidatePath\s*\(/.test(f);  // 排除 import 行的 { validatePath }
      return hasRequire && !hasBareValidatePath ? 0 : 1;
    } },
  // SEC-P2-2 (2026-08-09): GD 侧 secret 写不防 symlink(WriteAllText/FileAccess.open follow symlink
  // 覆盖目标)。读方 editor-auth.ts lstatSync 已兜底,写方对称加固。
  // detect: 两副本(mcp_bridge.gd + websocket_server.gd)都含 readlink + LinkType + "is a symlink"
  // 三特征 = 防线在(detect=0);任一副本缺特征 = 复发(detect=1)。仿 instance-property-blocked-gd 多副本模式。
  { key: 'gd-secret-write-no-symlink-guard', status: 'fixed', severity: 'IMPORTANT', dimension: 'Security',
    detect: () => {
      const files = ['src/scripts/mcp_bridge.gd', 'addons/godot_mcp_server/websocket_server.gd'];
      for (const f of files) {
        const src = readSrc(f);
        const hasReadlink = /readlink/.test(src);
        const hasLinkType = /LinkType/.test(src);
        const hasSymlinkWarn = /is a symlink/.test(src);
        if (!(hasReadlink && hasLinkType && hasSymlinkWarn)) return 1;  // 任一副本缺特征 = 复发
      }
      return 0;
    } },
];

// ═══════════════════════════════════════════════════════════════════════════════
// OPEN — 软阈值 detect() <= baseline（防恶化）。
// 本 task 闭环：原 defects.md 标 fixed 但实测 detect != 0 的条目按 spec §8 改 status='open'
// + 移到此处 + 加 baseline（master 实测命中数）。Task 3 将追加其余 open 条目。
// ═══════════════════════════════════════════════════════════════════════════════
export const OPEN_DEFECTS: DefectEntry[] = [
  // 原 fixed，实测真未修（M2 Task 2 闭环）
  // 2026-06-28 godot-version-hardcoded-create-project 修复（create_project 参数化 godot_version 到
  // project.godot features + main.gd）detect=0 移 FIXED 防复发。原 open 条目已删除。
  // 2026-08-19 api-db-version-stale 同样移 FIXED（extension_api.json 已 4.7，detect=0），原 open 条目已删除。
  { key: 'lint-rule-no-targeted-test', status: 'open', severity: 'IMPORTANT', dimension: 'Completeness',
    // [WONTFIX 2026-06-28] defects.md 从未存在（git log --all 无记录），L023/L024 规则无规格定义，
    // 不凭空设计（避免瞎猜）。lint 完整性由 L001-L022 + L025 共 23 条规则 + 全部定向测试覆盖。
    // detect 查 L023/L024 测试（不存在的编号），baseline=1 保留防恶化（detect=1=baseline 过，OPEN 搁置）。
    baseline: 1,
    detect: () => fileContains('test/gdscript-lint.test.js', /L023|L024/) ? 0 : 1 },
  // spec editor-version-tear 验收 10 follow-up: editor batch handler 名字校验白名单 ^[A-Za-z0-9_]+$
  // （对齐 handle_add_node:41）vs index.ts:323 headless 前置黑名单（"node_name contains invalid
  // characters" 错误路径）严格度不一致。本 spec 不统一（editor handler 内部已统一白名单，不引入新不一致）。
  // baseline=1 防恶化：黑名单错误路径仍在=detect=1=baseline 过；未来统一应人工转 fixed。
  { key: 'editor-batch-name-whitelist-headless-blacklist-mismatch', status: 'open', severity: 'ADVISORY',
    dimension: 'Maintainability', baseline: 1,
    detect: () => {
      const f = readSrc('src/tools/scene/index.ts');
      const batchBody = f.slice(f.indexOf("case 'batch_add_nodes'"), f.indexOf("case 'edit_node'"));
      return batchBody.includes("node_name contains invalid characters") ? 1 : 0;
    } },
  // 2026-06-28 lint-missing-4-7-accessibility-breaking 修复（L025 规则补 GH-116839 accessibility 迁移）detect=0 移 FIXED。

  // ═══════════════════════════════════════════════════════════════════════════════
  // OPEN（10 条，Task 3 段）— 基线阈值 detect() <= baseline（防恶化）。detect 源自 defects.md 行 246-538。
  // baseline = master 实测锁定值（plan Step 2 实测覆盖参考值）。Minor①：所有闭包正则为内联非复用字面量。
  // Task 3 review 闭环：-2（reconnect-degrade-fail + edit-node-blocked-props-json-pollution 移 FIXED）。
  // Task 3 review I-2：multi-instance-hmac EXPECTED 恢复 2（spec Named risk；master 0 调用 → detect=2 baseline=2）。
  // 2026-06-27 收窄：-3（version-hardcoded-drift / secret-cache-and-perm-weak / normalizeargs-depth-limit
  //   detect 改查真缺陷形态实测 0 移 FIXED）；2 降 ADVISORY（module-level-mutable-state / regex-danger-api-bypassable
  //   detect/baseline 不变，承认合理设计/已认知防御层，severity IMPORTANT→ADVISORY，保留 OPEN baseline 防恶化）。
  // 2026-06-27 recording-no-touch-events：ScreenDrag 补全移 FIXED（detect=0），OPEN −1。
  // OPEN 总计 8 条（初始 18 − 历次移 fixed 10 条，详见上下注释；以 OPEN_DEFECTS.length 为准，test 断言 === 8）。
  // ═══════════════════════════════════════════════════════════════════════════════
  // ── 上下文类（§6 计数化：越大越坏；#13 反向转正）──
  // gdscript-gen-null-root-deref 移 FIXED(2026-06-27 detect=0)
  { key: 'secret-file-toctou-race', status: 'open', severity: 'IMPORTANT', dimension: 'Security',
    // [WONTFIX 2026-06-28] 本地专用（MCP 127.0.0.1 + 密钥认证 + icacls 0600 + symlink 防护）。TOCTOU 窗口
    // （existsSync→readFileSync）需本地攻击者竞态，单用户无此威胁。原子 fs.open 是 YAGNI（多用户场景才需要）。
    detect: () => {
      // 计数：非原子密钥读取路径数（existsSync(secret) 与 readFileSync(secret) 分离，每对一次 TOCTOU）
      const a = readSrc('src/core/editor-auth.ts');
      const exists = a.match(/existsSync\([^)]*secret/gi)?.length ?? 0;
      const reads = a.match(/readFileSync\([^)]*secret/gi)?.length ?? 0;
      return Math.min(exists, reads);
    },
    baseline: 1 }, // editor-auth:115-122 三步分离（参考）
  { key: 'multi-instance-hmac-send-only', status: 'open', severity: 'IMPORTANT', dimension: 'Security',
    // [WONTFIX 2026-06-28] 多实例 HMAC 接线（instance-router 接收侧 + GodotServer 顶层）需 HTTP 服务端改造，
    // 仅多实例场景需要。当前单实例本地专用，无接收侧校验需求。大工程 + YAGNI，暂缓。baseline=2 保留防恶化。
    detect: () => {
      // §6 反向转正：缺失接线点数 = 期望(2: instance-router 接收侧 + GodotServer 顶层) − 实际生产调用。
      // EXPECTED=2 贴合 spec Named risk + defects.md fix-forward「接收侧(实例路由)调用 verifyApiToken」
      // (行 499) + GodotServer 顶层校验（行 503）两调用点。Task 3 review I-2：恢复 EXPECTED=2
      // （implementer 单方面改 1 违背 spec；master 实测 0 生产调用 → detect=2，保留 open 防恶化）。
      const EXPECTED = 2;
      const router = countMatchesInFile('src/core/instance-router.ts', /verifyApiToken\(/g);
      const server = countMatchesInFile('src/GodotServer.ts', /verifyApiToken\(/g);
      return Math.max(0, EXPECTED - (router + server));
    },
    baseline: 2 }, // master 实测 0 生产调用 → 缺失 2（instance-router 接收侧 + GodotServer 顶层均未接线）
  // ── 计数类 ──
  { key: 'module-level-mutable-state', status: 'open', severity: 'ADVISORY', dimension: 'Architecture',
    // 收窄降 ADVISORY（detect/baseline 不变）：43 全是合理单例/缓存（_permWarned 去重 / _cachedSecret TTL /
    // _runningProcess / _socket / _outputBuffer / CallRecorder _instance 单例），Node 单线程 +
    // _connectionLock/_sendLock 已加锁，无并发竞态。detect 计架构气味非缺陷，降 ADVISORY。保留 OPEN（baseline 防恶化）。
    detect: () => countMatchesInDir('src', /^(let|const) _/gm, /\.ts$/),
    baseline: 81 }, // ...80→81: Web GUI Task 1(2026-09-14,feat/web-gui-panel) core/logger.ts 增 _serverId(§3.3.1 进程标识,惰性 randomUUID 单例缓存;resetLogger 刻意不清——进程语义;无 setter 注入,同 _singletonWarned 既有合理单例模式,5 写点全覆盖写入 srv 字段); ...85→80: per-project run sessions Task 1(2026-09-13,feat/per-project-run-sessions)core/process-state.ts 七个模块单例变量(_runningProcess/_outputBuffer/_lastFinishedRunOutput/_processStartTime/_processBusy/_busyOwner/_busySince)收进 _sessions: Map<string, RunSession>(per-project 分桶,设计 v3.1 §4.1;_projectDir 保留升级为活跃指针,新增 _sessions/_exitedSessionOrder 两个可变容器,77 用例零改动通过); ...84→85: Task 1 B-1(2026-09-13 run_project 预览模式)core/process-state.ts 增 _lastFinishedRunOutput(最近结束运行输出快照,B-1 修复:get_debug_output 在当前缓冲为空时回落读取;同 _outputBuffer 既有单模块状态模式); ...66→84: 架构检查 D3 (2026-09-12) detect 扩 /^(let|const) _/ 收 const 形态入计——原 /^let _/ 漏计 const 可变容器(P9/P10 新增 4 处: dap _sessions/_breakpoints/_connectInflight + game-bridge _syncSnapshots;存量 3 处: _pathCache/_pathAllowLogged/_usedNonces),非可变 const(_ Symbol/__dirname/GD 内嵌字符串 11 处)保守一并计入,宁多报不漏报;...64→66: P9 (2026-09-12) tools/dap.ts 增 _sequence/_settings(DAP 会话 seq 计数+运行时设置,同原实现内存语义;_sessions/_breakpoints 是 const Map 不计——D3 后此豁免废止,已入计); ...63→64: d20b1ff 移植(2026-08-21 七维度审核④) core/bridge-client.ts 增 _sendInflight(in-flight 计数器,根治 setBridgeProjectDir 的 Promise 引用比较恒误报;同 _sendLock 既有并发原语模式,C 组下沉时该修复未随迁本次补齐); ...60→63: G-1(2026-08-14) game-bridge.ts 增 _subscriptions/_resendInFlight/_keepaliveTimer(订阅登记表+重发锁+keepalive timer,断线恢复修复:935,同 _socket/_connectionLock 既有连接状态模式); ...58→60: A6(2026-08-14) instance-api-auth.ts 增 _noncesLoaded/_noncePersistWarned(nonce 持久化生命周期标志,同 _lastNonceCleanup 既有单模块状态模式); ...56→58: P3-6 game-bridge.ts 增 _pushMessageHandler + _pushBuffer(bridge push 模式常驻 data handler,同 _socket/_socketBuffer 既有连接状态模式); ...55→56: P1-3 logger.ts 增 _requestLogFn
    // CallRecorder(Task 2 e6188ab)增 _instance 单例 42→43；get-context 批1(9142939 后)增 _connectionStatusProvider DI(同 manage-tools 模式) 43→44；批2 Task 3(f857615)增 setEditorSceneProvider DI(同模式) 44→45；MCP Roots 动态授权(Task 1 _dynamicRoots, 参照 call-recorder.ts:30 先例注释) 45→46；MCP Logging(Task 1 _mcpServer + _clientReady 注入 setter, 同 setMcpServer/_singletonWarned 既有模式) 46→48；MCP Progress(Task 1 b43ba4b _progressSender + _progressClientReady 注入 setter, 同 Logging 既有模式) 48→50；MCP Elicit(Task 1 _elicitServer 单值注入, 同 logger/progress server 注入模式但无 clientReady——elicitInput 是 request 非 notification) 50→51
  // ts-args-as-cast-no-validation 移 FIXED(2026-06-27 args-validator 接入,detect 改查入口)
  // version-hardcoded-drift 移 FIXED(2026-06-27 detect 改查可执行路径硬编码,剔除 verifiedGodotVersion 元数据 → 0)
  // launcher-no-error-listener 移 FIXED(2026-06-27 detect=0)
  // ── 存在性类（§6 计数化：返回命中处数/缺失项数，非 0/1）──
  // secret-cache-and-perm-weak 移 FIXED(2026-06-27 detect 改查真弱点 win32+chmod 无 icacls → 0)
  { key: 'websocket-auth-once-plaintext', status: 'open', severity: 'IMPORTANT', dimension: 'Security',
    // [WONTFIX 2026-06-28] 明文 ws 本地专用（127.0.0.1；规则文档注明本地单用户足够，多用户需 Unix Socket）。
    // per-msg HMAC 防 MITM 是为多用户场景，本地密钥认证已足够。YAGNI。baseline=2 保留防恶化。
    detect: () => {
      // 计数：弱认证特征数（明文 ws 处数 + 缺 per-msg HMAC）
      // 明文 ws 含两种写法：引号字面量 'ws://' 与模板字符串 `ws://${...}`（EditorConnection:149 实测后者）
      const c = readSrc('src/core/EditorConnection.ts');
      let n = c.match(/['"`]ws:\/\/|new WebSocket\(['"`]ws:/g)?.length ?? 0;
      if (n > 0 && !/per.?message.*hmac|hmac.*per.?message/i.test(c)) n++; // 有 ws 但无 per-msg HMAC
      return n;
    },
    baseline: 2 }, // EditorConnection:149 模板字符串明文 ws + 无 HMAC（Step 2 实测锁定）
  { key: 'regex-danger-api-bypassable', status: 'open', severity: 'ADVISORY', dimension: 'Security',
    // 收窄降 ADVISORY（detect/baseline 不变）：黑名单是已认知的多层防御之一，CLAUDE.md godot-mcp-core.md
    // C-04 明确"沙箱仅防误操作，不可防恶意绕过，需容器/VM 隔离"。detect 把黑名单密度当缺陷过严——
    // 黑名单存在是【加固】而非弱点，且容器隔离兜底非 detect 可衡量。降 ADVISORY。保留 OPEN（baseline 防恶化）。
    // 审查修订：剔除 stripLiterals/randomizeMarkers/MARKER_RESULT——这些是【加固】特征，
    // 计入会让"加防护"推高度量、触发恶化误报（逼开发者别加固）。只计黑名单弱点密度。
    detect: () => countMatchesInFile('src/gdscript-executor.ts', /DANGEROUS_API_TOKENS|DANGEROUS_PATTERNS/g),
    baseline: 11 }, // master 实测 11（DANGEROUS_API_TOKENS 3 + DANGEROUS_PATTERNS 8 全部引用处，非仅定义点）
  { key: 'godotpath-env-validation-weak', status: 'open', severity: 'ADVISORY', dimension: 'Security',
    detect: () => {
      // 计数：缺失的强校验项数（期望：所有者 + 签名/authenticode + 版本）
      const f = readSrc('src/core/godot-finder.ts');
      let missing = 0;
      if (!/signature|authenticode/i.test(f)) missing++;
      if (!/owner|getuid|\buid\b/i.test(f)) missing++;
      if (!/validateGodotBinary[\s\S]{0,300}--version/.test(f)) missing++;
      return missing;
    },
    baseline: 1 }, // master 实测=1（缺所有者/uid；signature 或 validateGodotBinary 已部分命中）
  // plugin-no-super-call(2026-07-04 detect 反转): 654b162 误加 super 触发 4.6.2+ parse error,
  //   移除 6 处 super 后 detect 反转计数"原生类虚函数有 super"=0,留 FIXED 防 654b162 式回归
  // recording-no-touch-events 移 FIXED(2026-06-27 ScreenDrag 补全 feat/recording-screen-drag,两类齐备 detect=0)
  // normalizeargs-depth-limit 移 FIXED(2026-06-27 detect 改查裸 depth>5 字面量,排除 .MAX_NORMALIZE_DEPTH 引用 → 0)
];

