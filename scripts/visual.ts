import { createTestRenderer } from '@opentui/core/testing';
import { App } from '../src/app.ts';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('docs/previews', { recursive: true });
const escape = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
for (const [width,height] of [[120,30],[80,24],[50,15]]) {
  const setup = await createTestRenderer({ width,height });
  const app = new App(setup.renderer, '/projects/under');
  try {
    await setup.flush();
    const frame = setup.captureCharFrame();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width! * 9 + 24}" height="${height! * 18 + 24}"><rect width="100%" height="100%" fill="#101014"/><g fill="#dddde5" font-family="DejaVu Sans Mono, monospace" font-size="14">${frame.split('\n').map((line,i)=>`<text x="12" y="${24+i*18}" xml:space="preserve">${escape(line)}</text>`).join('')}</g></svg>`;
    await writeFile(`docs/previews/layout-${width}.svg`,svg);
  } finally { app.disposeUI(); await setup.dispose(); }
}
