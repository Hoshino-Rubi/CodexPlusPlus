'use strict';
const path = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const { app } = require('electron');
const { resourcePaths } = require('./resource-paths');

function runtimePaths() {
  // A known primary runtime is an allowed dependency source, not a Codex profile.
  const bundle = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies');
  const select = (explicit, bundled, fallback) => explicit || (existsSync(bundled) ? bundled : fallback);
  const runtime = resourcePaths().runtime;
  const node = app.isPackaged ? path.join(runtime, 'node.exe')
    : select(process.env.CODEX_NODE_PATH, path.join(bundle, 'node/bin/node.exe'), 'node');
  const python = app.isPackaged ? (process.env.PYTHON || 'python')
    : select(process.env.PYTHON, path.join(bundle, 'python/python.exe'), 'python');
  const nodeModules = app.isPackaged ? path.join(runtime, 'node_modules')
    : select(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, path.join(bundle, 'node/node_modules'), path.resolve(__dirname, '../node_modules'));
  const bin = path.join(bundle, 'bin/override');
  const poppler = path.join(bundle, 'native/poppler/Library/bin');
  return { node, python, nodeModules, bin: !app.isPackaged && existsSync(bin) ? bin : null, poppler: !app.isPackaged && existsSync(poppler) ? poppler : null,
    artifactTool: existsSync(path.join(nodeModules, '@oai/artifact-tool/package.json')),
    libreOffice: process.env.CODEX_LIBREOFFICE_PATH || (process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'LibreOffice/program/soffice.exe') : 'soffice') };
}
module.exports = { runtimePaths };
