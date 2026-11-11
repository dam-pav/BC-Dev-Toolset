'use strict';

// BcContainerHelper embeds docker-run arguments in native failures. Those may
// contain encrypted passwords and key locations, even without plaintext secrets.
// Keep the failure cause/status while omitting the complete argument-bearing line.
function redactContainerHelperCommandLines(value) {
  return String(value || '').replace(
    /^.*(?:Commandline:\s*docker\s+run\b|--env\s+(?:securePassword|passwordKeyFile)\s*=).*$/gim,
    '[container helper command line omitted: credential arguments]'
  );
}

module.exports = { redactContainerHelperCommandLines };
