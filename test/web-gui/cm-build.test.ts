// 构建产物存在性(spec §5.1/任务 3);本地未 build 时 skip(红=提示先 npm run build)。
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'build', 'web-gui', 'assets');
const built = existsSync(assetsDir);

describe.skipIf(!built)('CodeMirror 构建产物(spec §5.1,6 文件)', () => {
  for (const f of ['codemirror.js', 'codemirror.css', 'mode-python.js', 'mode-javascript.js', 'mode-markdown.js', 'mode-xml.js']) {
    it(`${f} 存在且非空`, () => {
      const p = join(assetsDir, f);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(100);
    });
  }
  it('codemirror.js 是 CM5 UMD(挂 window.CodeMirror 的 defineMode 机制)', () => {
    const js = readFileSync(join(assetsDir, 'codemirror.js'), 'utf-8');
    expect(js).toContain('CodeMirror');
  });
});
