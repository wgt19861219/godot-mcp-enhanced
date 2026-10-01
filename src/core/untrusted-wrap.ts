/**
 * untrusted-wrap.ts — 输出侧提示注入防御(nonce 信封,P1-1,2026-09-11)。
 *
 * 威胁模型:六层防御管"进"(执行请求),没人管"出"——项目文件内容(源码/场景/日志)
 * 里可能藏着面向模型的提示注入(伪造系统指令/工具输出)。本模块把读回的不可信内容
 * 包进带随机 nonce 的信封标签,让模型能区分"工具/系统说的话"与"项目内容里的字"。
 * 与现有"输出标记防伪造"(防 GDScript 伪造 MCP 输出)正交:那层防伪造输出,这层防
 * 内容注入。来源:NPGameDev untrusted.gd(26 行 GDScript,15 读路径调用点)。 [上游 license:GitHub API 报 NOASSERTION 待人工核实,见 THIRD_PARTY_NOTICES.md]
 *
 * 软防御诚实边界:信封是否生效取决于客户端模型是否"尊重"标签语义——与输出标记同级,
 * 不是不可绕过的安全边界(对齐 AGENTS.md 安全体系表述)。
 *
 * 开关:GODOT_MCP_UNTRUSTED_ENVELOPE=0 关闭(默认开)。只包读路径,不包写确认/错误消息
 * (那些是 server 自产可信文本)。JSON 输出 stringify 后整体包(NPGameDev 同款)。
 */
import { randomBytes } from 'node:crypto';

/** 匹配一切 untrusted 标签变体:开/闭、hex/非 hex nonce(形似变体)、带属性、大小写、空白容错(P1 批审查 N-2 放宽)。 */
const ENVELOPE_TAG_RE = /<\s*\/?\s*untrusted(?:[\s/-][^>]*)?>/gi;

/** 信封开关(默认开;=0 显式关闭)。 */
export function untrustedEnabled(): boolean {
  return process.env.GODOT_MCP_UNTRUSTED_ENVELOPE !== '0';
}

/**
 * 包信封。nonce 每次随机(模型不可预测 → 无法在注入内容里伪造闭标签提前"逃出"信封);
 * scrub 先洗掉 body 里已存在的一切信封标签变体(防嵌套伪造)。nonce 威胁模型是
 * "模型不可预测"而非"不可暴力"(每信封一次性出现,无重放面,randomBytes 足够)。
 */
export function wrapUntrusted(kind: string, source: string, body: string): string {
  const nonce = randomBytes(4).toString('hex');
  const scrubbed = body.replace(ENVELOPE_TAG_RE, '[scrubbed-envelope-tag]');
  // 全仓审查 M-4 (2026-09-12): kind/source 进属性域,含 " 时逃逸开标签属性
  // (source 来自用户 GDScript 的 _mcp_output key,攻击者可控)——转义引号封死。
  const safeKind = kind.replaceAll('"', '&quot;');
  const safeSource = source.replaceAll('"', '&quot;');
  return `<untrusted-${nonce} kind="${safeKind}" source="${safeSource}">\n${scrubbed}\n</untrusted-${nonce}>`;
}

/** 条件包装入口:开关关闭时原样返回(读通道调用点统一用这个)。 */
export function maybeWrapUntrusted(kind: string, source: string, body: string): string {
  return untrustedEnabled() ? wrapUntrusted(kind, source, body) : body;
}

/**
 * 剥信封:输入为信封包裹文本时返回内部 body,否则原样返回(向后兼容)。
 * 供测试与内部消费方解包——信封默认开启改变了读通道输出格式,既有裸 JSON.parse
 * 断言经此剥壳(P1 批审查 B-1 修复)。严格匹配 hex nonce 开闭对,不误剥普通文本。
 */
export function stripEnvelope(text: string): string {
  const m = text.match(/^<untrusted-[0-9a-f]{8} [^>]*>\n([\s\S]*)\n<\/untrusted-[0-9a-f]{8}>$/);
  return m ? m[1]! : text;
}
