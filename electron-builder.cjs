'use strict';

const path = require('node:path');
const fs = require('node:fs');
process.env.ELECTRON_BUILDER_CACHE ||= path.resolve(__dirname, 'out/builder-cache');

module.exports = {
  appId: 'com.codexplusplus.desktop',
  productName: 'Codex++',
  asar: true,
  npmRebuild: false,
  toolsets: { nsis: '1.2.1' },
  electronDist: path.join('out', `electron-${require('./package.json').devDependencies.electron}-win32-x64`),
  // Use the hashes shipped with the pinned Electron package; retain validation
  // without a second network request for SHASUMS256.txt during each build.
  electronDownload: { checksums: require('./node_modules/electron/checksums.json') },
  directories: { output: 'release', buildResources: 'electron/assets' },
  files: [
    'package.json', 'electron/*.js', 'electron/assets/**',
    'protocol_schema/typescript/ClientRequest.ts',
  ],
  extraResources: [
    { from: 'backend_official/codex-rs/target/release/codex-app-server.exe', to: 'codex-app-server.exe' },
    { from: 'backend_official/codex-rs/models-manager', to: 'core-models', filter: ['models.json', 'prompt.md'] },
    { from: 'dist', to: 'frontend' },
    { from: 'electron/resources/plugins', to: 'plugins', filter: ['**/*', '!**/.git{,/**}', '!**/__pycache__{,/**}', '!**/*.pyc', '!**/*.log', '!**/.env', '!**/.env.local'] },
    { from: 'electron', to: 'runtime', filter: ['node-repl.mjs', 'repl-kernel.mjs', 'runtime-debug.js', 'windows-host.ps1', 'runtime/**/*', '!**/__pycache__{,/**}', '!**/*.pyc'] },
    { from: process.execPath, to: 'runtime/node.exe' },
    { from: 'node_modules/smol-toml', to: 'runtime/node_modules/smol-toml' },
    { from: 'electron/runtime/sky', to: 'runtime/node_modules/@oai/sky' },
  ],
  beforePack: async () => {
    if (process.platform !== 'win32' || !/^node(?:\.exe)?$/iu.test(path.basename(process.execPath))) throw new Error('Package on Windows using Node.js');
    for (const filename of ['backend_official/codex-rs/target/release/codex-app-server.exe', 'dist/index.html', 'node_modules/smol-toml/package.json']) {
      if (!fs.statSync(filename).isFile()) throw new Error(`Missing release input: ${filename}`);
    }
  },
  afterPack: async ({ appOutDir }) => {
    await fs.promises.rm(path.join(appOutDir, 'resources', 'default_app.asar'), { force: true });
  },
  win: {
    target: [{ target: 'portable', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }],
    executableName: 'CodexPlusPlus',
    signAndEditExecutable: false,
    artifactName: 'CodexPlusPlus-${version}-${arch}.${ext}',
  },
  portable: { artifactName: 'CodexPlusPlus-${version}-${arch}-portable.exe' },
};
