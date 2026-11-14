# Q2 — A task list with user login

## Feature

Each user has a private task list. They can register or sign in, create a task, change its status, edit its details, and delete it. Tasks can have a priority, description, and due date. The list supports status filters, text search, and pagination.

I kept the implementation to one Flask service, a SQLite database, and browser JavaScript. This keeps the feature easy to run and review without cloud accounts or a separate frontend build. The API boundary makes a later React client possible without changing the data model.

## Data model

| Table | Fields and rules |
| --- | --- |
| `users` | `id`, `name`, case-insensitive unique `email`, `password_hash`, `created_at` |
| `sessions` | `token_hash` as primary key, `user_id` foreign key, `csrf_token`, `expires_at` |
| `tasks` | `id`, `user_id` foreign key, `title`, `description`, `status`, `priority`, optional `due_date`, `created_at`, `updated_at` |

One user owns many tasks and can have multiple sessions. Task titles are required and limited to 160 characters; descriptions to 2,000. Status is one of `todo`, `doing`, or `done`; priority is `low`, `medium`, or `high`. Due dates are calendar dates, not timestamps. Creation/update timestamps are UTC.

Foreign keys and check constraints enforce the basic invariants. An index on `(user_id, created_at DESC, id DESC)` supports each user's ordered task list. For larger datasets, I would examine query plans and add indexes for the filters actually used, rather than indexing every field up front.

## API endpoints

All request and response bodies use JSON, except successful deletion, which has no body. Authentication uses an opaque session cookie. Authenticated writes also send `X-CSRF-Token`, returned by registration, login, or session restore.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| POST | `/api/auth/register` | Accept `{name, email, password}`; create user and session; return user + CSRF token (`201`) |
| POST | `/api/auth/login` | Accept `{email, password}`; create/rotate session; return user + CSRF token (`200`) |
| GET | `/api/auth/me` | Restore current user + CSRF token, or return `401` |
| POST | `/api/auth/logout` | Revoke current session and clear cookie (`200`) |
| GET | `/api/tasks` | List only the current user's tasks, with filters and pagination (`200`) |
| POST | `/api/tasks` | Create a task owned by the current user (`201`) |
| GET | `/api/tasks/:id` | Return one owned task (`200`) |
| PATCH | `/api/tasks/:id` | Update the supplied editable fields (`200`) |
| DELETE | `/api/tasks/:id` | Delete an owned task (`204`) |

Task creation requires `title`; it accepts `description`, `status`, `priority`, and `due_date`. PATCH accepts any nonempty subset of these fields. Clearing the due date uses `null`. The API rejects unknown fields, including a client-supplied owner ID.

Example task body:

```json
{
  "title": "Review API design",
  "description": "Check ownership and validation",
  "status": "doing",
  "priority": "high",
  "due_date": "2026-11-16"
}
```

List parameters: `status=all|todo|doing|done`, `q` (up to 160 characters), `limit` (1–100, default 50), and `offset`. The response contains `tasks`, the filtered `total`, unfiltered per-status `counts`, and `next_offset` or `null`. Ordering is newest first, with ID as a deterministic tie-breaker. Offset pagination is enough for this scale; a cursor would avoid shifting pages during concurrent inserts.

Errors use `{"error":"message"}`: `400` for invalid input, `401` for a missing/expired session, `403` for failed CSRF/origin checks, `404` for missing or unowned tasks, `409` for duplicate email, `413` for an oversized request, `415` for a non-JSON write body, and `429` for excessive authentication attempts. An unowned task returns the same `404` as a missing task so its existence is not disclosed.

## Frontend structure

The frontend has two main views: an authentication form and a task workspace. The workspace contains a summary, status filters, a debounced search input, task cards, and task/delete dialogs. Each card offers completion/reopening, editing, and deletion.

`api.js` handles JSON requests, errors, and the CSRF header. `app.js` holds the current user, active filter, task list, pagination offset, and selected task. Rendering functions create DOM nodes with `textContent` so task titles and descriptions stay plain text. Passwords are cleared after successful authentication. Credentials are not stored in localStorage.

On startup, the client calls `/api/auth/me` to restore a session. A successful mutation reloads the list and counts so the server remains the source of truth. Forms disable while saving to avoid duplicate submissions. List requests use a version counter so an older search response cannot overwrite a newer one. The UI handles empty results, network failures, session expiry, and retrying list requests.

## Authentication and authorization

The server hashes passwords using scrypt. A random session token is sent in an HttpOnly, SameSite=Lax cookie; the database stores only its SHA-256 hash. Sessions expire after seven days. The cookie uses Secure when configured for HTTPS. Login rotates the current session, and logout revokes it.

Authenticated write requests require a session-specific CSRF token. Browser origins are checked on all write endpoints, including login, and non-DELETE writes require JSON. SQL uses bound values. Every task operation checks both task ID and authenticated user ID. There is no client-side ownership decision.

## Testing and next steps

The integration suite covers the main lifecycle and failure cases, especially one user trying to access another user's task. It also tests persistence, session revocation/expiry, input limits, filters, pagination, and CSRF protection.

For production, the next steps would be email verification/password reset, infrastructure-level throttling and observability, and backup/restore procedures. For shared workspaces I would introduce workspaces and memberships explicitly, with role checks, rather than weakening the current owner-only rule. A larger deployment would move to PostgreSQL and shared rate-limit storage.
