'use strict';

const { BcQualityIntegration } = require('./bcquality-integration');

function registerBcQualityIntegration(vscode, context, { getPath, log, isDevelopment }) {
  const integration = new BcQualityIntegration({ log });
  async function reconcile() {
    if (isDevelopment()) {
      integration.status = { state: 'skipped', reason: 'Extension Development Hosts do not maintain personal BCQuality content or adapters.', adapters: [] };
      return integration.status;
    }
    return integration.reconcile(getPath());
  }
  async function showStatus() {
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(integration.status, null, 2) });
    await vscode.window.showTextDocument(document, { preview: true });
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('bcDevToolset.updateBcQuality', async () => {
      await reconcile();
      await showStatus();
    }),
    vscode.commands.registerCommand('bcDevToolset.showBcQualityStatus', showStatus),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('bcDevToolset.bcQualityPath')) void reconcile();
    })
  );
  void reconcile();
  return integration;
}

module.exports = { registerBcQualityIntegration };
