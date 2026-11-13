'use strict';

const { BcQualityIntegration } = require('./bcquality-integration');

function registerBcQualityIntegration(vscode, context, { getPath, log, isDevelopment }) {
  const integration = new BcQualityIntegration({ log });
  async function reconcile() {
    if (isDevelopment()) {
      integration.status = { state: 'skipped', reason: 'Extension Development Hosts do not maintain personal BCQuality content or adapters.', adapters: [] };
      return integration.status;
    }
    try { return await integration.reconcile(getPath()); }
    catch {
      integration.status = { state: 'error', adapters: [], sideEffects: 'unknown', error: 'BCQuality configuration or maintenance could not complete. Run Show BCQuality Status, inspect the checkout and personal adapters, check the bcQualityPath User setting and reload VS Code before retrying Update BCQuality.' };
      return integration.status;
    }
  }
  async function showStatus() {
    try {
      const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(integration.status, null, 2) });
      await vscode.window.showTextDocument(document, { preview: true });
      return true;
    } catch {
      await vscode.window.showErrorMessage('BCQuality: Show BCQuality Status could not open the report. No maintenance was started by the status command. Reload VS Code and retry; maintenance results are also available in the BC Dev Toolset output channel.');
      return false;
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('bcDevToolset.updateBcQuality', async () => {
      const status = await reconcile();
      const displayed = await showStatus();
      if (status.state === 'error' || status.state === 'busy' || status.updateFailed) {
        await vscode.window.showErrorMessage(status.error || status.warnings?.find(message => message.includes('fast-forward update failed')) || 'BCQuality update failed. Run Show BCQuality Status and inspect the checkout before retrying Update BCQuality.');
        return false;
      }
      return displayed;
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
