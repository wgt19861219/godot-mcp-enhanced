import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { GodotServer } from './GodotServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const toolMode = args.includes('--lite') ? 'lite'
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

server.run().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', msg);
  process.exit(1);
});
