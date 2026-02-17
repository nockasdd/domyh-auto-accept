import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !isWatch,
  treeShaking: true,
  metafile: true,
  logLevel: 'info',
  plugins: [
    // Load payload JS files as text strings (for CDP injection).
    // Only applies to files in src/payload/, NOT node_modules.
    {
      name: 'payload-text-loader',
      setup(build) {
        build.onLoad({ filter: /src[\\/]payload[\\/].*\.js$/ }, async (args) => {
          const fs = await import('fs');
          const contents = fs.readFileSync(args.path, 'utf-8');
          return {
            contents: `module.exports = ${JSON.stringify(contents)};`,
            loader: 'js',
          };
        });
      },
    },
    // Copy payload JS files to dist/payload/ so they are available at runtime.
    // The extension reads payloads from dist/payload/ via fs.readFileSync.
    {
      name: 'payload-copy',
      setup(build) {
        build.onEnd(async () => {
          const fs = await import('fs');
          const path = await import('path');
          const srcDir = path.resolve('src', 'payload');
          const dstDir = path.resolve('dist', 'payload');
          fs.mkdirSync(dstDir, { recursive: true });
          const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
          for (const file of files) {
            fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
          }
          console.log(`📦 Copied ${files.length} payload files to dist/payload/`);
        });
      },
    },
  ],
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('👀 Watching for changes...');
  } else {
    const result = await esbuild.build(buildOptions);
    if (result.metafile) {
      const text = await esbuild.analyzeMetafile(result.metafile);
      console.log(text);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
