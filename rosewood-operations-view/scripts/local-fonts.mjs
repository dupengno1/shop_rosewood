import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const families = [
  {id: 'open-sans', family: 'Open Sans', weight: '300 800', styles: ['normal', 'italic']},
  {id: 'inter', family: 'Inter', weight: '100 900', styles: ['normal']},
];
const subsets = ['latin-ext', 'latin'];
const googleFontHosts = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

// Embed the locked packages' WOFF2 files in CSS. The Custom View document is
// served on the MC origin, so data: avoids a new cross-origin font permission.
export async function createLocalFontAsset() {
  const faces = [];
  const licenses = [];
  for (const font of families) {
    const packageName = `@fontsource-variable/${font.id}`;
    const readPackageFile = (file) => readFile(require.resolve(`${packageName}/${file}`));
    const metadata = JSON.parse((await readPackageFile('package.json')).toString());
    const ranges = JSON.parse((await readPackageFile('unicode.json')).toString());
    licenses.push(`${packageName} ${metadata.version}\n${await readPackageFile('LICENSE')}`);
    for (const style of font.styles) {
      for (const subset of subsets) {
        const file = `${font.id}-${subset}-wght-${style}.woff2`;
        const bytes = await readPackageFile(`files/${file}`);
        if (bytes.toString('ascii', 0, 4) !== 'wOF2' || bytes.readUInt32BE(8) !== bytes.length) {
          throw new Error(`Invalid Fontsource WOFF2 file: ${file}`);
        }
        if (!ranges[subset]) throw new Error(`Missing Fontsource unicode range: ${file}`);
        faces.push(`/* ${packageName} ${metadata.version}: ${subset} ${style} */\n@font-face {\n` +
          `  font-family: '${font.family}';\n  font-style: ${style};\n  font-display: swap;\n` +
          `  font-weight: ${font.weight};\n` +
          `  src: url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2');\n` +
          `  unicode-range: ${ranges[subset]};\n}`);
      }
    }
  }
  const licenseFileName = 'fonts.LICENSE.txt';
  const css = `/* Self-hosted Open Sans and Inter. Font licenses: ${licenseFileName} */\n${faces.join('\n\n')}\n`;
  const hash = createHash('sha256').update(css).digest('hex').slice(0, 16);
  return {css, fileName: `fonts.${hash}.css`, license: licenses.join('\n\n'), licenseFileName};
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
}

function isGoogleFontLink(tag) {
  const href = attribute(tag, 'href');
  if (!href) return false;
  try {
    return googleFontHosts.has(new URL(href, 'https://invalid.local').hostname);
  } catch {
    return false;
  }
}

// Transform only font link markup. Official scripts, their CSP hashes, and
// window.app remain byte-for-byte unchanged; no SDK or runtime config patch.
export function localizeFontLinks(html, fontFileName) {
  if (!/^fonts\.[a-f0-9]{16}\.css$/.test(fontFileName)) throw new Error('Invalid hashed font CSS filename.');
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  const entry = scripts.find((tag) => /\bdefer(?:\s|=|>)/i.test(tag) && attribute(tag, 'src'));
  const src = entry && attribute(entry, 'src');
  if (!src) throw new Error('Missing deferred application script for the font asset URL.');
  const assetUrl = new URL(fontFileName, src);
  if (assetUrl.protocol !== 'https:') throw new Error('Production font CSS must use the HTTPS application asset host.');
  if (!/<\/head\s*>/i.test(html)) throw new Error('Missing HTML head.');
  const withoutRemoteFonts = html
    .replace(/<link\b[^>]*>/gi, (tag) => isGoogleFontLink(tag) || /\bdata-rosewood-local-fonts(?:\s|=|>)/i.test(tag) ? '' : tag)
    .replace(/<noscript\b[^>]*>\s*<\/noscript\s*>/gi, '');
  return withoutRemoteFonts.replace(/<\/head\s*>/i,
    `<link rel="preload" as="style" data-mc-css data-nimbus-fonts="" data-rosewood-local-fonts href="${assetUrl.href}"></head>`);
}
