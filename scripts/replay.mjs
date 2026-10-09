#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createReplayServer } from './lib/replay-server.mjs';

const index = process.argv.indexOf('--port');
const port = index < 0 ? 8792 : Number(process.argv[index + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be between 1 and 65535');
const server = createReplayServer(fileURLToPath(new URL('../', import.meta.url)));
server.listen(port, '127.0.0.1', () => console.log(`Open http://localhost:${port}/test/replay/`));
