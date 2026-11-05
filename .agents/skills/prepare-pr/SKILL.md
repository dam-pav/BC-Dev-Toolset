---
name: prepare-pr
description: Prepare or update a pull request for this workspace, then monitor checks and review recommendations until all checks remain green for at least one minute and addressed review conversations are resolved. Use when asked to prepare a PR.
---

# Prepare and follow through on a PR

Treat a request to prepare a PR as including the follow-through below. Creating or updating the PR is an intermediate step; continue working until the completion condition is met.

1. Prepare the changes, run the repository's required validation, and create or update the PR within the user's requested scope. Keep its title and description aligned with the final changes and validation.
2. Monitor the PR's checks and review recommendations, including automated review feedback. Inspect failures, fix their causes, add regression tests for reported discrepancies where applicable, validate the fixes, and push the updates. Evaluate recommendations and implement those that are relevant and justified; explain any recommendation that remains unaddressed.
3. After tackling a review conversation, mark that conversation resolved using the hosting service's review-thread resolution operation. Resolve it only after the fix is pushed or the concern is otherwise fully addressed. Verify that resolution succeeded; do not leave addressed conversations open.
4. Continue polling checks and review conversations after every update. Track the current PR head commit and start a stability timer only when every applicable check has completed successfully. Pending, queued, running, failed, cancelled, missing required checks, or unknown status do not count as green. Treat skipped or neutral checks as acceptable only when the repository's check policy permits them.
5. Require at least 60 continuous seconds of green checks on the same head commit, with a fresh check and review-conversation read at the end of that interval. Reset the timer whenever the head changes, a check stops being green, or new actionable review feedback appears. Address the feedback and repeat the monitoring cycle.

Keep the user informed during monitoring. If access, unavailable services, or an external dependency prevents progress, report the specific blocker and remaining work without claiming completion or retrying indefinitely. Preserve any explicit user stop or pause instruction. Preparing a PR does not authorize merging it.

Finish by linking the PR and reporting the check result, the observed green interval, and any unresolved recommendations or blockers. Claim the workflow complete only after the stability condition is satisfied and all addressed review conversations are resolved.
