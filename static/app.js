import { request, setCsrf } from './api.js';
import { changeTask } from './task-state.js';

const $ = id => document.getElementById(id);
const statusLabels = { todo: 'To do', doing: 'In progress', done: 'Done' };
let user = null, registering = false, filter = 'all', tasks = [], nextOffset = null;
let editing = null, deleting = null, loadVersion = 0, searchTimer, toastTimer;
let counts = { todo: 0, doing: 0, done: 0 }, resultTotal = 0, hasLoaded = false;
let loadedQuery = { status: 'all', q: '' }, sessionVersion = 0;
const taskNodes = new Map(), pendingWrites = new Map(), pendingTaskIds = new Set();

const currentQuery = () => ({ status: filter, q: $('search').value.trim() });
const queryMatches = () => JSON.stringify(currentQuery()) === JSON.stringify(loadedQuery);

function setListBusy(busy) {
  $('task-section').setAttribute('aria-busy', String(busy));
  $('task-list').setAttribute('aria-busy', String(busy));
}

function trackWrite(key, action) {
  loadVersion++;
  setListBusy(false);
  $('loading').hidden = true;
  const operation = action();
  pendingWrites.set(key, operation);
  $('sync-status').textContent = 'Saving…';
  const finish = () => {
    pendingWrites.delete(key);
    $('sync-status').textContent = pendingWrites.size ? 'Saving…' : '';
    if (user && !pendingWrites.size && (!hasLoaded || !queryMatches())) loadTasks();
  };
  operation.then(finish, finish);
}

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
  sessionVersion++;
  user = null;
  setCsrf('');
  loadVersion++;
  tasks = [];
  taskNodes.clear();
  hasLoaded = false;
  counts = { todo: 0, doing: 0, done: 0 };
  resultTotal = 0;
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
  sessionVersion++;
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
  const query = currentQuery();
  $('loading').hidden = hasLoaded;
  $('load-more').disabled = true;
  setListBusy(true);
  showError('list-error');
  $('retry').hidden = true;
  try {
    // A filter request must not race a task save and paint the old server state.
    await Promise.allSettled([...pendingWrites.values()]);
    if (version !== loadVersion) return;
    const params = new URLSearchParams({ ...query, limit: '50', offset: String(append ? nextOffset || 0 : 0) });
    const data = await request(`/tasks?${params}`);
    if (version !== loadVersion) return;
    tasks = append ? [...tasks, ...data.tasks] : data.tasks;
    nextOffset = data.next_offset;
    counts = data.counts;
    resultTotal = data.total;
    loadedQuery = query;
    hasLoaded = true;
    renderTasks();
  } catch (error) {
    if (version !== loadVersion) return;
    if (!handleExpired(error)) { showError('list-error', error.message); $('retry').hidden = false; }
  } finally {
    if (version === loadVersion) {
      $('loading').hidden = true;
      $('load-more').disabled = false;
      setListBusy(false);
    }
  }
}

function applyLocalChange(previous, next) {
  const state = changeTask({ tasks, counts, total: resultTotal, nextOffset, query: loadedQuery }, previous, next);
  ({ tasks, counts, nextOffset } = state);
  resultTotal = state.total;
  renderTasks();
}

function renderTasks() {
  const list = $('task-list');
  const focusedRow = document.activeElement?.closest('.task-card');
  const focusedIndex = focusedRow ? [...list.children].indexOf(focusedRow) : -1;
  const ids = new Set(tasks.map(task => task.id));
  tasks.forEach((task, index) => {
    let card = taskNodes.get(task.id);
    if (!card) { card = taskCard(task); taskNodes.set(task.id, card); }
    card.update(task);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
  });
  for (const [id, card] of taskNodes) {
    if (!ids.has(id)) { card.remove(); taskNodes.delete(id); }
  }
  if (focusedRow && !focusedRow.isConnected) {
    const nextCard = list.children[Math.min(focusedIndex, list.children.length - 1)];
    (nextCard?.querySelector('.complete-button') || $('filters').querySelector('.active')).focus({ preventScroll: true });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  $('total-count').textContent = total;
  $('nav-count').textContent = total;
  $('doing-count').textContent = counts.doing;
  $('done-count').textContent = counts.done;
  $('result-count').textContent = `Showing ${tasks.length} of ${resultTotal} ${resultTotal === 1 ? 'task' : 'tasks'}`;
  const filtered = loadedQuery.status !== 'all' || loadedQuery.q;
  $('empty-title').textContent = filtered ? 'Nothing here just yet.' : 'A clean slate.';
  $('empty-copy').textContent = filtered ? 'Try another filter or search, or add a new task.' : 'Add your first task and make a little room for progress.';
  $('empty-new').textContent = filtered ? 'Add a task' : 'Create your first task';
  $('empty').hidden = tasks.length !== 0 || !hasLoaded;
  $('load-more').hidden = nextOffset === null;
  $('load-more').disabled = false;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function taskCard(task) {
  const card = element('article', 'task-card');
  card.dataset.taskId = task.id;
  card.task = task;
  const toggle = element('button', 'complete-button');
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    const previous = card.task;
    if (pendingTaskIds.has(previous.id)) return;
    const optimistic = { ...previous, status: previous.status === 'done' ? 'todo' : 'done' };
    const session = sessionVersion;
    pendingTaskIds.add(previous.id);
    applyLocalChange(previous, optimistic);
    trackWrite(previous.id, async () => {
      try {
        const data = await request(`/tasks/${previous.id}`, { method: 'PATCH', body: { status: optimistic.status } });
        if (session === sessionVersion) applyLocalChange(optimistic, data.task);
      } catch (error) {
        if (session === sessionVersion && !handleExpired(error)) {
          applyLocalChange(optimistic, previous);
          notify(`Change wasn't saved. ${error.message}`);
        }
      } finally {
        pendingTaskIds.delete(previous.id);
        if (session === sessionVersion) renderTasks();
      }
    });
  });
  const content = element('div', 'task-content');
  const actions = element('div', 'task-actions');
  for (const [label, callback] of [['Edit', () => openEditor(card.task)], ['Delete', () => {
    deleting = card.task;
    $('delete-copy').textContent = `“${card.task.title}” will be removed from your workspace.`;
    showError('delete-error');
    $('delete-dialog').showModal();
    $('cancel-delete').focus();
  }]]) {
    const button = element('button', 'text-button', label);
    button.type = 'button';
    button.dataset.action = label;
    button.addEventListener('click', callback);
    actions.append(button);
  }
  card.append(toggle, content, actions);
  let signature = '';
  card.update = next => {
    card.task = next;
    const pending = pendingTaskIds.has(next.id);
    const nextSignature = JSON.stringify([next, pending]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    card.classList.toggle('completed', next.status === 'done');
    card.classList.toggle('saving', pending);
    toggle.textContent = next.status === 'done' ? '✓' : '';
    toggle.setAttribute('aria-label', `${next.status === 'done' ? 'Reopen' : 'Complete'} ${next.title}`);
    toggle.setAttribute('aria-pressed', String(next.status === 'done'));
    toggle.setAttribute('aria-disabled', String(pending));
    content.replaceChildren(element('h2', 'task-title', next.title));
    if (next.description) content.append(element('p', 'task-description', next.description));
    const meta = element('div', 'task-meta');
    meta.append(element('span', `status-badge ${next.status}`, statusLabels[next.status]));
    meta.append(element('span', `priority ${next.priority}`, `${next.priority[0].toUpperCase()}${next.priority.slice(1)} priority`));
    if (next.due_date) {
      const due = new Date(`${next.due_date}T00:00:00`);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const overdue = due < today && next.status !== 'done';
      meta.append(element('span', overdue ? 'due overdue' : 'due', `${overdue ? 'Overdue · ' : 'Due '}${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`));
    }
    content.append(meta);
    actions.querySelectorAll('button').forEach(button => {
      button.disabled = pending;
      button.setAttribute('aria-label', `${button.dataset.action} ${next.title}`);
    });
  };
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

$('task-form').addEventListener('submit', event => {
  event.preventDefault();
  trackWrite('editor', async () => {
    const session = sessionVersion;
    const previous = editing;
    const body = { title: $('task-title').value, description: $('task-description').value,
      status: $('task-status').value, priority: $('task-priority').value, due_date: $('task-due').value || null };
    lockForm('task-form', true);
    showError('task-error');
    try {
      const data = await request(previous ? `/tasks/${previous.id}` : '/tasks', { method: previous ? 'PATCH' : 'POST', body });
      if (session !== sessionVersion) return;
      applyLocalChange(previous, data.task);
      $('task-dialog').close();
      notify(previous ? 'Changes saved.' : 'Task added. You have a plan.');
    } catch (error) { if (!handleExpired(error)) showError('task-error', error.message); }
    finally { lockForm('task-form', false); }
  });
});

$('delete-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!deleting) return;
  trackWrite('delete', async () => {
    const session = sessionVersion;
    const previous = deleting;
    lockForm('delete-form', true);
    showError('delete-error');
    try {
      await request(`/tasks/${previous.id}`, { method: 'DELETE' });
      if (session !== sessionVersion) return;
      applyLocalChange(previous, null);
      $('delete-dialog').close();
      notify('Task deleted.');
      deleting = null;
    } catch (error) { if (!handleExpired(error)) showError('delete-error', error.message); }
    finally { lockForm('delete-form', false); }
  });
});

try { await openWorkspace(await request('/auth/me')); }
catch (error) { showAuth(error.status === 401 ? '' : error.message); }
