import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { defineConfig } from 'vitest/config';

/** Recursively lists every file below `dir`. */
function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/** Files that should never be precached by the service worker. */
const SKIP = [/^sw\.js$/, /\.map$/, /^og-image\.png$/, /^robots\.txt$/, /^icons\/maskable/, /^icons\/apple/];
const FONT = /\.(woff2?|ttf)$/;
/** Only the Latin subsets are needed offline; other subsets stay network-only. */
const LATIN_FONT = /-latin-(wght|700|800)-normal-[\w-]+\.woff2$/;

/**
 * After the build, writes the list of emitted files plus a content hash into
 * dist/sw.js so the service worker can precache the app shell for offline use.
 */
function precacheServiceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'hx-precache-service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const swPath = join(outDir, 'sw.js');
      if (!existsSync(swPath)) return;
      const files = listFiles(outDir)
        .map((file) => relative(outDir, file).split(sep).join('/'))
        .filter((file) => !SKIP.some((re) => re.test(file)))
        .filter((file) => !FONT.test(file) || LATIN_FONT.test(file))
        .sort();
      // The version covers the worker's own code too, so any change rolls out a fresh cache.
      const template = readFileSync(swPath, 'utf8');
      const hash = createHash('sha256').update(template);
      for (const file of files) hash.update(file).update(readFileSync(join(outDir, file)));
      const version = hash.digest('hex').slice(0, 12);
      const source = template
        .replace('/*__HX_PRECACHE__*/[]', JSON.stringify(files.map((file) => `./${file}`)))
        .replace('__HX_VERSION__', version);
      writeFileSync(swPath, source);
      config.logger.info(`\n[hx] service worker precaches ${files.length} files (version ${version})`);
    },
  };
}

export default defineConfig({
  plugins: [precacheServiceWorker()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5180,
    strictPort: true,
  },
  preview: {
    port: 5181,
    strictPort: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
