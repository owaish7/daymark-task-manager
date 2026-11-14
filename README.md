# Daymark

A small task manager with user login, a persistent database, and a responsive browser interface. Built as a complete example of the SaaS feature described in the Adora written assignment.

![Daymark task workspace with synthetic review data](docs/daymark.jpg)

## Run locally

Requires Python 3.12 or newer. No API keys, database server, or frontend build step.

```sh
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# macOS / Linux instead:
# source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

Open **http://127.0.0.1:5000**, create an account, and add a task. Data lives in `instance/tasks.sqlite3` and survives a restart. There are no seeded accounts or hardcoded passwords. Use a test password rather than a password you use elsewhere.

## What works

- Register, sign in, restore a session after refresh, and sign out.
- Add, edit, complete, reopen, or delete your own tasks.
- Set an optional description, priority, and due date.
- Filter by status and search titles/descriptions; results are paginated.
- View total, in-progress, and completed counts across your workspace.
- Get clear loading, empty, validation, and connection-error states.
- Use the interface on a phone or with a keyboard; native dialogs manage modal focus.

## Structure

```text
app.py                  App factory, authentication, task API, security headers
schema.sql              Tables, constraints, foreign keys, indexes
static/index.html       Semantic page and dialogs
static/api.js           Fetch wrapper and in-memory CSRF token
static/app.js           Session restore, UI state, task forms and rendering
static/style.css        Responsive layout and component styles
tests/test_api.py       API integration tests with isolated databases
docs/design.md          Data model, endpoint contract, frontend and tradeoffs
PLAN.md                 Initial scope and implementation sequence
```

## Tests

```sh
python -W error::ResourceWarning -m unittest discover -s tests -v
```

17 integration tests cover the task lifecycle, cross-account isolation, rejected owner injection, persistence across app restarts, expired/revoked/rotated sessions, password/session storage, CSRF and origin checks, duplicate registration, validation, pagination/search, security headers, and authentication rate limiting.

Browser checks were also performed locally for registration, task creation and editing, completion, search, filters, session restore, and sign-out. See `docs/verification.md` for the final verification record.

## Security and deployment notes

Passwords use Werkzeug scrypt hashes. Session cookies are HttpOnly and SameSite=Lax; only SHA-256 hashes of random session tokens are stored in SQLite. Session tokens expire after seven days and sign-out revokes them. Authenticated writes require a CSRF header. All writes check the browser's Origin when present. Task queries always include the signed-in user's ID. User text is rendered with `textContent`, not inserted as HTML.

For a single-instance deployment, use a persistent disk, HTTPS, and Waitress instead of Flask's development server:

```sh
# PowerShell:
$env:COOKIE_SECURE="1"
$env:TASK_DATABASE="C:\persistent-data\daymark.sqlite3"
waitress-serve --host=127.0.0.1 --port=5000 --call app:create_app
```

Place an HTTPS reverse proxy in front of Waitress. It must preserve the public `Host` and provide a trusted HTTPS scheme so same-origin checks match the browser. Only configure proxy headers from a proxy you control. `COOKIE_SECURE=1` is for HTTPS; leave it unset for local HTTP development.

The built-in authentication limiter is bounded and per process, suitable for this small demo. Before an internet-facing launch, add persistent distributed throttling, monitoring, email verification, and password reset. SQLite and per-process throttling are deliberate single-instance limits. There is no hosted deployment included in this repository.
