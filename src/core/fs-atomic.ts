/** 共享原子写(tmp + rename)—— A-ATOMIC (2026-09-01)
 *
 * 三份重复实现(src/tools/scene/helpers.ts、src/tools/project.ts、
 * src/cli/clients/json-config.ts)的合并上移(对齐 P0-arch「shared 原语上移 core」
 * 先例),语义为三者并集:
 *  - mode 保持(对齐官方 mcp servers 562feeb「写/编辑保留文件权限」;原文件
 *    不存在时用 writeFileSync 默认 mode;Windows 上 stat.mode 无业务意义,no-op)
 *  - tmp 随机后缀(并发写同一目标不互踩)+ 失败清理
 *  - Windows rename 失败(目标被 IDE/编辑器锁定)降级直写保可用(源自 project.ts I-1;
 *    非 Windows 的 rename 失败视为真错误直接抛)
 *
 * 使用约束:覆盖**已存在的用户项目资产**(.gd/.tscn/project.godot 等)的写入点
 * 必须走本函数(存量七处已于 2026-09-02 全部收口清零);新建文件(可整体重跑)与
 * 缓存/构建产物不强制。
 */
import { writeFileSync, renameSync, statSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { randomUUID } from 'crypto';
import { getLogger } from './logger.js';

export function writeFileAtomicWithMode(filePath: string, data: string): void {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  let mode: number | undefined;
  try {
    mode = statSync(filePath).mode & 0o777;
  } catch {
    // 文件不存在(首次写入) → 跳过 mode 保持,用 writeFileSync 默认 mode
  }
  writeFileSync(tmpPath, data, mode !== undefined ? { mode, encoding: 'utf-8' } : 'utf-8');
  try {
    renameSync(tmpPath, filePath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* tmp 未创建或已被 rename 消费 */ }
    if (process.platform !== 'win32') throw e;
    getLogger().debug('fs-atomic', `atomic rename failed on Windows, falling back to direct write: ${e instanceof Error ? e.message : e}`);
    writeFileSync(filePath, data, 'utf-8');
  }
}

/** 短名别名:tools 侧覆盖用户资产(.gd/.tscn)的写入点使用。 */
export const writeFileAtomic = writeFileAtomicWithMode;


/** W5(2026-09-20 批2): ensureDir 原住 src/helpers.ts 废弃桶,收编至共享 fs 工具集。
 * 语义:确保 p 的父目录存在(不存在则递归创建)。函数体零变化,纯搬家。 */
export function ensureDir(p: string): void {
  if (!existsSync(dirname(p))) {
    mkdirSync(dirname(p), { recursive: true });
  }
}
