import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

export const slugify = (text) => String(text).toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

export const writeFile = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const DEFAULT_CONFIG = {
  title: 'DomainCatalog',
  tagline: 'Discover, explore and document your architecture.',
  base: '/',
  outDir: 'dist',
  port: 3000,
  theme: 'iris',
  logo: null,
  sourceUrl: null,
  feeds: { enabled: true, limit: 15 },
  llms: { enabled: true },
  nav: [],
  sources: [],
};

// Reads the catalog's domaincatalog.config.js.
export async function loadConfig(root) {
  for (const name of ['domaincatalog.config.js', 'domaincatalog.config.mjs']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) {
      const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      return { ...DEFAULT_CONFIG, ...module.default, _file: name };
    }
  }
  return { ...DEFAULT_CONFIG };
}
