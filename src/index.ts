import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { GodotServer } from './GodotServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// P0.1: READ_ONLY_MODE + P0.2: --lite mode
const args = process.argv.slice(2);
const mode = args.includes('--lite') ? 'lite'
  : process.env.GODOT_MCP_MODE === 'lite' ? 'lite'
  : 'full';
const readOnly = process.env.READ_ONLY_MODE === 'true';

const server = new GodotServer(join(__dirname, 'scripts', 'godot_operations.gd'), { mode, readOnly });
server.run().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', msg);
  process.exit(1);
});
