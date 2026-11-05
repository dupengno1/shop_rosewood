import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
// @ts-expect-error Build-time ESM helper intentionally has no application declaration file.
import {createLocalFontAsset, localizeFontLinks} from '../scripts/local-fonts.mjs';

test('font HTML transform removes Google requests while preserving CSP and scripts exactly', () => {
  const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-kept'; style-src fonts.googleapis.com; font-src 'self' fonts.gstatic.com data:">`;
  const scripts = [
    '<script src="https://assets.example.test/releases/runtime.123.js" defer="defer"></script>',
    '<script src="https://assets.example.test/releases/app.456.js" defer></script>',
    '<script>window.onAppLoaded=function(){return "unchanged"};</script>',
    '<script>window.app = {"customViewId":"unchanged"};</script>',
  ];
  const html = `<html><head>${csp}${scripts.slice(0,2).join('')}` +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Open+Sans&display=swap">' +
    '<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans"></noscript>' +
    '<link rel="preload" as="style" data-nimbus-fonts="" href="https://fonts.googleapis.com/css2?family=Inter">' +
    '<link rel="preload" as="style" data-mc-css href="https://assets.example.test/app.css">' +
    `</head><body><noscript>Enable JavaScript.</noscript>${scripts.slice(2).join('')}</body></html>`;
  const result = localizeFontLinks(html, 'fonts.0123456789abcdef.css');
  assert.ok(result.includes(csp));
  assert.deepEqual(result.match(/<script\b[^>]*>[\s\S]*?<\/script>/g), scripts);
  assert.doesNotMatch(result, /<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com/i);
  assert.doesNotMatch(result, /<noscript>\s*<\/noscript>/);
  assert.ok(result.includes('<noscript>Enable JavaScript.</noscript>'));
  assert.ok(result.includes('data-mc-css href="https://assets.example.test/app.css"'));
  assert.ok(result.includes('rel="preload" as="style" data-mc-css data-nimbus-fonts="" data-rosewood-local-fonts href="https://assets.example.test/releases/fonts.0123456789abcdef.css"'));
  assert.equal(localizeFontLinks(result, 'fonts.0123456789abcdef.css'), result);
  assert.throws(() => localizeFontLinks(html, '../fonts.css'), /filename/);
  assert.throws(() => localizeFontLinks('<head></head>', 'fonts.0123456789abcdef.css'), /application script/);
});

test('locked fonts retain MC family names and provide valid embedded WOFF2 with swap and licenses', async () => {
  const asset: {css: string; fileName: string; license: string; licenseFileName: string} = await createLocalFontAsset();
  assert.equal(asset.fileName, `fonts.${createHash('sha256').update(asset.css).digest('hex').slice(0,16)}.css`);
  const faces = asset.css.match(/@font-face\s*\{[^}]+\}/g)!;
  assert.equal(faces.length, 6);
  assert.equal(faces.filter(face => face.includes("font-family: 'Open Sans'")).length, 4);
  assert.equal(faces.filter(face => face.includes("font-family: 'Inter'")).length, 2);
  assert.equal(faces.filter(face => face.includes('font-style: italic')).length, 2);
  for (const face of faces) {
    assert.match(face, /font-display: swap;/);
    assert.match(face, /unicode-range: U\+/);
    const encoded = face.match(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/)![1];
    const bytes = Buffer.from(encoded, 'base64');
    assert.equal(bytes.toString('ascii',0,4), 'wOF2');
    assert.equal(bytes.readUInt32BE(8), bytes.length);
  }
  assert.doesNotMatch(asset.css, /url\((?!data:)/);
  assert.doesNotMatch(asset.css, /font-family: '[^']+ Variable'/);
  assert.match(asset.license, /@fontsource-variable\/open-sans 5\.3\.0/);
  assert.match(asset.license, /@fontsource-variable\/inter 5\.3\.0/);
  assert.match(asset.license, /SIL OPEN FONT LICENSE/);
  assert.ok(asset.css.includes(asset.licenseFileName));
});
