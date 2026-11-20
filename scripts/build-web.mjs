/**
 * 打包 Coo 侧面板：src/webui/client.ts → dist/webui.js + dist/webui.css。
 *
 * 只把类型从 `cortico` 引入，运行时不依赖核心包；CSS 由 esbuild 抽到旁边。
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/webui/client.ts'],
  outfile: 'dist/webui.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'edge110', 'safari16'],
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});
