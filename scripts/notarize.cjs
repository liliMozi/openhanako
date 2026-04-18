const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  if (process.env.SKIP_NOTARIZE === 'true') {
    console.log('Skipping notarization (SKIP_NOTARIZE=true)');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`Notarizing ${appName}...`);

  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASSWORD;
  if (!password) {
    throw new Error('Set APPLE_APP_SPECIFIC_PASSWORD or APPLE_ID_PASSWORD for notarization');
  }

  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: password,
    teamId: process.env.APPLE_TEAM_ID,
  });

  console.log('Notarization complete.');
};
