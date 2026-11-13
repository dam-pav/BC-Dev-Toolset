'use strict';

const { CuratedSkillsIntegration } = require('./curated-skills-integration');

function registerCuratedSkillsIntegration(vscode, context, { getConfiguration, log, isDevelopment }) {
  const integration = new CuratedSkillsIntegration({ log });
  async function reconcile() {
    if (isDevelopment()) {
      integration.status = { state: 'skipped', reason: 'Extension Development Hosts do not maintain personal curated checkouts or adapters.', adapters: [], sideEffects: 'not-started' };
      return integration.status;
    }
    try { return await integration.reconcile(getConfiguration()); }
    catch {
      integration.status = { state: 'error', adapters: [], sideEffects: 'unknown', error: 'Curated skills configuration or maintenance could not complete. Inspect the checkout and personal adapters with Show Curated Skills Status, check both curated skills User settings, and reload VS Code before retrying.' };
      return integration.status;
    }
  }
  async function showStatus() {
    try {
      const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(integration.status, null, 2) });
      await vscode.window.showTextDocument(document, { preview: true });
      return true;
    } catch {
      await vscode.window.showErrorMessage('BC Dev Toolset: Show Curated Skills Status could not open the report. No maintenance was started by the status command. Reload the VS Code window and retry; maintenance results are also available in the BC Dev Toolset output channel.');
      return false;
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('bcDevToolset.updateCuratedSkills', async () => {
      const status = await reconcile();
      const displayed = await showStatus();
      if (status.state === 'error' || status.state === 'busy' || status.updateFailed) {
        await vscode.window.showErrorMessage(status.error || status.warnings.find(message => message.includes('fast-forward update failed')) || 'Curated skills update failed. Existing usable content was retained. Run Show Curated Skills Status and inspect the checkout before retrying Update Curated Skills.');
        return false;
      }
      return displayed;
    }),
    vscode.commands.registerCommand('bcDevToolset.showCuratedSkillsStatus', showStatus),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('bcDevToolset.curatedSkillsRepositoryUrl') || event.affectsConfiguration('bcDevToolset.curatedSkillsPath')) void reconcile();
    })
  );
  void reconcile();
  return integration;
}

module.exports = { registerCuratedSkillsIntegration };
