'use strict';

const path = require('node:path');
const { app } = require('electron');

function resourcePaths() {
  const root = path.resolve(__dirname, '..');
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
  return {
    root,
    frontend: app.isPackaged ? path.join(resources, 'frontend') : path.join(root, 'dist'),
    plugins: path.join(resources, 'plugins'),
    models: app.isPackaged ? path.join(resources, 'core-models') : path.join(root, 'backend_official', 'codex-rs', 'models-manager'),
    runtime: app.isPackaged ? path.join(resources, 'runtime') : __dirname,
    backend: app.isPackaged ? path.join(resources, 'codex-app-server.exe') : null,
  };
}

module.exports = { resourcePaths };
