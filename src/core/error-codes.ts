/**
 * 错误码注册表(单一事实源)——竞品综述建议⑤落地(2026-11-13 批 A/A1,对齐 IvanMurzak #505
 * "统一失败分类表")。
 *
 * 现状背景:三套平行错误体系(ToolError 异常 9 类 / opsErrorResult 返回码 76 种 /
 * bridge GD 数字码 20 种),535 处 opsErrorResult 仅 6 处带 retryable、0 处带
 * errorCategory。本注册表让异常路径(tool-errors.ts 9 类默认码)与返回路径
 * (opsError 自动补全)同一张表背书——修复 TIMEOUT 等同码不同义的断裂。
 *
 * 收编口径:COMMON_ERROR_CODES 现有 5 码(src/core/shared/errors.ts) + bridge-client
 * 3 码(src/core/bridge-client.ts ERROR_CODES) + grep 实际频率前 ~25 高频内联码
 * (覆盖约 90% 调用点)+ tool-errors.ts 9 异常类默认码。未登记码保守 retryable=false
 * 并 warn 一次(不拒调用)——新码按 docs/error-codes.md 语义表格式收编。
 *
 * PII 护栏(对齐 tool-errors.ts):注册表只收码与语义(meaning 为固定中文一句话),
 * 不收运行时错误文本;meaning 可安全外传。
 */

import type { ErrorCategory } from './tool-errors.js';
import { getLogger } from './logger.js';

/** 单个错误码的语义声明。category 为七类结构化枚举(非文本推断,无 PII 外传风险)。 */
export interface ErrorCodeSpec {
  retryable: boolean;
  category?: ErrorCategory;
  /** 一句话中文语义(固定文本,PII-safe,可进文档与响应)。 */
  meaning: string;
}

/**
 * 错误码注册表。分两组:瞬态可重试(等 1-2s 或修复环境后重试有意义)/
 * 确定性失败(按 suggestion 改参数/换路径,原样重试会被熔断器拒绝)。
 */
export const ERROR_CODES: Readonly<Record<string, ErrorCodeSpec>> = {
  // ── 瞬态可重试(retryable=true)──────────────────────────────────────────
  NOT_CONNECTED:            { retryable: true, category: 'connection', meaning: '编辑器/bridge 未连接,重连后可成功' },
  BRIDGE_NOT_CONNECTED:     { retryable: true, category: 'connection', meaning: 'Bridge 未连接(未安装/游戏未运行/密钥不匹配)' },
  EDITOR_NOT_CONNECTED:     { retryable: true, category: 'connection', meaning: 'editor 插件未连接(需 launch_editor/安装插件)' },
  BRIDGE_TIMEOUT:           { retryable: true, category: 'timeout',    meaning: 'Bridge 请求超时(outcome 未知,重试须传同一 requestId 幂等)' },
  TIMEOUT:                  { retryable: true, category: 'timeout',    meaning: '操作超时(handler 内部业务超时)' },
  TOOL_DEADLINE_EXCEEDED:   { retryable: true, category: 'timeout',    meaning: '超过 dispatcher 全局 deadline 兜底(handler 忘写内部超时)' },
  TRANSPORT:                { retryable: true, category: 'transport',  meaning: '传输层错误(socket 断开等非超时)' },
  RATE_LIMIT:               { retryable: true, category: 'guard',      meaning: '速率限制(瞬态限流,窗口重置后重试)' },
  CONCURRENCY_LIMIT:        { retryable: true, category: 'guard',      meaning: '并发/串行队列占用上限(稍候重试)' },
  TOOL_CIRCUIT_OPEN:        { retryable: true, category: 'guard',      meaning: '工具熔断器打开(冷却期后半开重试)' },
  VERIFICATION_IN_PROGRESS: { retryable: true, category: 'guard',      meaning: 'editor 连接项目校验进行中(稍候重试)' },
  SERVER_STALE:             { retryable: true, category: 'internal',   meaning: 'MCP server 版本/registry 过期(重启即恢复)' },
  BUSY:                     { retryable: true, category: 'guard',      meaning: '资源占用中(会话/实例忙,稍候重试)' },

  // ── 确定性失败(retryable=false,按 suggestion 改参数/换路径)────────────
  INVALID_PARAMS:           { retryable: false, category: 'validation', meaning: '参数校验失败' },
  UNKNOWN_ACTION:           { retryable: false, category: 'validation', meaning: 'action 未声明/拼写错误(附 did-you-mean 建议)' },
  INVALID_PATH:             { retryable: false, category: 'path',       meaning: '路径非法(穿越/非法字符/非 res:// 形态)' },
  PATH_NOT_ALLOWED:         { retryable: false, category: 'path',       meaning: '路径不在 ALLOWED_PROJECT_PATHS 白名单' },
  MISSING_PARAM:            { retryable: false, category: 'validation', meaning: '必填参数缺失' },
  INVALID_PARAM:            { retryable: false, category: 'validation', meaning: '单参数值不合法' },
  INVALID_PARAM_TYPE:       { retryable: false, category: 'validation', meaning: '参数类型错误' },
  INVALID_TYPE:             { retryable: false, category: 'validation', meaning: '节点/对象类型不匹配' },
  INVALID_VALUE:            { retryable: false, category: 'validation', meaning: '取值非法/越界' },
  INVALID_ACTION:           { retryable: false, category: 'validation', meaning: 'action 值不在枚举内' },
  INVALID_SIGNAL:           { retryable: false, category: 'validation', meaning: '信号名/签名不合法' },
  INVALID_VECTOR:           { retryable: false, category: 'validation', meaning: '向量参数格式/分量非法' },
  INVALID_TILE_COORDS:      { retryable: false, category: 'validation', meaning: 'TileMap 坐标非法' },
  INVALID_TEMPLATE:         { retryable: false, category: 'validation', meaning: '模板名/内容不合法' },
  INVALID_FORMAT:           { retryable: false, category: 'validation', meaning: '数据格式不合法' },
  INVALID_FILE_NAME:        { retryable: false, category: 'validation', meaning: '文件名不匹配约定/含非法字符' },
  INVALID_RECORDING_FORMAT: { retryable: false, category: 'validation', meaning: '录制文件名/JSON 结构不合法' },
  FILE_NOT_FOUND:           { retryable: false, category: 'path',       meaning: '目标文件不存在' },
  NOT_FOUND:                { retryable: false, category: 'validation', meaning: '目标节点/资源/记录不存在' },
  NODE_NOT_FOUND:           { retryable: false, category: 'validation', meaning: '场景中找不到目标节点' },
  SCENE_NOT_FOUND:          { retryable: false, category: 'validation', meaning: '场景文件不存在或加载失败' },
  GUARD:                    { retryable: false, category: 'guard',      meaning: '守卫拒绝(确认令牌/只读模式拦截)' },
  SANDBOX_VIOLATION:        { retryable: false, category: 'guard',      meaning: 'GDScript 沙箱扫描阻断危险 API 模式' },
  SANDBOX_BLOCKED:          { retryable: false, category: 'guard',      meaning: '沙箱阻断(工具级内容拦截)' },
  SCRIPT_EXEC_FAILED:       { retryable: false, category: 'internal',   meaning: 'GDScript 编译/运行失败(消息附引擎错误行)' },
  SPAWN_FAILED:             { retryable: false, category: 'internal',   meaning: 'Godot 进程 spawn 失败(二进制缺失/文件锁)' },
  GODOT_NOT_FOUND:          { retryable: false, category: 'internal',   meaning: '找不到 Godot 二进制(设 GODOT_PATH 或安装)' },
  EDIT_REVERTED:            { retryable: false, category: 'validation', meaning: 'edit_script 内容守卫失败已回滚(读最新内容后重做)' },
  EDITOR_SCENE_OPEN:        { retryable: false, category: 'guard',      meaning: 'headless 改盘与编辑器打开场景冲突(需 Reload 后重做)' },
  AUDIT_WRITE_FAILED:       { retryable: false, category: 'internal',   meaning: '审计日志写入失败' },
  BRIDGE_ERROR:             { retryable: false, category: 'connection', meaning: 'Bridge 请求返回错误(游戏侧处理失败)' },
  INTERNAL:                 { retryable: false, category: 'internal',   meaning: '内部错误(PII-safe 固定兜底)' },
};

/** 未登记码 warn 去重集合(同码只警一次,防刷屏)。 */
const warnedUnregistered = new Set<string>();

/**
 * 未登记码首次出现时 warn 一次(同码只警一次)。供 opsError 补全路径调用——
 * 未登记码保守 retryable=false 但**不拒调用**,warn 提示开发者按语义表收编。
 */
export function warnIfUnregisteredCode(code: string): void {
  if (warnedUnregistered.has(code)) return;
  warnedUnregistered.add(code);
  getLogger().warn(
    'error-codes',
    `错误码 "${code}" 未在 ERROR_CODES 注册表(src/core/error-codes.ts)登记,retryable 保守补 false(不拒调用)。请按 docs/error-codes.md 语义表收编。`,
  );
}

/** 清空未登记码 warn 去重集合(测试隔离用,对齐 logger.ts resetLogger 防御性复位惯例)。 */
export function resetUnregisteredCodeWarnings(): void {
  warnedUnregistered.clear();
}
