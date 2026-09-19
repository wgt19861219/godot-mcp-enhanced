// 批3 challenge-response 握手真机手动验证脚本(2026-09-19 首跑抓出 SECRET_LEN=32 bug)
// 手动流程(CI 无 GUI 不入自动化):
//   1. cp -r addons/godot_mcp_server test/fixtures/gdscript-check/addons/
//   2. 后台启动: "$GODOT_PATH" --headless --editor --path test/fixtures/gdscript-check
//   3. 等 .godot/mcp_editor.key 出现 + 9090 监听后: node test/fixtures/cr-handshake-e2e.mjs
//   4. PASS 判据: 本脚本 RESULT: PASS + editor 日志含 "authenticated (challenge-response)"
// 走真实 EditorConnection: auth_begin → challenge → HMAC proof → 认证后请求
import { readFileSync } from 'node:fs';
import { EditorConnection } from '../../build/core/EditorConnection.js';

const secret = readFileSync('test/fixtures/gdscript-check/.godot/mcp_editor.key', 'utf8').trim();
console.log('secret loaded, len =', secret.length);

const conn = new EditorConnection({ port: 9090, reconnect: false, secret });
try {
  await conn.connect();
  console.log('CONNECTED:', conn.isConnected());
  // 认证后全链路请求(get_godot_version 为插件已知只读 method;未知 method 也行——
  // 关键是响应来自"已认证"通道而非 -32001 Authentication required)
  try {
    const r = await conn.request('get_godot_version', {});
    console.log('request ok:', JSON.stringify(r).slice(0, 120));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('request responded (post-auth):', msg.slice(0, 120));
  }
  conn.disconnect();
  console.log('RESULT: PASS');
} catch (e) {
  console.log('RESULT: FAIL —', e instanceof Error ? e.message : String(e));
  process.exit(1);
}
