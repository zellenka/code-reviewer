// vsce packages README.md and LICENSE from the extension folder, but the
// source of truth lives at the repo root. Copy them in right before packaging.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const pkg = new URL('../', import.meta.url);

for (const file of ['README.md', 'LICENSE']) {
  copyFileSync(fileURLToPath(new URL(file, root)), fileURLToPath(new URL(file, pkg)));
}
