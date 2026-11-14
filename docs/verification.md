# Verification

Verified locally on 14 November 2026 with Python 3.12 and Flask 3.1.3.

## Automated

`python -W error::ResourceWarning -m unittest discover -s tests -v`

Result: **17 tests passed**. The suite exercises real Flask requests and temporary on-disk SQLite databases. It does not require external services or mock the database.

Repeated successfully in a fresh project virtual environment after installing `requirements.txt`. `pip check` reported no broken requirements.

JavaScript modules also passed Node's module syntax check.

## Browser

Verified in Chrome against the local Flask server:

- Register a fresh account and enter an empty workspace.
- Create a task with description, status, priority, and due date.
- Complete it; the card and summary counts update.
- Edit the title and status; changes persist.
- Search for absent text and see a useful empty state.
- Refresh the page and restore both the session and saved tasks.
- Create tasks in different statuses; filter Done and confirm only the completed task appears.
- Sign out, return to the authentication view, and sign in again.
- Inspect the dashboard at a 390 px viewport; no horizontal overflow.
- Inspect browser warning/error logs: none captured during the completed checks.

Screenshots use synthetic local test data. These records and their database are ignored by Git and are not shipped as demo credentials.

## Limits

The app was deployed publicly on Render and checked over HTTPS. Registration, task creation, session/task restore after reload, and task completion passed on the live deployment. No load test, screen-reader audit, or multi-browser compatibility test was performed. The development server is only for local review. Production configuration and remaining work are described in the README and design document.

## Hosted review demo

- URL: https://daymark-task-manager-hp2u.onrender.com
- Hosting: Render Free web service, Waitress, Python 3.14.10.
- Initial runtime source commit verified: `1d92d5d6dffaf04d6aa210075f111119b6773f1e`.
- Health endpoint: `/api/health`.
- Secure cookies and same-origin writes worked in the browser over HTTPS.
- `DEMO_MODE=1` displays the temporary-data notice. The free instance can sleep, and local SQLite data is not durable across sleep/restarts/deployments.
- README and email links were updated after live verification.

## Task interaction refinement

- Added six frontend-state tests for completion without discarding loaded pages, independent rollback during concurrent changes, filtered removal/rollback, search membership, creation outside a filter, and pagination after deletion. All passed alongside the 17 API tests.
- Browser verification confirmed that toggling the same visible checkbox preserves keyboard focus and scroll position. Other task rows retain their DOM nodes.
- Local server logs confirmed PATCH-only completion/reopening, with no list GET or document navigation triggered by the mutation.
- Stopped the local server to verify that a failed completion restores the task in the active filter and restores the summary counts.
- Filters retain the existing list during requests and use a thin progress indicator instead of clearing the page.
