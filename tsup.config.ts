import { defineConfig } from 'tsup';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  outDir: 'dist',
  outExtension() {
    return { js: '.js' };
  },
  async onSuccess() {
    await copyDir('src/packs', 'dist/packs');
  }
});
