export function matchesTask(task, query) {
  if (!task || (query.status !== 'all' && task.status !== query.status)) return false;
  const search = query.q.trim().toLowerCase();
  return !search || `${task.title}\n${task.description || ''}`.toLowerCase().includes(search);
}

// Apply one confirmed or optimistic change without discarding the loaded pages.
// Applying the inverse change rolls back only this task, including its counts.
export function changeTask(state, previous, next) {
  const wasVisible = matchesTask(previous, state.query);
  const willBeVisible = matchesTask(next, state.query);
  const delta = Number(willBeVisible) - Number(wasVisible);
  const id = previous?.id ?? next.id;
  const tasks = state.tasks.filter(task => task.id !== id);
  if (willBeVisible) {
    tasks.push(next);
    tasks.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  }
  const counts = { ...state.counts };
  if (previous) counts[previous.status]--;
  if (next) counts[next.status]++;
  const total = state.total + delta;
  const nextOffset = state.nextOffset === null || tasks.length >= total
    ? null : Math.max(0, state.nextOffset + delta);
  return { ...state, tasks, counts, total, nextOffset };
}
