/**
 * 手写状态机 GDScript tokenizer(2026-09-11 P6 批,整文件移植自 Erodenn-godot-mcp-runtime [上游 license:MIT,2026-10-01 GitHub API 核实,见 THIRD_PARTY_NOTICES.md]
 * src/utils/gdscript-scanner.ts,经真读验证;适配点仅头注释与尾部追加的 classifyFirstArgument)。
 *
 * 消费方:gdscript-executor.ts 的 scanGdscriptSandbox Phase 3(非字面量 load/preload 拦截)。
 * tokenizer 职责:剥注释与字符串内容(策略绝不匹配 "OS.execute" 或 # OS.execute 里的文本),
 * 并把成员访问链(OS.execute / Foo.bar.baz)合并为单个 memberChain token(chain 数组供规则
 * 前缀匹配)。
 *
 * ⚠️ P6 架构判断(为什么没有移植 Erodenn 的三级 tier 规则表):enhanced 的安全架构是
 * "工具级确认 + 内容级硬拦"——execute_gdscript 的 actionRisk='process' 意味着每次调用
 * 都经确认令牌 out-of-band gate(AI 不能自确认)。Erodenn 的 Tier 2 elicit_required 是
 * 为"默认无确认"的 run_script 设计的分级确认,在 enhanced 里是重复建设;且把文件写/网络
 * 类从硬拦降为"问了再跑"是安全回退(用户确认可能被注入内容欺骗,确认后的硬拦恰是纵深)。
 * 本文件只取 tokenizer 的结构化能力(classifyFirstArgument 的括号深度感知——正则做不到)。
 *
 * Not a full GDScript parser — we only need enough to:
 *  - Recognize comments (`#` to EOL).
 *  - Skip string-literal contents in all GDScript forms (`"..."`, `'...'`,
 *    `"""..."""`, `'''...'''`).
 *  - Skip node-path literals (`$Foo/Bar`, `^"..."`) — their contents are
 *    Godot scene paths, not GDScript code.
 *  - Emit identifiers, member chains, parentheses, commas, and a small set
 *    of other punctuation. Everything else (operators, numbers) collapses to
 *    an `other` token the policy ignores.
 *  - Track line numbers and the rough start column of each token so policy
 *    findings can name the offending line.
 *
 * Line continuation (`\` at end of line) is handled by treating the next line
 * as a continuation of the current logical line for member-chain coalescing
 * purposes.
 *
 * This tokenizer is a best-effort accident guard, not a sound static
 * analysis — see `run-script-policy.ts` and `docs/security.md` for the full
 * doctrine. One structural blind spot worth stating plainly here, since it's
 * inherent to token-level scanning and not a gap the next feature closes:
 * identifier aliasing / dataflow is invisible. `var f = OS; f.execute(...)`
 * tokenizes as two unrelated identifiers — the tokenizer has no notion of
 * "what does this variable refer to," so a rule keyed on `OS.execute` never
 * fires. Do not mistake this for a TODO; closing it would require a dataflow
 * analysis, which is out of scope for a hand-written tokenizer by design.
 */

export type TokenKind =
  | 'identifier'
  | 'memberChain'
  | 'string'
  | 'number'
  | 'punct'
  | 'newline'
  | 'other';

export interface Token {
  kind: TokenKind;
  text: string;
  /** For memberChain, the dotted segments in order: `OS.execute` → `['OS','execute']`. */
  chain?: string[];
  line: number;
  column: number;
}

const IDENT_START_RE = /[A-Za-z_]/;
const IDENT_PART_RE = /[A-Za-z0-9_]/;
const DIGIT_RE = /[0-9]/;
const NODE_PATH_CHAR_RE = /[A-Za-z0-9_/\\]/;

function isIdentStart(ch: string): boolean {
  return IDENT_START_RE.test(ch);
}
function isIdentPart(ch: string): boolean {
  return IDENT_PART_RE.test(ch);
}
function isDigit(ch: string): boolean {
  return DIGIT_RE.test(ch);
}
function isNodePathChar(ch: string): boolean {
  return NODE_PATH_CHAR_RE.test(ch);
}

/**
 * Skip inline whitespace (space/tab) and newlines starting at `pos`, tracking
 * line/lineStart across any newline crossed. Used by the member-chain builder
 * to peek past whitespace/newlines around a `.` without committing to the
 * skip unless the peek finds what it's looking for (see the identifier
 * branch in `tokenize`).
 */
function skipWsAndNewlines(
  source: string,
  len: number,
  pos: number,
  line: number,
  lineStart: number,
): { pos: number; line: number; lineStart: number } {
  while (pos < len) {
    const c = source[pos];
    if (c === ' ' || c === '\t') {
      pos++;
      continue;
    }
    if (c === '\n') {
      pos++;
      line++;
      lineStart = pos;
      continue;
    }
    if (c === '\r') {
      pos++;
      if (pos < len && source[pos] === '\n') pos++;
      line++;
      lineStart = pos;
      continue;
    }
    break;
  }
  return { pos, line, lineStart };
}

/**
 * Tokens emitted by `tokenize`. Comments and string-literal contents are NOT
 * present — they are consumed silently. String literals as a whole are emitted
 * as a single `string` token so the policy can recognize "literal first
 * argument" patterns (e.g. `load("res://foo.tscn")`) without seeing the
 * characters inside.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const len = source.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const colOf = (pos: number): number => pos - lineStart + 1;

  while (i < len) {
    const ch = source[i]!;

    // Newline — emit, advance line counter.
    if (ch === '\n') {
      tokens.push({ kind: 'newline', text: '\n', line, column: colOf(i) });
      i++;
      line++;
      lineStart = i;
      continue;
    }

    // \r\n or bare \r — treat as newline.
    if (ch === '\r') {
      tokens.push({ kind: 'newline', text: '\n', line, column: colOf(i) });
      i++;
      if (i < len && source[i] === '\n') i++;
      line++;
      lineStart = i;
      continue;
    }

    // Whitespace.
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    // Line continuation: `\` at end of line. Skip the backslash + newline so
    // the next physical line is treated as the same logical line for chain
    // coalescing. Don't emit a newline token in this case.
    if (ch === '\\') {
      let j = i + 1;
      while (j < len && (source[j] === ' ' || source[j] === '\t')) j++;
      if (j < len && (source[j] === '\n' || source[j] === '\r')) {
        i = j + 1;
        if (i < len && source[j] === '\r' && source[i] === '\n') i++;
        line++;
        lineStart = i;
        continue;
      }
      // Bare backslash is rare in GDScript outside strings; emit as other.
      tokens.push({ kind: 'other', text: '\\', line, column: colOf(i) });
      i++;
      continue;
    }

    // Comment: `#` to EOL. Consume silently.
    if (ch === '#') {
      while (i < len && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }

    // String literals (all GDScript forms).
    if (ch === '"' || ch === "'") {
      const startLine = line;
      const startCol = colOf(i);
      const quote = ch;
      // Triple-quoted?
      if (i + 2 < len && source[i + 1] === quote && source[i + 2] === quote) {
        i += 3;
        while (i < len) {
          if (source[i] === '\\' && i + 1 < len) {
            // Skip escaped char; track newlines inside the escape sequence.
            if (source[i + 1] === '\n') {
              line++;
              lineStart = i + 2;
            }
            i += 2;
            continue;
          }
          if (source[i] === '\n') {
            line++;
            lineStart = i + 1;
            i++;
            continue;
          }
          if (
            source[i] === quote &&
            i + 2 < len &&
            source[i + 1] === quote &&
            source[i + 2] === quote
          ) {
            i += 3;
            break;
          }
          i++;
        }
        tokens.push({ kind: 'string', text: '<triple-string>', line: startLine, column: startCol });
        continue;
      }
      // Single-line string.
      i++;
      while (i < len && source[i] !== quote && source[i] !== '\n' && source[i] !== '\r') {
        if (source[i] === '\\' && i + 1 < len) {
          i += 2;
          continue;
        }
        i++;
      }
      if (i < len && source[i] === quote) i++;
      tokens.push({ kind: 'string', text: '<string>', line: startLine, column: startCol });
      continue;
    }

    // Node-path literal: `$Foo/Bar` or `$"Foo Bar"`. Consume to whitespace,
    // newline, or a clear non-path delimiter.
    if (ch === '$') {
      const startLine = line;
      const startCol = colOf(i);
      i++;
      if (i < len && (source[i] === '"' || source[i] === "'")) {
        const quote = source[i]!;
        i++;
        while (i < len && source[i] !== quote && source[i] !== '\n') i++;
        if (i < len && source[i] === quote) i++;
      } else {
        while (i < len && isNodePathChar(source[i]!)) i++;
      }
      tokens.push({ kind: 'string', text: '<node-path>', line: startLine, column: startCol });
      continue;
    }

    // String-name literal: `^"..."` or `^Identifier`. Treat as opaque string.
    if (ch === '^') {
      const startLine = line;
      const startCol = colOf(i);
      i++;
      if (i < len && (source[i] === '"' || source[i] === "'")) {
        const quote = source[i]!;
        i++;
        while (i < len && source[i] !== quote && source[i] !== '\n') {
          if (source[i] === '\\' && i + 1 < len) {
            i += 2;
            continue;
          }
          i++;
        }
        if (i < len && source[i] === quote) i++;
      } else {
        while (i < len && isIdentPart(source[i]!)) i++;
      }
      tokens.push({ kind: 'string', text: '<string-name>', line: startLine, column: startCol });
      continue;
    }

    // Number literal — emit but otherwise ignored by policy.
    if (isDigit(ch)) {
      const startLine = line;
      const startCol = colOf(i);
      const start = i;
      while (i < len && (isDigit(source[i]!) || source[i] === '.' || source[i] === '_')) {
        i++;
      }
      // Exponent.
      if (i < len && (source[i] === 'e' || source[i] === 'E')) {
        i++;
        if (i < len && (source[i] === '+' || source[i] === '-')) i++;
        while (i < len && isDigit(source[i]!)) i++;
      }
      tokens.push({
        kind: 'number',
        text: source.slice(start, i),
        line: startLine,
        column: startCol,
      });
      continue;
    }

    // Identifier or member chain. Build the chain by reading identifier
    // segments separated by `.` (with no whitespace between identifier and
    // dot — `foo .bar` is two tokens, but GDScript style is `foo.bar`).
    if (isIdentStart(ch)) {
      const startLine = line;
      const startCol = colOf(i);
      const start = i;
      while (i < len && isIdentPart(source[i]!)) i++;
      const first = source.slice(start, i);
      const chain: string[] = [first];
      let endText = first;
      // Continue the chain across `.identifier` segments, tolerating
      // whitespace and newlines both before and after the `.` — GDScript
      // already treats `a\n.b` inside parens as `a.b`, and a tight
      // "no whitespace" rule here was a skeleton key that let `OS .execute`,
      // `OS. execute`, and `OS.\n  execute` bypass every two-segment rule in
      // the policy table at once. Peek past whitespace/newlines for the `.`,
      // then past whitespace/newlines after the `.` for the next identifier
      // segment; only commit (advance i/line/lineStart) if both are found —
      // on failure nothing has moved, so a genuine `foo\nbar` (two separate
      // statements) still tokenizes as two identifiers and the skipped
      // whitespace/newline is re-scanned normally by the outer loop.
      while (i < len) {
        const beforeDot = skipWsAndNewlines(source, len, i, line, lineStart);
        if (beforeDot.pos >= len || source[beforeDot.pos] !== '.') break;
        const afterDot = skipWsAndNewlines(
          source,
          len,
          beforeDot.pos + 1,
          beforeDot.line,
          beforeDot.lineStart,
        );
        if (afterDot.pos >= len || !isIdentStart(source[afterDot.pos]!)) break;
        let k = afterDot.pos;
        while (k < len && isIdentPart(source[k]!)) k++;
        chain.push(source.slice(afterDot.pos, k));
        endText += '.' + source.slice(afterDot.pos, k);
        i = k;
        line = afterDot.line;
        lineStart = afterDot.lineStart;
      }
      if (chain.length > 1) {
        tokens.push({
          kind: 'memberChain',
          text: endText,
          chain,
          line: startLine,
          column: startCol,
        });
      } else {
        tokens.push({ kind: 'identifier', text: first, line: startLine, column: startCol });
      }
      continue;
    }

    // Punctuation we care about.
    if (ch === '(' || ch === ')' || ch === ',' || ch === '[' || ch === ']' || ch === '=') {
      tokens.push({ kind: 'punct', text: ch, line, column: colOf(i) });
      i++;
      continue;
    }

    // Anything else (operators, `:`, `.` outside member chain) — collapse to other.
    tokens.push({ kind: 'other', text: ch, line, column: colOf(i) });
    i++;
  }

  return tokens;
}

/**
 * Convenience: return only the non-newline, non-whitespace tokens. Useful for
 * policy rules that don't care about line structure.
 */
export function tokenizeStripped(source: string): Token[] {
  return tokenize(source).filter((t) => t.kind !== 'newline');
}


// ─── P6: classifyFirstArgument(移植自 Erodenn run-script-policy.ts,同依赖面纯函数) ───

export type ArgumentClassification = 'none' | 'literal' | 'nonliteral';

/**
 * 分类调用表达式的**整个**首参:从 `(` 起收集 token 到顶层 `,` 或 `)`(括号深度感知,
 * 嵌套调用不误判)。'literal' = 孤立 string token(如 load("res://foo"));'nonliteral' =
 * 其他一切(标识符/表达式/多 token——"a" + b 正确判 nonliteral 而非被前导字面量骗过);
 * 'none' = 无参。这是正则扫描做不到的结构化判断(load(p) 变量形式正则不可见)。
 */
export function classifyFirstArgument(
  tokens: readonly Token[],
  openParenIndex: number,
): ArgumentClassification {
  let depth = 0;
  const collected: Token[] = [];

  for (let j = openParenIndex + 1; j < tokens.length; j++) {
    const tok = tokens[j]!;
    if (tok.kind === 'newline') continue;

    if (tok.kind === 'punct') {
      if (tok.text === '(' || tok.text === '[') {
        depth++;
        collected.push(tok);
        continue;
      }
      if (tok.text === ')') {
        if (depth === 0) break; // terminator: end of the call
        depth--;
        collected.push(tok);
        continue;
      }
      if (tok.text === ']') {
        if (depth > 0) depth--;
        collected.push(tok);
        continue;
      }
      if (tok.text === ',' && depth === 0) {
        break; // terminator: end of the first argument
      }
    }

    collected.push(tok);
  }

  if (collected.length === 0) return 'none';
  if (collected.length === 1 && collected[0]!.kind === 'string') return 'literal';
  return 'nonliteral';
}
