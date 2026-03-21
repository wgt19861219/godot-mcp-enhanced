import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { GodotServer } from './GodotServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const server = new GodotServer(join(__dirname, 'scripts', 'godot_operations.gd'));
server.run().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', msg);
  process.exit(1);
});
