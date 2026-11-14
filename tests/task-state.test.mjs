import test from 'node:test';
import assert from 'node:assert/strict';
import { changeTask } from '../static/task-state.js';

const task = (id, status = 'todo', title = `Task ${id}`) => ({
  id, status, title, description: '', created_at: '2026-11-14T10:00:00Z',
});
const state = (tasks, query = { status: 'all', q: '' }) => ({
  tasks, query, total: tasks.length, nextOffset: null,
  counts: { todo: tasks.filter(t => t.status === 'todo').length,
    doing: tasks.filter(t => t.status === 'doing').length,
    done: tasks.filter(t => t.status === 'done').length },
});

test('completion preserves loaded pages and unrelated task objects', () => {
  const original = Array.from({ length: 75 }, (_, i) => task(75 - i));
  const before = { ...state(original), total: 120, nextOffset: 75 };
  const after = changeTask(before, original[20], { ...original[20], status: 'done' });
  assert.equal(after.tasks.length, 75);
  assert.equal(after.tasks[0], original[0]);
  assert.equal(after.tasks[20].status, 'done');
  assert.equal(after.total, 120);
  assert.equal(after.nextOffset, 75);
  assert.deepEqual(after.counts, { todo: 74, doing: 0, done: 1 });
});

test('failed completion rolls back only its own task and counters', () => {
  const first = task(2), second = task(1);
  const optimistic = { ...first, status: 'done' };
  let current = changeTask(state([first, second]), first, optimistic);
  current = changeTask(current, second, { ...second, status: 'doing' });
  current = changeTask(current, optimistic, first);
  assert.equal(current.tasks[0].status, 'todo');
  assert.equal(current.tasks[1].status, 'doing');
  assert.deepEqual(current.counts, { todo: 1, doing: 1, done: 0 });
});

test('filtered completion removes only that row and rollback restores its position', () => {
  const first = task(3), second = task(2), third = task(1);
  const before = { ...state([first, second, third], { status: 'todo', q: '' }), total: 10, nextOffset: 3 };
  const optimistic = { ...second, status: 'done' };
  const after = changeTask(before, second, optimistic);
  assert.deepEqual(after.tasks.map(t => t.id), [3, 1]);
  assert.equal(after.total, 9);
  assert.equal(after.nextOffset, 2);
  const restored = changeTask(after, optimistic, second);
  assert.deepEqual(restored.tasks.map(t => t.id), [3, 2, 1]);
  assert.equal(restored.total, 10);
  assert.equal(restored.nextOffset, 3);
});

test('editing a search result updates membership without resetting workspace counts', () => {
  const original = task(1, 'doing', 'Review API');
  const before = state([original], { status: 'all', q: 'API' });
  const after = changeTask(before, original, { ...original, title: 'Review UI' });
  assert.equal(after.tasks.length, 0);
  assert.equal(after.total, 0);
  assert.deepEqual(after.counts, before.counts);
});

test('creating outside the current filter changes counts without inserting an unrelated row', () => {
  const before = state([task(1, 'done')], { status: 'done', q: '' });
  const after = changeTask(before, null, task(2));
  assert.deepEqual(after.tasks.map(t => t.id), [1]);
  assert.equal(after.total, 1);
  assert.deepEqual(after.counts, { todo: 1, doing: 0, done: 1 });
});

test('deleting an item preserves remaining rows and updates pagination', () => {
  const first = task(3), second = task(2);
  const before = { ...state([first, second]), total: 3, nextOffset: 2 };
  const after = changeTask(before, first, null);
  assert.equal(after.tasks[0], second);
  assert.equal(after.total, 2);
  assert.equal(after.nextOffset, 1);
});
