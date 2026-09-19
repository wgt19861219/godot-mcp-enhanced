// CSV 前置校验:仅解析 header 行(RFC4180 引号),不解析所有行值(权威解析在 GDScript get_csv_line)。
export interface ParseCsvResult { ok: boolean; headers?: string[]; error?: string; }

/** CSV 列数上限(P3 防御纵深,2026-07-05 复审):F-7 字节上限锁 10MB,但仍允许超多列(如 "x,".repeat(5M))
 *  撑爆 headers 数组 + 后续 headers.includes O(N) 扫描 + GDScript get_csv_line 同构放大。1000 列覆盖正常 CSV。 */
const MAX_CSV_COLUMNS = 1000;

export function parseCsv(text: string): ParseCsvResult {
  if (!text || !text.trim()) return { ok: false, error: 'empty csv' };
  const firstLine = text.split(/\r?\n/)[0]!;
  // 简单 RFC4180:引号内逗号不拆(header 行)
  const headers: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i]!;
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { headers.push(cur); cur = ''; continue; }
    cur += ch;
  }
  headers.push(cur);
  if (headers.length === 0) return { ok: false, error: 'no header columns' };
  if (headers.length > MAX_CSV_COLUMNS) return { ok: false, error: `exceeds ${MAX_CSV_COLUMNS} columns limit (${headers.length} columns)` };
  return { ok: true, headers };
}

import type { Tool } from "@modelcontextprotocol/server";

// T3: generateImportScript — 生成 GDScript 脚本,CSV 值通过 FileAccess.get_csv_line 运行时读取
// (零进脚本字符串 = CRITICAL-1 注入根治)。4 参数(classPath/outputDir/filenameCol/csvTmpPath)
// 经转义后插值,防闭串注入。T2b: 路径三参数(classPath/outputDir/csvTmpPath)是纯字面量内插
// (FileAccess/load 目录操作),% 原样(escapeForGdLiteral)——gdEscape 双写 %% 会破坏含 % 的路径;
// filenameCol 是 CSV 列名(名类),维持 gdEscape。
import { gdEscape, escapeForGdLiteral, MARKER_RESULT } from './shared.js';
import { validateTimeout } from './shared/validation.js';

export interface ImportScriptOpts {
  classPath: string;
  outputDir: string;
  filenameCol: string;
  csvTmpPath: string;
}

// GDScript 模板:tab 缩进(GDScript 强制 tab,空格被拒)。CSV 值走 FileAccess,不进脚本源码。
// 枚举转换:hint_string 优先(spec §4 修订 + T1 PoC 实证:纯 @export var x:int 无 hint=0,
// ClassDB 路径失效;只有 @export_enum 产生 hint=2 + hint_string,索引即 int),ClassDB fallback。
// T4 修订:输出走 gdscript-executor 的 MARKER_RESULT 协议(parseMcpMarkers 只识别带前缀的行),
// _mcp_output 将 value 经 JSON.stringify 编码为字符串(executeGdscript Result.outputs[].value: string),
// handler 侧 JSON.parse 还原。
const GDSCRIPT_TEMPLATE = (cp: string, od: string, fc: string, csv: string) => `extends SceneTree
var _mcp_outputs := []
var _class_path := "${escapeForGdLiteral(cp)}"
var _output_dir := "${escapeForGdLiteral(od)}"
var _filename_col := "${gdEscape(fc)}"
var _csv_path := "${escapeForGdLiteral(csv)}"
var _errors := []
var _generated := []
var _row_count := 0
var _failed := 0

func _mcp_output(k, v): _mcp_outputs.append({"key": k, "value": JSON.stringify(v)})

func _convert_enum(raw: String, field: Dictionary, cls_name: String) -> Variant:
\t# 优先 hint_string(spec §4 修订 + T1 PoC 实证):@export_enum("SWORD,BOW") 产生逗号分隔列表,索引即 int
\tif field.has("hint_string") and field.hint_string != "":
\t\tvar opts: PackedStringArray = field.hint_string.split(",")
\t\tfor i in range(opts.size()):
\t\t\tif opts[i] == raw:
\t\t\t\treturn i
\t# fallback: ClassDB class enum
\tif ClassDB.class_has_integer_constant(cls_name, raw):
\t\treturn ClassDB.class_get_integer_constant(cls_name, raw)
\treturn null

func _safe_float(raw: String) -> Variant:
\t# F-8(2026-07-04 审查 + 2026-07-05 复审 P1 扩展): is_valid_float 对 inf/-inf/nan/infinity 返回 true,
\t# float() 返回 INF/-INF/NAN → 落盘损坏数值(对照 value-serializer.ts isFinite 守卫)。
\t# 抽 helper 统一守卫 TYPE_FLOAT/TYPE_VECTOR2/TYPE_COLOR 三分支(原 F-8 仅守 FLOAT,VECTOR2/COLOR 漏)。
\t# 失败返回 null → 调用方 _type_convert 命中 type convert failed error,杜绝 INF/NAN 落盘。
\tif not raw.is_valid_float(): return null
\tvar fv: float = float(raw)
\tif not is_finite(fv): return null
\treturn fv

func _type_convert(raw: String, field: Dictionary, cls_name: String) -> Variant:
\t# 枚举: TYPE_INT + hint=PROPERTY_HINT_ENUM 或 hint_string 非空(spec §4 + T1 PoC)
\tif field.type == TYPE_INT and (field.hint == PROPERTY_HINT_ENUM or (field.has("hint_string") and field.hint_string != "")):
\t\treturn _convert_enum(raw, field, cls_name)
\tmatch field.type:
\t\t# I-1: int("abc")/float("abc") GDScript 静默返回 0(无异常),违反 spec §4/§9 "转换失败→跳过+记 error"。
\t\t# 先 is_valid_* 校验,失败返回 null → 命中 _errors.append(type convert failed) 路径,杜绝损坏数据静默归零。
\t\tTYPE_INT:
\t\t\tif not raw.is_valid_int(): return null
\t\t\treturn int(raw)
\t\tTYPE_FLOAT:
\t\t\treturn _safe_float(raw)
\t\tTYPE_STRING: return raw
\t\tTYPE_BOOL:
\t\t\tvar l := raw.to_lower()
\t\t\treturn l == "true" or l == "1"
\t\tTYPE_VECTOR2:
\t\t\tvar p: PackedStringArray = raw.split(",")
\t\t\tif p.size() >= 2:
\t\t\t\tvar fx: Variant = _safe_float(p[0])
\t\t\t\tvar fy: Variant = _safe_float(p[1])
\t\t\t\tif fx == null or fy == null: return null
\t\t\t\treturn Vector2(float(fx), float(fy))
\t\tTYPE_COLOR:  # Godot 4: TYPE_COLOR=20 (Godot 3: 12)。用符号常量跨版本正确。
\t\t\t# 审查 I-2(2026-07-05): Color.html 对无效 hex 静默归零 Color(0,0,0,1)(不抛错),
\t\t\t# 破坏 F-8 "失败应记 error" 语义一致性 → CSV 颜色写错时落盘黑色 + stats.generated 谎报。
\t\t\t# is_valid_html_color 校验,失败返回 null 命中 type convert failed error。
\t\t\tif raw.begins_with("#"):
\t\t\t\tif not raw.is_valid_html_color(): return null
\t\t\t\treturn Color.html(raw)
\t\t\tvar c: PackedStringArray = raw.split(",")
\t\t\tif c.size() >= 3:
\t\t\t\tvar cr: Variant = _safe_float(c[0])
\t\t\t\tvar cg: Variant = _safe_float(c[1])
\t\t\t\tvar cb: Variant = _safe_float(c[2])
\t\t\t\tif cr == null or cg == null or cb == null: return null
\t\t\t\treturn Color(float(cr), float(cg), float(cb))
\t\tTYPE_PACKED_STRING_ARRAY, TYPE_ARRAY:
\t\t\treturn raw.split(",")
\treturn null

# C7: 递归扫 base 下 *.tmp.tres 删除（跨 output_dir 残留自清），对齐 godot_operations.gd
# find_files 模式（跳过 . 前缀目录如 .godot + depth≤10 防深递归）。原 P2-1 只扫 _output_dir，
# 换 output_dir 后旧目录 .tmp.tres 残留不扫。每进程 _initialize 跑一次（data-import 模板 extends SceneTree）。
func _clean_tmp_global(base: String, depth: int = 0) -> void:
\tif depth > 10:
\t\treturn
\tvar d = DirAccess.open(base)
\tif d == null:
\t\treturn
\td.list_dir_begin()
\tvar fn = d.get_next()
\twhile fn != "":
\t\tif d.current_is_dir() and not fn.begins_with("."):
\t\t\t_clean_tmp_global(base + fn + "/", depth + 1)
\t\telif fn.ends_with(".tmp.tres"):
\t\t\td.remove(fn)
\t\tfn = d.get_next()
\td.list_dir_end()

func _initialize():
\tvar Class = load(_class_path)
\tif Class == null:
\t\t_errors.append({"row": 0, "reason": "load class failed: " + _class_path})
\t\t_mcp_done(); return
\tvar inst0 = Class.new()
\tvar cls_name: String = inst0.get_class()
\tvar all_props: Array = inst0.get_property_list()
\tvar fields: Array = []
\tfor p in all_props:
\t\t# PROPERTY_USAGE_SCRIPT_VARIABLE: Godot 4.x=4096, Godot 3.x=8192。用符号常量跨版本正确。
\t\tif (p.usage & PROPERTY_USAGE_SCRIPT_VARIABLE) != 0:
\t\t\tfields.append(p)
\tvar f := FileAccess.open(_csv_path, FileAccess.READ)
\tif f == null:
\t\t_errors.append({"row": 0, "reason": "open csv failed"}); _mcp_done(); return
\tvar header: PackedStringArray = f.get_csv_line()
\tvar fn_idx: int = header.find(_filename_col)
\tif fn_idx == -1:
\t\t_errors.append({"row": 0, "reason": "filename_column not found: " + _filename_col}); _mcp_done(); return
\t# Godot 4.x API(3.x 为 make_dir_recursive)。spec 仅承诺 4.x,故用 4.x 名。
\t# F-6(2026-07-04 审查): make_dir_recursive_absolute 返回 Error,失败 early return(防后续 save 全失败仍谎报)。
\tvar mkdir_err: int = DirAccess.make_dir_recursive_absolute(_output_dir)
\tif mkdir_err != OK:
\t\t_errors.append({"row": 0, "reason": "create output dir failed: " + str(mkdir_err)})
\t\t_mcp_done(); return
\t# C7: 扫 res:// 全局 *.tmp.tres（跨 output_dir 残留自清），对齐 godot_operations.gd _clean_atomic_tmp。
\t# _clean_tmp_global 递归 + 跳过 .godot + depth≤10。原 P2-1 只扫 _output_dir，换 output_dir 后旧目录残留。
\t_clean_tmp_global("res://")
\tvar fn_re := RegEx.create_from_string("^[A-Za-z0-9_.-]+$")
\twhile not f.eof_reached():
\t\tvar row: PackedStringArray = f.get_csv_line()
\t\tif row.size() == 0 or (row.size() == 1 and row[0] == ""): continue
\t\t_row_count += 1
\t\tvar filename: String = row[fn_idx] if fn_idx < row.size() else ""
\t\tif filename == "":
\t\t\t_errors.append({"row": _row_count, "reason": "empty filename"}); _failed += 1; continue
\t\t# CRITICAL-2: filename 白名单 + 段级拒 ..
\t\tvar segs: PackedStringArray = filename.split("/")
\t\tvar has_dotdot := false
\t\tfor seg in segs:
\t\t\tif seg == "..": has_dotdot = true
\t\tif not fn_re.search(filename) or has_dotdot:
\t\t\t_errors.append({"row": _row_count, "value": filename, "reason": "invalid filename"}); _failed += 1; continue
\t\tvar res = Class.new()
\t\tfor field in fields:
\t\t\tvar col: int = header.find(field.name)
\t\t\tif col == -1: continue  # 缺失列 → 保留默认
\t\t\tif col >= row.size(): continue
\t\t\tvar raw: String = row[col]
\t\t\tif raw == "": continue  # 空单元格 → 保留默认(防空串覆盖)
\t\t\tvar converted: Variant = _type_convert(raw, field, cls_name)
\t\t\tif converted == null:
\t\t\t\t_errors.append({"row": _row_count, "field": field.name, "value": raw, "reason": "type convert failed"}); continue
\t\t\tres.set(field.name, converted)
\t\tvar full_path: String = _output_dir + "/" + filename + ".tres"
\t\t# P2-1: tmp+rename 原子提交。kill 落在 save(tmp) 中途→tmp 半截 full_path 旧(不损);
\t\t# rename 后→full_path 完整。full_path 永不半截→Godot 启动不 parse error→不阻塞加载。
\t\tvar tmp_path: String = full_path.get_basename() + ".tmp.tres"
\t\t# F-5(2026-07-04 审查): ResourceSaver.save 返回 Error,失败记 error + continue(不谎报 generated)。
\t\tvar save_err: int = ResourceSaver.save(res, tmp_path)
\t\tif save_err != OK:
\t\t\t_errors.append({"row": _row_count, "value": filename, "reason": "save failed: " + str(save_err)})
\t\t\t_failed += 1
\t\t\tcontinue
\t\tvar rename_err: int = DirAccess.rename_absolute(tmp_path, full_path)
\t\tif rename_err != OK:
\t\t\tDirAccess.remove_absolute(tmp_path)
\t\t\t_errors.append({"row": _row_count, "value": filename, "reason": "rename failed: " + str(rename_err)})
\t\t\t_failed += 1
\t\t\tcontinue
\t\t_generated.append(full_path)
\t_mcp_done()

# _mcp_done 输出 success:true 即使 _errors 非空(errors 通过 outputs[].errors 数组传,不通过 success 字段)。
# handler 侧读 data.errors 拿错误列表,不用 success 判断有无错误。
# F-5/F-6 的部分失败(单个 save/mkdir 失败 early return)也走此路径,保持 success:true 语义一致
# (headless 管道 executeGdscript.run_success 仅反映脚本是否跑完,不反映业务错误)。
func _mcp_done():
\t_mcp_output("generated", _generated); _mcp_output("errors", _errors)
\t_mcp_output("stats", {"rows": _row_count, "generated": _generated.size(), "failed": _failed})
\tprint("${MARKER_RESULT}" + JSON.stringify({"success": true, "outputs": _mcp_outputs})); quit()
`;

export function generateImportScript(o: ImportScriptOpts): string {
  return GDSCRIPT_TEMPLATE(o.classPath, o.outputDir, o.filenameCol, o.csvTmpPath);
}

// ─── T4: writeTmpCsv + csvToResources action handler ──────────────────────────

import { writeFileSync, readFileSync, unlinkSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { textResult } from '../types.js';
import { opsErrorResult } from '../core/shared/errors.js';
import { resolveWithinRoot, normalizeUserProjectPath, requireProjectPath } from '../helpers.js';
import { executeGdscriptTrusted as executeGdscript } from '../gdscript-executor.js';

/** CSV 字节上限(F-7 防 OOM/tmpdir 满,复发 tscn-parser-no-byte-limit 同构)。
 *  handleTool 入口校验 csv_content/csv_path;writeTmpCsv 内部再校验作不变量(P3 防御纵深:
 *  防未来新增调用方绕过 handleTool 直接调本函数)。 */
export const MAX_CSV_BYTES = 10 * 1024 * 1024; // 10MB

/** 写 CSV 文本到 OS 临时目录,返回绝对路径。csvToResources 用它把 csv_content 传给 GDScript FileAccess。 */
export function writeTmpCsv(text: string): string {
  // P3 不变量防御:正常路径下 handleTool 已在 F-7 守卫,此处不会触发;仅防御绕过 handleTool 的调用方。
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_CSV_BYTES) {
    throw new Error(`csv content exceeds ${MAX_CSV_BYTES} bytes limit (${bytes} bytes)`);
  }
  const p = join(tmpdir(), `csv-import-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  writeFileSync(p, text, 'utf8');
  return p;
}

const ACTIONS = ['csv_to_resources'] as const;

// ─── Tool definition ──────────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'csv_to_resources',
      description: 'CSV→Resource 批量生成。读取 CSV(class_path 指向的 GDScript Resource 类),按 filename_column 列命名,批量生成 .tres 到 output_dir。CSV 行数据走 GDScript FileAccess.get_csv_line(零进脚本字符串,防注入)。output_dir 经 resolveWithinRoot 沙箱(TS pre);filename 白名单(GDScript 正则 + .. 段级拒)。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型（当前仅 csv_to_resources=CSV 批量实例化 Resource 并导出）',
          },
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          class_path: { type: 'string', description: 'GDScript Resource 类路径(如 res://item.gd),CSV 每行实例化此类' },
          output_dir: { type: 'string', description: '输出目录(项目内,res:// 或相对路径,经沙箱校验)' },
          filename_column: { type: 'string', description: 'CSV 中作为输出文件名的列名' },
          csv_content: { type: 'string', description: 'CSV 文本内容(与 csv_path 二选一)' },
          csv_path: { type: 'string', description: 'CSV 文件路径(项目内,与 csv_content 二选一)' },
          timeout: {
            type: 'number',
            description: 'GDScript 执行超时秒数(大批量 CSV 可调大,默认 60)',
            optional: true,
            default: 60,
          },
        },
        required: ['action', 'project_path', 'class_path', 'output_dir', 'filename_column'],
      },
    },
  ];
}

// ─── Tool handler ────────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'csv_to_resources') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }

  // A2 (2026-07-13 enhanced-vs-godogen 对比测试核实): 用 args.project_path(对齐 verify_delivery
  // delivery.ts:218 等), 非 ctx.projectDir —— 后者是全局 process-state(getProjectDir 初始 ''),
  // 未先 run_project/launch_editor 时为 '' → resolveWithinRoot('', csv_path) base=process.cwd()
  // → 文件在 args.project_path 却查找在 cwd → "csv_path not found"(实测复现, run4.mjs)。
  const projectPath = requireProjectPath(args);
  const classPath = args.class_path as string;
  const outputDir = args.output_dir as string;
  const filenameCol = args.filename_column as string;

  if (!classPath || !outputDir || !filenameCol) {
    return opsErrorResult('INVALID_PARAMS', 'class_path, output_dir, filename_column are required');
  }

  // I-3: csv_content/csv_path 必须提供其一,否则 parseCsv("") 返回误导性 "empty csv"。
  // 显式校验给出准确的 INVALID_PARAMS 错误,而非把"未提供"伪装成"内容为空"。
  if (!args.csv_content && !args.csv_path) {
    return opsErrorResult('INVALID_PARAMS', 'csv_content or csv_path is required');
  }

  // CSV 来源:csv_content 优先,否则 csv_path(项目内沙箱读取)。
  // F-7 字节上限:csv_content 分支由 Buffer.byteLength 守卫;csv_path 分支必须先 statSync 预检
  // (P1-2,2026-07-05 复审:防 readFileSync 阶段 OOM —— 大文件在字节守卫前已全量载入内存,
  // 复发 tscn-parser-no-byte-limit 同构)。resolveWithinRoot 在 statSync 前(先沙箱后读)。
  // MAX_CSV_BYTES 是模块级 export 常量(writeTmpCsv 共用)。
  let csvContent: string;
  if (args.csv_content) {
    // C6: 前置 size 守卫(对齐 csv_path 分支 :328 statSync 预检)。后置 :337 太晚——
    // MCP SDK JSON.parse 阶段已载入 args.csv_content,超大字符串在此前已 OOM。
    const contentBytes = Buffer.byteLength(args.csv_content as string, 'utf8');
    if (contentBytes > MAX_CSV_BYTES) {
      return opsErrorResult('INVALID_PARAMS', `csv_content exceeds ${MAX_CSV_BYTES} bytes limit (${contentBytes} bytes)`);
    }
    csvContent = args.csv_content as string;
  } else if (args.csv_path) {
    const csvAbsPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.csv_path as string));
    // existsSync 短路(审查 I-1,对齐 android.ts:162/180 惯例):文件不存在时返回精确 INVALID_PARAMS,
    // 而非让 statSync 抛 ENOENT 走 ToolDispatcher 通用 catch 降级为 TOOL_ERROR(错误码精度退化)。
    if (!existsSync(csvAbsPath)) {
      return opsErrorResult('INVALID_PARAMS', `csv_path not found: ${args.csv_path as string}`);
    }
    const size = statSync(csvAbsPath).size;
    if (size > MAX_CSV_BYTES) {
      return opsErrorResult('INVALID_PARAMS', `csv_path file exceeds ${MAX_CSV_BYTES} bytes limit (${size} bytes)`);
    }
    csvContent = readFileSync(csvAbsPath, 'utf8');
  } else {
    csvContent = '';
  }
  // F-7(2026-07-04 审查)字节上限(csv_content 分支主守卫;csv_path 已由 statSync 预检,此处作不变量复核)。
  // csvBytes 缓存避免重复 O(n) 扫描(P3 微优化)。
  const csvBytes = Buffer.byteLength(csvContent, 'utf8');
  if (csvBytes > MAX_CSV_BYTES) {
    return opsErrorResult('INVALID_PARAMS', `csv_content exceeds ${MAX_CSV_BYTES} bytes limit (${csvBytes} bytes)`);
  }

  // 前置校验:parseCsv 解析 header(filename_column 必须在 header 中)
  const parsed = parseCsv(csvContent);
  if (!parsed.ok || !parsed.headers!.includes(filenameCol)) {
    return opsErrorResult('INVALID_PARAMS', parsed.error ?? `filename_column "${filenameCol}" not in CSV header`);
  }

  // CRITICAL-2: output_dir 沙箱(TS pre,防路径遍历)。越界 throw 由 ToolDispatcher 统一捕获。
  // T7 修订:res:// 前缀必须先剥离(resolveWithinRoot 不识别 res://,会生成 real-project\res:\... 畸形路径)。
  const safeOutputDir = resolveWithinRoot(projectPath, normalizeUserProjectPath(outputDir));

  // A1 (2026-07-23 安全): classPath 经 root 校验——经 executeGdscriptTrusted 跳沙箱 + load() + Class.new()，
  // 越权路径 = RCE（gdscript-template-injection 复发实例，defects.ts:55）。对齐 outputDir 沙箱模式。
  // I1 fix(2026-07-23 final review): resolveWithinRoot 仅校验，不用返回值（绝对路径会让
  // load() 收到 "D:\..." 而非 res:// 格式，功能性回归）。normalizeUserProjectPath 剥了 res://
  // 前缀，load() 需要补回 res://。穿越由 resolveWithinRoot 校验拒绝。
  const normalizedClassPath = normalizeUserProjectPath(classPath);
  resolveWithinRoot(projectPath, normalizedClassPath);  // 仅校验, throw if 越界（堵 RCE 穿越链）
  const safeClassPath = 'res://' + normalizedClassPath;  // load() 需要 res:// 格式

  // 写临时 CSV(GDScript FileAccess 读,数据零进脚本源码 = CRITICAL-1 注入根治)
  const csvTmpPath = writeTmpCsv(csvContent);
  try {
    const godot = await ctx.findGodot();
    const script = generateImportScript({ classPath: safeClassPath, outputDir: safeOutputDir, filenameCol, csvTmpPath });
    const r = await executeGdscript({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: validateTimeout(args.timeout, 5, 300, 60),
      loadAutoloads: false,
    });

    if (!r.compile_success) {
      return opsErrorResult('SCRIPT_EXEC_FAILED', r.compile_error);
    }
    if (!r.run_success) {
      return opsErrorResult('SCRIPT_EXEC_FAILED', r.run_error);
    }

    // 输出走 MARKER_RESULT 协议:executeGdscript 解析 outputs[](value 为 JSON 字符串)。
    // GDScript 侧 _mcp_output 已将 value 经 JSON.stringify 编码,这里 JSON.parse 还原。
    const data: Record<string, unknown> = {};
    for (const entry of r.outputs) {
      try {
        data[entry.key] = JSON.parse(entry.value);
      } catch {
        data[entry.key] = entry.value; // 非 JSON,保留原始字符串
      }
    }
    return textResult(JSON.stringify({
      generated: data['generated'] ?? [],
      errors: data['errors'] ?? [],
      stats: data['stats'] ?? {},
    }));
  } finally {
    try { unlinkSync(csvTmpPath); } catch { /* 已删或清理失败,忽略 */ }
  }
}

// ─── Tool metadata ────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks: Record<string, RiskLevel> }> = {
  csv_to_resources: {
    readonly: false,
    long_running: true, // 启动 Godot headless 执行 GDScript,耗时较长
    // 写 .tres 文件到 output_dir → 'write',guard.ts requiresConfirmation 触发确认令牌。
    // 须在 test/risk-coverage.test.ts 的 GUARDED_KEYS 内,否则零行为改变不变量测试失败。
    actionRisks: { csv_to_resources: 'write' },
  },
};
