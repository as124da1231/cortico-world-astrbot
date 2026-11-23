/**
 * 打包 Coo 侧面板，用内容摘要更新宿主加载的资源路径。
 *
 * 只把类型从 `cortico` 引入，运行时不依赖核心包；CSS 由 esbuild 抽到旁边。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: ['src/webui/client.ts'],
  outfile: 'dist/webui.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'edge110', 'safari16'],
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  write: false,
  logLevel: 'info',
});

const manifestPath = 'package.json';
const source = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(source);
const fields = { '.js': 'webUiClient', '.css': 'webUiStyle' };
const keep = new Set();
await mkdir('dist', { recursive: true });
for (const { path, contents } of outputFiles) {
  const extension = extname(path);
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 12);
  const name = `webui-${hash}${extension}`;
  const file = `dist/${name}`;
  await writeFile(file, contents);
  manifest.cortico[fields[extension]] = file;
  keep.add(name);
}

const updated = JSON.stringify(manifest, null, 2) + '\n';
if (updated !== source) await writeFile(manifestPath, updated);
for (const name of await readdir('dist')) {
  if (/^webui(?:-[a-f0-9]{12})?\.(?:js|css)$/.test(name) && !keep.has(name)) {
    await unlink(join('dist', name));
  }
}
