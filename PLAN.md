# Task manager

Build a small, complete SaaS feature: each person signs in and manages their own tasks.

## Scope

- Email/password registration, sign-in, session restore, and sign-out.
- Create, edit, complete, reopen, and delete a task.
- Optional description, priority, and due date; filter by status and search by title or description.
- Responsive interface with loading, empty, and error states.
- Persistent SQLite storage and server-enforced task ownership.

## Choices

Flask fits a small Python API; SQLite keeps review setup to one process without cloud credentials. The frontend is split into small browser modules, served from the same origin as the API. A framework and a separate build server would add little to this scope.

Opaque server-side sessions use an HttpOnly cookie. Store only token hashes in the database. Use Werkzeug's scrypt password hashing, CSRF tokens on authenticated writes, and an origin check on all writes. Never accept a user ID from a client to determine task ownership.

## Work sequence

1. Model the data and agree the feature boundaries.
2. Implement authentication and task endpoints.
3. Build the browser interface and connect it to the API.
4. Test user isolation, persistence, invalid input, session expiry, and the main UI journey.
5. Document setup, API contracts, tradeoffs, and deployment limits.

## Deliberate limits

This is a single-instance assignment app. Password reset, email verification, shared workspaces, recurring tasks, and third-party sign-in are outside scope. Before an internet-facing launch, add infrastructure-level throttling and monitoring. A multi-instance deployment would need shared rate-limit storage and a database such as PostgreSQL.
