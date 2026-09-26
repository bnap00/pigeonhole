/**
 * tsc only emits .ts output, so the UI's static files are copied into dist
 * after a build. Keeping the UI dependency-free is what makes this two lines
 * rather than a bundler config.
 */
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/ui', { recursive: true });
await cp('src/ui', 'dist/ui', { recursive: true });
process.stdout.write('copied src/ui -> dist/ui\n');
