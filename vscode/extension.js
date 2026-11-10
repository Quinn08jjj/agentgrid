'use strict';
const vscode = require('vscode');
const { spawn } = require('child_process');

function open() {
  // VS Code's extension host runs with ELECTRON_RUN_AS_NODE=1; if it leaks into the app, Electron starts as plain Node and exits.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn('open', ['-a', 'AgentGrid'], { env, stdio: 'ignore', detached: true });
  child.on('exit', (code) => {
    if (code !== 0) vscode.window.showErrorMessage('AgentGrid.app was not found. Install it from https://github.com/Quinn08jjj/agentgrid/releases');
  });
  child.unref();
}

exports.activate = (ctx) => ctx.subscriptions.push(vscode.commands.registerCommand('agentgrid.open', open));
exports.deactivate = () => {};
