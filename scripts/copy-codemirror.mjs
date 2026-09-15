// 构建期拷贝 CodeMirror 5(CM5)的 6 个文件到 build/web-gui/assets/(spec §5.1)。
// 拷贝失败 throw——不静默降级,防发布残缺资产。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));   // 仓库根
const src = join(root, 'node_modules', 'codemirror');
const dst = join(root, 'build', 'web-gui', 'assets');

const FILES = [
  ['lib/codemirror.js', 'codemirror.js'],
  ['lib/codemirror.css', 'codemirror.css'],
  ['mode/python/python.js', 'mode-python.js'],
  ['mode/javascript/javascript.js', 'mode-javascript.js'],
  ['mode/markdown/markdown.js', 'mode-markdown.js'],
  ['mode/xml/xml.js', 'mode-xml.js'],
];

if (!existsSync(src)) throw new Error(`codemirror not installed: ${src} missing — run npm install`);
mkdirSync(dst, { recursive: true });
for (const [from, to] of FILES) {
  copyFileSync(join(src, from), join(dst, to));
  console.log(`Copied codemirror: ${from} -> web-gui/assets/${to}`);
}
