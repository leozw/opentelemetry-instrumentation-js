import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts', 'preload.ts'],
  dts: true,
  format: ['cjs', 'esm'],
  sourcemap: true,
  clean: true,
  target: 'node22',
  platform: 'node',
  // The vendored CJS adapter lazily loads its external matcher dependencies.
  banner: ({ format }) => format === 'esm' ? {
    js: "import { createRequire as elvenCreateRequire } from 'node:module'; const require = elvenCreateRequire(import.meta.url);",
  } : {},
});
