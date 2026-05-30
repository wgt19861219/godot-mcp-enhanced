import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { GodotServer } from './GodotServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const toolMode = args.includes('--minimal') ? 'minimal'
  : args.includes('--lite') ? 'lite'
  : process.env.GODOT_MCP_MODE === 'minimal' ? 'minimal'
  : process.env.GODOT_MCP_MODE === 'lite' ? 'lite'
  : 'full';

const connectionMode = process.env.GODOT_MCP_MODE === 'editor' ? 'editor' : 'headless';
const readOnly = process.env.GODOT_MCP_READ_ONLY === 'true' || process.env.READ_ONLY_MODE === 'true';
const noFallback = process.env.GODOT_MCP_NO_FALLBACK === 'true';

const server = new GodotServer(join(__dirname, 'scripts', 'godot_operations.gd'), {
  mode: toolMode,
  connectionMode,
  readOnly,
  noFallback,
});

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[godot-mcp] Received ${signal}, shutting down...`);
  try {
    await server.close();
  } catch (err) {
    console.error('[godot-mcp] Error during shutdown:', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.run().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', msg);
  process.exit(1);
});
