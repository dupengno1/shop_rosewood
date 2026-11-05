const {createWebpackConfigForProduction} = require('@commercetools-frontend/mc-scripts/webpack');

// Connect invokes mc-scripts directly. Extend its official production config
// so font localization happens before every HTML compilation, including the
// separate compile-html command that Connect runs when the container starts.
const config = createWebpackConfigForProduction();
config.plugins.push({
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('RosewoodLocalFonts', (compilation) => {
      compilation.hooks.processAssets.tapPromise({
        name: 'RosewoodLocalFonts',
        stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
      }, async () => {
        const {createLocalFontAsset, localizeFontLinks} = await import('./scripts/local-fonts.mjs');
        const templateName = 'index.html.template';
        const asset = compilation.getAsset(templateName);
        if (!asset) throw new Error('Official Merchant Center HTML template is missing.');
        const html = asset.source.source().toString();
        const placeholder = '__CDN_URL__';
        const temporaryOrigin = 'https://connect-template-fonts.invalid/';
        if (!html.includes(placeholder)) throw new Error('Official CDN placeholder is missing.');
        const fonts = await createLocalFontAsset();
        const localized = localizeFontLinks(html.replaceAll(placeholder, temporaryOrigin), fonts.fileName)
          .replaceAll(temporaryOrigin, placeholder);
        const scripts = (value) => JSON.stringify(value.match(/<script\b[^>]*>[\s\S]*?<\/script>/g));
        if (scripts(html) !== scripts(localized)) throw new Error('Font localization changed an official script.');
        const {RawSource} = compiler.webpack.sources;
        compilation.updateAsset(templateName, new RawSource(localized));
        compilation.emitAsset(fonts.fileName, new RawSource(fonts.css));
        compilation.emitAsset(fonts.licenseFileName, new RawSource(fonts.license));
      });
    });
  },
});
module.exports = config;
