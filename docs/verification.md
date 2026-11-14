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

No public hosting deployment, load test, screen-reader audit, or multi-browser compatibility test was performed. The development server is only for local review. Production configuration and remaining work are described in the README and design document.
