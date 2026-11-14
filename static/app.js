import { request, setCsrf } from './api.js';

const $ = id => document.getElementById(id);
const statusLabels = { todo: 'To do', doing: 'In progress', done: 'Done' };
let user = null, registering = false, filter = 'all', tasks = [], nextOffset = null;
let editing = null, deleting = null, loadVersion = 0, searchTimer, toastTimer;

function showError(id, message = '') {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function notify(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

function showAuth(message = '') {
  user = null;
  setCsrf('');
  loadVersion++;
  tasks = [];
  $('task-list').replaceChildren();
  $('task-dialog').close();
  $('delete-dialog').close();
  $('workspace').hidden = true;
  $('boot').hidden = true;
  $('auth').hidden = false;
  $('password').value = '';
  showError('auth-error', message);
}

function handleExpired(error) {
  if (error.status === 401) {
    showAuth('Your session has ended. Please sign in again.');
    return true;
  }
  return false;
}

async function openWorkspace(data) {
  user = data.user;
  setCsrf(data.csrf_token);
  $('user-name').textContent = user.name;
  $('avatar').textContent = user.name.slice(0, 1).toUpperCase();
  $('today').textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  $('auth').hidden = true;
  $('boot').hidden = true;
  $('workspace').hidden = false;
  $('password').value = '';
  filter = 'all';
  $('search').value = '';
  updateFilters();
  await loadTasks();
}

$('auth-switch').addEventListener('click', () => {
  registering = !registering;
  $('auth-title').textContent = registering ? 'Make yourself at home.' : 'Welcome back.';
  $('auth-subtitle').textContent = registering ? 'A fresh space for your plans, big and small.' : 'Sign in and pick up where you left off.';
  $('name-label').hidden = !registering;
  $('name').required = registering;
  $('password').minLength = registering ? 10 : 1;
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  $('password-help').hidden = !registering;
  $('auth-submit').textContent = registering ? 'Create account ↗' : 'Sign in ↗';
  $('switch-prompt').textContent = registering ? 'Already have an account?' : 'New to Daymark?';
  $('auth-switch').textContent = registering ? 'Sign in' : 'Create an account';
  showError('auth-error');
  (registering ? $('name') : $('email')).focus();
});

$('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('auth-submit');
  button.disabled = true;
  $('auth-switch').disabled = true;
  showError('auth-error');
  try {
    const data = await request(`/auth/${registering ? 'register' : 'login'}`, {
      method: 'POST', body: {
        email: $('email').value, password: $('password').value,
        ...(registering ? { name: $('name').value } : {}),
      },
    });
    await openWorkspace(data);
  } catch (error) { showError('auth-error', error.message); }
  finally { button.disabled = false; $('auth-switch').disabled = false; }
});

$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { await request('/auth/logout', { method: 'POST', body: {} }); showAuth(); }
  catch (error) { if (!handleExpired(error)) notify(error.message); }
  finally { $('logout').disabled = false; }
});

function updateFilters() {
  document.querySelectorAll('[data-status]').forEach(button => {
    const selected = button.dataset.status === filter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

$('filters').addEventListener('click', event => {
  const button = event.target.closest('[data-status]');
  if (!button || button.dataset.status === filter) return;
  filter = button.dataset.status;
  updateFilters();
  loadTasks();
});
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  // Invalidate outstanding requests immediately, before the debounce finishes.
  loadVersion++;
  searchTimer = setTimeout(() => loadTasks(), 250);
});
$('retry').addEventListener('click', () => loadTasks());
$('load-more').addEventListener('click', () => loadTasks(true));

async function loadTasks(append = false) {
  const version = ++loadVersion;
  const params = new URLSearchParams({ status: filter, q: $('search').value.trim(), limit: '50', offset: String(append ? nextOffset || 0 : 0) });
  $('loading').hidden = false;
  $('load-more').hidden = true;
  $('empty').hidden = true;
  $('task-list').setAttribute('aria-busy', 'true');
  showError('list-error');
  $('retry').hidden = true;
  if (!append) { tasks = []; $('task-list').replaceChildren(); $('result-count').textContent = ''; }
  try {
    const data = await request(`/tasks?${params}`);
    if (version !== loadVersion) return;
    tasks = append ? [...tasks, ...data.tasks] : data.tasks;
    nextOffset = data.next_offset;
    const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
    $('total-count').textContent = total;
    $('nav-count').textContent = total;
    $('doing-count').textContent = data.counts.doing;
    $('done-count').textContent = data.counts.done;
    $('result-count').textContent = `Showing ${tasks.length} of ${data.total} ${data.total === 1 ? 'task' : 'tasks'}`;
    $('task-list').replaceChildren(...tasks.map(taskCard));
    const filtered = filter !== 'all' || $('search').value.trim();
    $('empty-title').textContent = filtered ? 'Nothing here just yet.' : 'A clean slate.';
    $('empty-copy').textContent = filtered ? 'Try another filter or search, or add a new task.' : 'Add your first task and make a little room for progress.';
    $('empty-new').textContent = filtered ? 'Add a task' : 'Create your first task';
    $('empty').hidden = tasks.length !== 0;
    $('load-more').hidden = nextOffset === null;
  } catch (error) {
    if (version !== loadVersion) return;
    if (!handleExpired(error)) { showError('list-error', error.message); $('retry').hidden = false; }
  } finally {
    if (version === loadVersion) {
      $('loading').hidden = true;
      $('task-list').setAttribute('aria-busy', 'false');
    }
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function taskCard(task) {
  const card = element('article', `task-card ${task.status === 'done' ? 'completed' : ''}`);
  const toggle = element('button', 'complete-button', task.status === 'done' ? '✓' : '');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', `${task.status === 'done' ? 'Reopen' : 'Complete'} ${task.title}`);
  toggle.setAttribute('aria-pressed', String(task.status === 'done'));
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      await request(`/tasks/${task.id}`, { method: 'PATCH', body: { status: task.status === 'done' ? 'todo' : 'done' } });
      notify(task.status === 'done' ? 'Task reopened.' : 'One more thing done. Nice work.');
      await loadTasks();
    } catch (error) { if (!handleExpired(error)) notify(error.message); }
    finally { toggle.disabled = false; }
  });
  const content = element('div', 'task-content');
  content.append(element('h2', 'task-title', task.title));
  if (task.description) content.append(element('p', 'task-description', task.description));
  const meta = element('div', 'task-meta');
  meta.append(element('span', `status-badge ${task.status}`, statusLabels[task.status]));
  meta.append(element('span', `priority ${task.priority}`, `${task.priority[0].toUpperCase()}${task.priority.slice(1)} priority`));
  if (task.due_date) {
    const due = new Date(`${task.due_date}T00:00:00`);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const overdue = due < today && task.status !== 'done';
    meta.append(element('span', overdue ? 'due overdue' : 'due', `${overdue ? 'Overdue · ' : 'Due '}${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`));
  }
  content.append(meta);
  const actions = element('div', 'task-actions');
  for (const [label, callback] of [['Edit', () => openEditor(task)], ['Delete', () => {
    deleting = task;
    $('delete-copy').textContent = `“${task.title}” will be removed from your workspace.`;
    showError('delete-error');
    $('delete-dialog').showModal();
    $('cancel-delete').focus();
  }]]) {
    const button = element('button', 'text-button', label);
    button.type = 'button';
    button.setAttribute('aria-label', `${label} ${task.title}`);
    button.addEventListener('click', callback);
    actions.append(button);
  }
  card.append(toggle, content, actions);
  return card;
}

function openEditor(task = null) {
  editing = task;
  $('task-form').reset();
  $('dialog-title').textContent = task ? 'Edit task' : 'New task';
  $('save-task').textContent = task ? 'Save changes' : 'Create task';
  $('task-title').value = task?.title || '';
  $('task-description').value = task?.description || '';
  $('task-status').value = task?.status || 'todo';
  $('task-priority').value = task?.priority || 'medium';
  $('task-due').value = task?.due_date || '';
  showError('task-error');
  $('task-dialog').showModal();
  $('task-title').focus();
}
$('new-task').addEventListener('click', () => openEditor());
$('empty-new').addEventListener('click', () => openEditor());
for (const id of ['close-task', 'cancel-task']) $(id).addEventListener('click', () => $('task-dialog').close());
$('cancel-delete').addEventListener('click', () => $('delete-dialog').close());

function lockForm(formId, locked) {
  $(formId).querySelectorAll('input, textarea, select, button').forEach(node => { node.disabled = locked; });
}
for (const id of ['task-dialog', 'delete-dialog']) $(id).addEventListener('cancel', event => {
  if ($(id).querySelector('button[type="submit"]').disabled) event.preventDefault();
});

$('task-form').addEventListener('submit', async event => {
  event.preventDefault();
  const body = { title: $('task-title').value, description: $('task-description').value,
    status: $('task-status').value, priority: $('task-priority').value, due_date: $('task-due').value || null };
  lockForm('task-form', true);
  showError('task-error');
  try {
    await request(editing ? `/tasks/${editing.id}` : '/tasks', { method: editing ? 'PATCH' : 'POST', body });
    $('task-dialog').close();
    notify(editing ? 'Changes saved.' : 'Task added. You have a plan.');
    await loadTasks();
  } catch (error) { if (!handleExpired(error)) showError('task-error', error.message); }
  finally { lockForm('task-form', false); }
});

$('delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!deleting) return;
  lockForm('delete-form', true);
  showError('delete-error');
  try {
    await request(`/tasks/${deleting.id}`, { method: 'DELETE' });
    $('delete-dialog').close();
    notify('Task deleted.');
    deleting = null;
    await loadTasks();
  } catch (error) { if (!handleExpired(error)) showError('delete-error', error.message); }
  finally { lockForm('delete-form', false); }
});

try { await openWorkspace(await request('/auth/me')); }
catch (error) { showAuth(error.status === 401 ? '' : error.message); }
