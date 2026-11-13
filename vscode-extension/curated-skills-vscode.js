'use strict';

const { CuratedSkillsIntegration } = require('./curated-skills-integration');
const { validateRepositoryUrl } = require('./curated-skills-integration');
const {
  createCuratedSkillsAuthentication, repositoryKey, validateAccessToken, CuratedSkillsAuthenticationFailure
} = require('./curated-skills-auth');

function registerCuratedSkillsIntegration(vscode, context, { getConfiguration, log, isDevelopment }) {
  const authentication = createCuratedSkillsAuthentication({ secrets: context.secrets });
  const integration = new CuratedSkillsIntegration({ log, gitFactory: repositoryUrl => authentication.getGit(repositoryUrl) });
  class UserInputFailure extends Error {}
  function configuredRepository(httpsOnly = false) {
    let repository;
    try { repository = validateRepositoryUrl(getConfiguration()?.repositoryUrl); }
    catch { throw new UserInputFailure('Set bcDevToolset.curatedSkillsRepositoryUrl in User settings to a GitHub repository URL without credentials.'); }
    if (httpsOnly && !repository.url.toLowerCase().startsWith('https://')) {
      throw new UserInputFailure('Access tokens require an HTTPS GitHub URL. Set curatedSkillsRepositoryUrl to its HTTPS URL, or keep SSH and configure your SSH key or agent instead.');
    }
    return repository;
  }
  function credentialStorage(method) {
    if (typeof context.secrets?.[method] !== 'function') {
      throw new UserInputFailure('VS Code encrypted secret storage is unavailable. Reload VS Code and check the operating system credential service before retrying.');
    }
    return context.secrets;
  }
  function safeFailure(error, stage, sideEffects) {
    const knownCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ABORT_ERR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']);
    const code = Number.isInteger(error?.code) || knownCodes.has(error?.code) ? ` (code ${error.code})` : '';
    const reason = error instanceof UserInputFailure || error instanceof CuratedSkillsAuthenticationFailure
      ? error.message
      : ['EACCES', 'EPERM'].includes(error?.code) ? 'Access was denied. Check VS Code and operating system credential-service permissions.'
        : 'The operation failed for an unknown reason. Reload VS Code and check the operating system credential service and Git access.';
    const effect = sideEffects === 'unknown'
      ? 'The credential-write outcome is unknown; inspect or replace/remove the token for this repository before retrying. No checkout or adapter maintenance was started.'
      : sideEffects === 'completed' ? 'The credential change completed; checkout and adapter maintenance was not started.'
        : 'No toolset credential changes, checkout updates or adapter maintenance were started.';
    return `BC Dev Toolset: ${stage} failed${code}. ${reason} ${effect}`;
  }
  async function developmentCommand() {
    if (!isDevelopment()) return false;
    try {
      await vscode.window.showInformationMessage('BC Dev Toolset: Extension Development Hosts skip personal curated-source authentication commands.');
    } catch {
      try { log('Curated source authentication command skipped in the Extension Development Host; its notification could not be displayed. No authentication work was started.'); }
      catch { /* The command still returns failure when the notification and logging are unavailable. */ }
    }
    return true;
  }
  async function configureToken() {
    if (await developmentCommand()) return false;
    let stage = 'Configure Curated Skills Access Token configuration';
    let sideEffects = 'not-started';
    try {
      const repository = configuredRepository(true);
      const storage = credentialStorage('store');
      stage = 'Configure Curated Skills Access Token input';
      const input = await vscode.window.showInputBox({
        title: `Curated skills access token for ${repository.identity}`,
        prompt: 'Enter a GitHub token with read access to this repository. It will be stored in VS Code encrypted secret storage.',
        password: true, ignoreFocusOut: true
      });
      if (input === undefined) return false;
      const token = validateAccessToken(input);
      if (configuredRepository(true).identity !== repository.identity) {
        throw new UserInputFailure('The configured repository changed while the token prompt was open. No token was stored; run Configure Curated Skills Access Token again for the intended repository.');
      }
      stage = 'Configure Curated Skills Access Token encrypted storage';
      sideEffects = 'unknown';
      await storage.store(repositoryKey(repository.url), token);
      sideEffects = 'completed';
      stage = 'Configure Curated Skills Access Token notification';
      await vscode.window.showInformationMessage(`BC Dev Toolset: Stored the access token for ${repository.identity}. Run Check Curated Skills Access to verify access, then Update Curated Skills to maintain the checkout.`);
      return true;
    } catch (error) {
      await vscode.window.showErrorMessage(safeFailure(error, stage, sideEffects));
      return false;
    }
  }
  async function removeToken() {
    if (await developmentCommand()) return false;
    let stage = 'Remove Curated Skills Access Token configuration';
    let sideEffects = 'not-started';
    try {
      const repository = configuredRepository();
      const storage = credentialStorage('delete');
      stage = 'Remove Curated Skills Access Token encrypted storage';
      sideEffects = 'unknown';
      await storage.delete(repositoryKey(repository.url));
      sideEffects = 'completed';
      stage = 'Remove Curated Skills Access Token notification';
      await vscode.window.showInformationMessage(`BC Dev Toolset: Removed the access token for ${repository.identity}. Future access uses configured Git credentials or SSH authentication. The checkout and adapters were retained.`);
      return true;
    } catch (error) {
      await vscode.window.showErrorMessage(safeFailure(error, stage, sideEffects));
      return false;
    }
  }
  async function checkAccess() {
    if (await developmentCommand()) return false;
    let stage = 'Check Curated Skills Access configuration';
    try {
      const repository = configuredRepository();
      stage = 'Check Curated Skills Access repository read';
      const result = await authentication.checkAccess(repository.url);
      stage = 'Check Curated Skills Access notification';
      await vscode.window.showInformationMessage(`BC Dev Toolset: Access to ${repository.identity} succeeded using ${result.authentication === 'stored-token' ? 'the stored access token' : 'configured Git or SSH authentication'}. No checkout or adapters were changed.`);
      return true;
    } catch (error) {
      await vscode.window.showErrorMessage(safeFailure(error, stage, 'not-started'));
      return false;
    }
  }
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
    vscode.commands.registerCommand('bcDevToolset.configureCuratedSkillsAccessToken', configureToken),
    vscode.commands.registerCommand('bcDevToolset.removeCuratedSkillsAccessToken', removeToken),
    vscode.commands.registerCommand('bcDevToolset.checkCuratedSkillsAccess', checkAccess),
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
