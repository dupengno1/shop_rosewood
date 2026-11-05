import {spawn} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createLocalFontAsset, localizeFontLinks} from './local-fonts.mjs';

const root = process.cwd();
const surface = JSON.parse(await readFile(join(root, 'connect-surface.json'), 'utf8'));
for (const [name, expected] of Object.entries(surface.expected)) {
  if (process.env[name] !== expected) throw new Error(`${name} must match this existing Merchant Center registration (${expected}).`);
}
const applicationUrl = new URL(process.env.APPLICATION_URL || 'invalid');
if (applicationUrl.protocol !== 'https:' || applicationUrl.username || applicationUrl.password || applicationUrl.search || applicationUrl.hash) throw new Error('Connect must supply a plain HTTPS APPLICATION_URL.');
const cli = join(root, 'node_modules/@commercetools-frontend/mc-scripts/bin/cli.js');
function command(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, name], {cwd: root, stdio: 'inherit', env: {...process.env, NODE_ENV: 'production', MC_APP_ENV: 'production', BROWSER: 'none'}});
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`mc-scripts ${name} failed (${code}).`)));
  });
}
await command('build');
const fonts = await createLocalFontAsset();
await writeFile(join(root, 'public', fonts.fileName), fonts.css);
await writeFile(join(root, 'public', fonts.licenseFileName), fonts.license);
const templateFile = join(root, 'public/index.html.template');
const template = await readFile(templateFile, 'utf8');
const placeholder = '__CDN_URL__';
const temporaryOrigin = 'https://connect-template-fonts.invalid/';
if (!template.includes(placeholder)) throw new Error('Official HTML template no longer contains its CDN placeholder; review font handling before deploying.');
// Preserve every script byte and official placeholder. This also survives a later
// Connect compile-html invocation with its injected deployment URL.
const localized = localizeFontLinks(template.replaceAll(placeholder, temporaryOrigin), fonts.fileName).replaceAll(temporaryOrigin, placeholder);
if (JSON.stringify(template.match(/<script\b[^>]*>[\s\S]*?<\/script>/g)) !== JSON.stringify(localized.match(/<script\b[^>]*>[\s\S]*?<\/script>/g))) throw new Error('Font conversion unexpectedly changed an official script.');
await writeFile(templateFile, localized);
await command('compile-html');
const html = await readFile(join(root, 'public/index.html'), 'utf8');
if (/<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com/i.test(html)) throw new Error('Unexpected external font CSS in final Connect HTML.');
const runtime = JSON.parse(html.match(/window\.app\s*=\s*(\{.*?\});/s)?.[1] || 'null');
if (!runtime) throw new Error('Missing official compiled application runtime.');
if (surface.expected.CUSTOM_VIEW_ID) {
  if (runtime.customViewId !== surface.expected.CUSTOM_VIEW_ID) throw new Error('Compiled Custom View ID differs from its registration.');
} else if (runtime.applicationId !== `${surface.expected.CUSTOM_APPLICATION_ID}:${surface.expected.ENTRY_POINT_URI_PATH}` || runtime.entryPointUriPath !== surface.expected.ENTRY_POINT_URI_PATH) throw new Error('Compiled Custom Application identity differs from its registration.');
console.log(`Built Connect surface ${surface.name}; official runtime identity and local fonts verified.`);
