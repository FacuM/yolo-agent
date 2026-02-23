const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const extensionBuild = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
};

/** @type {esbuild.BuildOptions} */
const testBuild = {
  entryPoints: [
    'test/e2e/extension.test.ts',
    'test/e2e/runTests.ts',
    'test/e2e/index.ts',
  ],
  bundle: true,
  outdir: 'out/test/e2e',
  external: ['vscode', 'mocha', '@vscode/test-electron'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
};

async function main() {
  if (isWatch) {
    const ctx1 = await esbuild.context(extensionBuild);
    const ctx2 = await esbuild.context(testBuild);
    await Promise.all([ctx1.watch(), ctx2.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionBuild),
      esbuild.build(testBuild),
    ]);
    console.log('Build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
