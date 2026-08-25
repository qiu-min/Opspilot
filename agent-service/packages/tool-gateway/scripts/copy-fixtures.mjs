import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../dist/fixtures/', import.meta.url), { recursive: true });
await cp(new URL('../src/fixtures/', import.meta.url), new URL('../dist/fixtures/', import.meta.url), {
  recursive: true,
});
