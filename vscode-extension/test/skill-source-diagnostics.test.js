'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { backendFailureDetails } = require('../skill-source-diagnostics');

test('source diagnostics preserve reviewed causes and recognized backend statuses', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const result = backendFailureDetails({ code });
    assert.equal(result.statusSuffix, ` (code ${code})`);
    assert.match(result.reason, /Access was denied.*Check filesystem permissions and Git access/);
  }
  assert.match(backendFailureDetails({ code: 'ENOENT' }).reason, /not found.*Git is on PATH.*checkout is accessible/);
  assert.match(backendFailureDetails({ code: 'ETIMEDOUT' }).reason, /timed out.*Check connectivity.*inspect the checkout before retrying/);
  for (const code of ['ENOTDIR', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ABORT_ERR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 0, 1, 128, -1]) {
    const result = backendFailureDetails({ code });
    assert.equal(result.statusSuffix, ` (code ${code})`);
    assert.equal(result.reason, 'The operation failed for an unknown reason.');
  }
});

test('source diagnostics redact backend text and unrecognized status payloads', () => {
  for (const code of ['SECRET_BACKEND_PAYLOAD', 'backend secret', '128', NaN, Infinity, 1.5, {}, null, undefined]) {
    const error = Object.assign(new Error('secret password access denied timed out'), {
      code, stdout: 'secret stdout', stderr: 'secret stderr'
    });
    assert.deepEqual(backendFailureDetails(error), {
      statusSuffix: '', reason: 'The operation failed for an unknown reason.'
    });
  }
  assert.deepEqual(backendFailureDetails(), {
    statusSuffix: '', reason: 'The operation failed for an unknown reason.'
  });
});
