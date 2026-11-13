'use strict';

// Only recognized backend status identifiers may reach source-maintenance reports.
// Never classify a cause from exception text, stdout, stderr or other payloads.
const safeCodes = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'ETIMEDOUT', 'ENOTDIR', 'EISDIR', 'EIO',
  'EEXIST', 'EBUSY', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'ECONNRESET',
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENOTEMPTY', 'ELOOP',
  'EINVAL', 'EINTR', 'ENOSYS', 'ENOTSUP', 'ENETUNREACH', 'EHOSTUNREACH',
  'ABORT_ERR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
]);

function backendFailureDetails(error) {
  const code = error?.code;
  const statusSuffix = Number.isSafeInteger(code) || safeCodes.has(code) ? ` (code ${code})` : '';
  const reason = ['EACCES', 'EPERM'].includes(code) ? 'Access was denied. Check filesystem permissions and Git access.'
    : code === 'ENOENT' ? 'A required file or executable was not found. Ensure Git is on PATH and the configured checkout is accessible.'
      : code === 'ETIMEDOUT' ? 'The operation timed out. Check connectivity and inspect the checkout before retrying.'
        : 'The operation failed for an unknown reason.';
  return { statusSuffix, reason };
}

module.exports = { backendFailureDetails };
