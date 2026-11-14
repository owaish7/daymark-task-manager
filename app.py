"""Same-origin task API and browser client. Run with: python app.py."""

from collections import OrderedDict, deque
from datetime import date
from functools import wraps
import hashlib
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash


ROOT = Path(__file__).resolve().parent
SESSION_SECONDS = 7 * 24 * 60 * 60
COOKIE = "task_session"


def create_app(config=None):
    app = Flask(__name__, static_folder="static")
    app.config.update(
        DATABASE=os.environ.get("TASK_DATABASE", str(ROOT / "instance" / "tasks.sqlite3")),
        COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
        MAX_CONTENT_LENGTH=16 * 1024,
        AUTH_RATE_LIMIT=20,
    )
    if config:
        app.config.update(config)
    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(app.config["DATABASE"]) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
    attempts = OrderedDict()
    dummy_hash = generate_password_hash(secrets.token_urlsafe(24))

    def db():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DATABASE"], timeout=10)
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys=ON")
        return g.db

    @app.teardown_appcontext
    def close_db(error=None):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    def fail(message, status=400):
        return jsonify(error=message), status

    def token_hash(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def current_session():
        token = request.cookies.get(COOKIE, "")
        if not token or len(token) > 128:
            return None
        return db().execute(
            "SELECT s.*, u.name, u.email FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE token_hash=? AND expires_at>?", (token_hash(token), int(time.time()))
        ).fetchone()

    @app.before_request
    def guard_writes():
        if request.path.startswith("/api/") and request.method in {"POST", "PATCH", "DELETE"}:
            origin = request.headers.get("Origin")
            if origin and origin != request.host_url.rstrip("/"):
                return fail("Request origin is not allowed.", 403)
            if request.method != "DELETE" and not request.is_json:
                return fail("Use an application/json request body.", 415)

    @app.after_request
    def response_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
            "base-uri 'self'; form-action 'self'"
        )
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        if app.config["COOKIE_SECURE"]:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    @app.errorhandler(HTTPException)
    def http_error(error):
        return fail(error.description, error.code)

    def authenticated(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            g.session = current_session()
            if g.session is None:
                return fail("Please sign in to continue.", 401)
            if request.method not in {"GET", "HEAD"}:
                if not secrets.compare_digest(
                    request.headers.get("X-CSRF-Token", ""), g.session["csrf_token"]
                ):
                    return fail("Session check failed. Refresh the page and try again.", 403)
            return fn(*args, **kwargs)
        return wrapped

    def rate_limited():
        # A bounded, per-process limiter. Do not trust client-supplied forwarding headers.
        key, now = request.remote_addr or "unknown", time.monotonic()
        bucket = attempts.pop(key, deque())
        while bucket and bucket[0] <= now - 600:
            bucket.popleft()
        limited = len(bucket) >= app.config["AUTH_RATE_LIMIT"]
        if not limited:
            bucket.append(now)
        attempts[key] = bucket
        if len(attempts) > 10000:
            attempts.popitem(last=False)
        return limited

    def body(allowed):
        data = request.get_json()
        if not isinstance(data, dict) or set(data) - set(allowed):
            raise ValueError("Send a JSON object with only the documented fields.")
        return data

    def text(data, field, maximum, required=False):
        value = data.get(field, "")
        if not isinstance(value, str):
            raise ValueError(f"{field.replace('_', ' ').capitalize()} must be text.")
        value = value.strip()
        if len(value) > maximum or (required and not value):
            raise ValueError(f"{field.capitalize()} must contain {'1' if required else '0'}–{maximum} characters.")
        return value

    def start_session(user):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        now = int(time.time())
        conn = db()
        with conn:
            conn.execute("DELETE FROM sessions WHERE expires_at<=? OR token_hash=?",
                         (now, token_hash(request.cookies.get(COOKIE, ""))))
            conn.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)",
                         (token_hash(token), user["id"], csrf, now + SESSION_SECONDS))
        response = jsonify(user={k: user[k] for k in ("id", "name", "email")}, csrf_token=csrf)
        response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True,
                            secure=app.config["COOKIE_SECURE"], samesite="Lax", path="/")
        return response

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/health")
    def health():
        db().execute("SELECT 1")
        return jsonify(status="ok")

    @app.post("/api/auth/register")
    def register():
        if rate_limited():
            return fail("Too many attempts. Please try again in 10 minutes.", 429)
        try:
            data = body({"name", "email", "password"})
            name = text(data, "name", 80, True)
            email = text(data, "email", 254, True).lower()
            password = data.get("password")
            if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
                raise ValueError("Enter a valid email address.")
            if not isinstance(password, str) or not 10 <= len(password) <= 128:
                raise ValueError("Password must contain 10–128 characters.")
        except ValueError as error:
            return fail(str(error))
        try:
            conn = db()
            with conn:
                cursor = conn.execute("INSERT INTO users(name,email,password_hash) VALUES (?,?,?)",
                                      (name, email, generate_password_hash(password)))
            user = dict(id=cursor.lastrowid, name=name, email=email)
            response = start_session(user)
            response.status_code = 201
            return response
        except sqlite3.IntegrityError:
            return fail("This email is already registered. Please sign in.", 409)

    @app.post("/api/auth/login")
    def login():
        if rate_limited():
            return fail("Too many attempts. Please try again in 10 minutes.", 429)
        try:
            data = body({"email", "password"})
            email = text(data, "email", 254, True).lower()
            password = data.get("password")
            if not isinstance(password, str) or not 1 <= len(password) <= 128:
                raise ValueError("Enter your email and password.")
        except ValueError as error:
            return fail(str(error))
        user = db().execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        valid = check_password_hash(user["password_hash"] if user else dummy_hash, password)
        if not user or not valid:
            return fail("Email or password is incorrect.", 401)
        return start_session(user)

    @app.get("/api/auth/me")
    @authenticated
    def me():
        return jsonify(user={"id": g.session["user_id"], "name": g.session["name"],
                             "email": g.session["email"]}, csrf_token=g.session["csrf_token"])

    @app.post("/api/auth/logout")
    @authenticated
    def logout():
        conn = db()
        with conn:
            conn.execute("DELETE FROM sessions WHERE token_hash=?", (g.session["token_hash"],))
        response = jsonify(message="Signed out.")
        response.delete_cookie(COOKIE, path="/", secure=app.config["COOKIE_SECURE"],
                               httponly=True, samesite="Lax")
        return response

    def task_fields(data, creating=False):
        fields = {}
        for key, maximum in (("title", 160), ("description", 2000)):
            if key in data or (creating and key == "title"):
                fields[key] = text(data, key, maximum, key == "title")
        for key, choices in (("status", {"todo", "doing", "done"}),
                             ("priority", {"low", "medium", "high"})):
            if key in data:
                if not isinstance(data[key], str) or data[key] not in choices:
                    raise ValueError(f"Invalid {key}.")
                fields[key] = data[key]
        if "due_date" in data:
            value = data["due_date"]
            if value is not None:
                if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                    raise ValueError("Due date must use YYYY-MM-DD or null.")
                date.fromisoformat(value)
            fields["due_date"] = value
        return fields

    task_keys = {"title", "description", "status", "priority", "due_date"}

    @app.get("/api/tasks")
    @authenticated
    def list_tasks():
        status = request.args.get("status", "all")
        query = request.args.get("q", "").strip()
        try:
            limit = int(request.args.get("limit", 50))
            offset = int(request.args.get("offset", 0))
            if not 1 <= limit <= 100 or not 0 <= offset <= 1000000:
                raise ValueError()
        except ValueError:
            return fail("Use a limit of 1–100 and a nonnegative offset up to 1000000.")
        if status not in {"all", "todo", "doing", "done"} or len(query) > 160:
            return fail("Invalid status or search query.")
        where, args = "user_id=?", [g.session["user_id"]]
        if status != "all":
            where += " AND status=?"
            args.append(status)
        if query:
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where += " AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"
            args.extend([f"%{escaped}%"] * 2)
        conn = db()
        total = conn.execute(f"SELECT COUNT(*) FROM tasks WHERE {where}", args).fetchone()[0]
        rows = conn.execute(f"SELECT * FROM tasks WHERE {where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                            [*args, limit, offset]).fetchall()
        counts = {"todo": 0, "doing": 0, "done": 0}
        for row in conn.execute("SELECT status, COUNT(*) AS n FROM tasks WHERE user_id=? GROUP BY status",
                                (g.session["user_id"],)):
            counts[row["status"]] = row["n"]
        return jsonify(tasks=[dict(row) for row in rows], total=total, counts=counts,
                       next_offset=offset + len(rows) if offset + len(rows) < total else None)

    @app.post("/api/tasks")
    @authenticated
    def create_task():
        try:
            fields = task_fields(body(task_keys), creating=True)
        except ValueError as error:
            return fail(str(error))
        conn = db()
        keys = list(fields)
        with conn:
            cursor = conn.execute(
                f"INSERT INTO tasks(user_id,{','.join(keys)}) VALUES ({','.join('?' for _ in range(len(keys)+1))})",
                [g.session["user_id"], *fields.values()])
        return jsonify(task=dict(conn.execute("SELECT * FROM tasks WHERE id=?", (cursor.lastrowid,)).fetchone())), 201

    @app.route("/api/tasks/<int:task_id>", methods=["GET", "PATCH", "DELETE"])
    @authenticated
    def task_detail(task_id):
        conn = db()
        task = conn.execute("SELECT * FROM tasks WHERE id=? AND user_id=?",
                            (task_id, g.session["user_id"])).fetchone()
        if task is None:
            return fail("Task not found.", 404)
        if request.method == "GET":
            return jsonify(task=dict(task))
        if request.method == "DELETE":
            with conn:
                conn.execute("DELETE FROM tasks WHERE id=? AND user_id=?", (task_id, g.session["user_id"]))
            return "", 204
        try:
            fields = task_fields(body(task_keys))
            if not fields:
                raise ValueError("Provide at least one task field to update.")
        except ValueError as error:
            return fail(str(error))
        with conn:
            conn.execute(
                f"UPDATE tasks SET {','.join(f'{key}=?' for key in fields)}, "
                "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=?",
                [*fields.values(), task_id, g.session["user_id"]])
        return jsonify(task=dict(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()))

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)
