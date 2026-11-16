// Bundles the server into the single CommonJS file that devvit.json points at.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Source maps only while developing; keeps the uploaded bundle small.
  sourcemap: watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
