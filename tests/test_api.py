import hashlib
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

from app import COOKIE, create_app


class TaskApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = str(Path(self.temp.name) / 'tasks.sqlite3')
        self.app = create_app({'TESTING': True, 'DATABASE': self.database})
        self.client = self.app.test_client()
        self.csrf = self.register(self.client, 'one@example.com')['csrf_token']

    def tearDown(self):
        self.temp.cleanup()

    def register(self, client, email):
        response = client.post('/api/auth/register', json={
            'name': 'Owais', 'email': email, 'password': 'test-password-123',
        })
        self.assertEqual(response.status_code, 201)
        return response.json

    def create_task(self, **fields):
        response = self.client.post('/api/tasks', json={'title': 'Write design', **fields},
                                    headers={'X-CSRF-Token': self.csrf})
        self.assertEqual(response.status_code, 201, response.json)
        return response.json['task']

    def test_session_cookie_and_secret_storage(self):
        response = self.client.post('/api/auth/login', json={
            'email': 'ONE@example.com', 'password': 'test-password-123'})
        cookie = response.headers['Set-Cookie']
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Lax', cookie)
        token = self.client.get_cookie(COOKIE).value
        with closing(sqlite3.connect(self.database)) as conn, conn:
            password_hash = conn.execute('SELECT password_hash FROM users').fetchone()[0]
            token_hash = conn.execute('SELECT token_hash FROM sessions').fetchone()[0]
        self.assertTrue(password_hash.startswith('scrypt:'))
        self.assertNotEqual(password_hash, 'test-password-123')
        self.assertEqual(token_hash, hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn('password', response.json['user'])

    def test_duplicate_email_is_case_insensitive(self):
        response = self.client.post('/api/auth/register', json={
            'name': 'Other', 'email': 'ONE@example.com', 'password': 'test-password-123'})
        self.assertEqual(response.status_code, 409)

    def test_bad_credentials_share_one_error(self):
        for email in ['one@example.com', 'unknown@example.com']:
            response = self.client.post('/api/auth/login', json={'email': email, 'password': 'wrong'})
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json['error'], 'Email or password is incorrect.')

    def test_unauthenticated_access(self):
        client = self.app.test_client()
        for path in ['/api/tasks', '/api/tasks/1', '/api/auth/me']:
            self.assertEqual(client.get(path).status_code, 401)
        self.assertEqual(client.post('/api/tasks', json={'title': 'No'}).status_code, 401)

    def test_create_update_complete_reopen_delete(self):
        task = self.create_task(priority='high', due_date='2026-11-16')
        headers = {'X-CSRF-Token': self.csrf}
        path = f'/api/tasks/{task["id"]}'
        for status in ['doing', 'done', 'todo']:
            response = self.client.patch(path, json={'status': status, 'description': 'Details'}, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['task']['status'], status)
        response = self.client.patch(path, json={'due_date': None}, headers=headers)
        self.assertIsNone(response.json['task']['due_date'])
        self.assertEqual(self.client.delete(path, headers=headers).status_code, 204)
        self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(self.client.get('/api/tasks').json['total'], 0)

    def test_other_user_cannot_read_edit_delete_or_count_tasks(self):
        task = self.create_task()
        other = self.app.test_client()
        csrf = self.register(other, 'two@example.com')['csrf_token']
        path = f'/api/tasks/{task["id"]}'
        self.assertEqual(other.get(path).status_code, 404)
        self.assertEqual(other.patch(path, json={'title': 'Stolen'}, headers={'X-CSRF-Token': csrf}).status_code, 404)
        self.assertEqual(other.delete(path, headers={'X-CSRF-Token': csrf}).status_code, 404)
        self.assertEqual(other.get('/api/tasks').json['counts'], {'todo': 0, 'doing': 0, 'done': 0})
        self.assertEqual(self.client.get(path).json['task']['title'], task['title'])

    def test_cannot_assign_task_owner(self):
        self.assertEqual(self.client.post('/api/tasks', json={'title': 'Task', 'user_id': 99},
                                         headers={'X-CSRF-Token': self.csrf}).status_code, 400)

    def test_csrf_and_origin_checks(self):
        self.assertEqual(self.client.post('/api/tasks', json={'title': 'Task'}).status_code, 403)
        self.assertEqual(self.client.post('/api/tasks', json={'title': 'Task'}, headers={
            'X-CSRF-Token': self.csrf, 'Origin': 'https://evil.example'}).status_code, 403)
        self.assertEqual(self.client.post('/api/auth/login', json={
            'email': 'one@example.com', 'password': 'test-password-123'},
            headers={'Origin': 'https://evil.example'}).status_code, 403)
        self.assertEqual(self.client.post('/api/tasks', json={'title': 'Task'}, headers={
            'X-CSRF-Token': self.csrf, 'Origin': 'http://localhost'}).status_code, 201)

    def test_invalid_task_input(self):
        invalid = [
            {'title': ''}, {'title': ' '}, {'title': 'x' * 161}, {'title': 4},
            {'description': 'x' * 2001}, {'status': 'unknown'}, {'status': []},
            {'priority': 'urgent'}, {'due_date': '2026-02-30'}, {'due_date': '20261116'},
            {'due_date': 123}, {'unknown': True},
        ]
        for fields in invalid:
            with self.subTest(fields=fields):
                response = self.client.post('/api/tasks', json={'title': 'Task', **fields},
                                            headers={'X-CSRF-Token': self.csrf})
                self.assertEqual(response.status_code, 400, response.json)
        self.assertEqual(self.client.post('/api/tasks', json=[], headers={'X-CSRF-Token': self.csrf}).status_code, 400)

    def test_validation_and_body_limits(self):
        for fields in [{'name': ''}, {'email': 'bad'}, {'password': 'short'}]:
            response = self.client.post('/api/auth/register', json={
                'name': 'User', 'email': 'new@example.com', 'password': 'test-password', **fields})
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.post('/api/auth/login', data='{}').status_code, 415)
        self.assertEqual(self.client.post('/api/auth/login', data='{', content_type='application/json').status_code, 400)
        self.assertEqual(self.client.post('/api/auth/login', data='x' * 20000, content_type='application/json').status_code, 413)

    def test_search_filter_pagination_and_counts(self):
        first = self.create_task(title='100% coverage', status='done')
        self.create_task(title='Review design', description='coverage notes', status='doing')
        self.create_task(title='Write docs')
        response = self.client.get('/api/tasks?limit=2').json
        self.assertEqual(len(response['tasks']), 2)
        self.assertEqual(response['total'], 3)
        self.assertEqual(response['next_offset'], 2)
        self.assertEqual(response['counts'], {'todo': 1, 'doing': 1, 'done': 1})
        page2 = self.client.get('/api/tasks?limit=2&offset=2').json
        self.assertEqual(page2['tasks'][0]['id'], first['id'])
        self.assertIsNone(page2['next_offset'])
        self.assertEqual(self.client.get('/api/tasks?status=doing&q=coverage').json['total'], 1)
        self.assertEqual(self.client.get('/api/tasks?q=%25').json['total'], 1)
        self.assertEqual(self.client.get('/api/tasks?q=%27%20OR%201%3D1--').json['total'], 0)
        for query in ['limit=101', 'limit=no', 'offset=-1', 'status=invalid']:
            self.assertEqual(self.client.get('/api/tasks?' + query).status_code, 400)

    def test_persistence_across_app_restart(self):
        task = self.create_task()
        app = create_app({'TESTING': True, 'DATABASE': self.database})
        client = app.test_client()
        client.set_cookie(COOKIE, self.client.get_cookie(COOKIE).value)
        self.assertEqual(client.get('/api/tasks').json['tasks'][0]['id'], task['id'])

    def test_expired_session_and_logout_revoke_access(self):
        token = self.client.get_cookie(COOKIE).value
        response = self.client.post('/api/auth/logout', json={}, headers={'X-CSRF-Token': self.csrf})
        self.assertEqual(response.status_code, 200)
        self.client.set_cookie(COOKIE, token)
        self.assertEqual(self.client.get('/api/tasks').status_code, 401)
        self.client.post('/api/auth/login', json={'email': 'one@example.com', 'password': 'test-password-123'})
        with closing(sqlite3.connect(self.database)) as conn, conn:
            conn.execute('UPDATE sessions SET expires_at=0')
        self.assertEqual(self.client.get('/api/auth/me').status_code, 401)

    def test_login_rotates_existing_session(self):
        previous = self.client.get_cookie(COOKIE).value
        self.client.post('/api/auth/login', json={'email': 'one@example.com', 'password': 'test-password-123'})
        self.assertNotEqual(self.client.get_cookie(COOKIE).value, previous)
        old = self.app.test_client()
        old.set_cookie(COOKIE, previous)
        self.assertEqual(old.get('/api/tasks').status_code, 401)

    def test_browser_shell_and_security_headers(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Daymark', response.data)
        self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
        response.close()
        self.assertEqual(self.client.get('/api/tasks').headers['Cache-Control'], 'no-store')
        self.assertEqual(self.client.get('/api/health').json, {'status': 'ok'})
        demo = create_app({'TESTING': True, 'DATABASE': self.database, 'DEMO_MODE': True})
        self.assertIn(b'Hosted review demo', demo.test_client().get('/').data)

    def test_auth_rate_limit(self):
        app = create_app({'TESTING': True, 'DATABASE': self.database, 'AUTH_RATE_LIMIT': 1})
        client = app.test_client()
        payload = {'email': 'one@example.com', 'password': 'wrong'}
        self.assertEqual(client.post('/api/auth/login', json=payload).status_code, 401)
        self.assertEqual(client.post('/api/auth/login', json=payload).status_code, 429)

    def test_secure_cookie_configuration(self):
        app = create_app({'TESTING': True, 'DATABASE': self.database, 'COOKIE_SECURE': True})
        response = app.test_client().post('/api/auth/login', json={
            'email': 'one@example.com', 'password': 'test-password-123'})
        self.assertIn('Secure;', response.headers['Set-Cookie'])
        self.assertIn('Strict-Transport-Security', response.headers)


if __name__ == '__main__':
    unittest.main()
