import test from 'node:test';
import assert from 'node:assert/strict';
import { panelStore, storeState } from '../sidepanel/panel/state-store.js';

// The panel's `state` (core.js) is a view of the store: the older code reads and assigns it as a
// plain object, and the React views subscribe to the store (React PR 2, 2026-10-31).
test('state reads and assigns the store as a plain object does', () => {
  const reports = new Map();
  const state = storeState({ filter: 'all', tab: null, reports, active: { drivers: 0 } });
  assert.equal(state.filter, 'all');
  state.filter = 'needs';
  assert.equal(panelStore.getState().filter, 'needs', 'an assignment is the store\'s');
  panelStore.setState({ filter: 'done' });
  assert.equal(state.filter, 'done', 'and the store\'s value is what state reads');
  assert.equal(state.reports, reports, 'the same Map, not a copy');
  Object.assign(state, { tab: { id: 3 }, view: 'page' });
  assert.deepEqual([state.tab, state.view], [{ id: 3 }, 'page']);
  assert.ok('view' in state && !('missing' in state));
  assert.deepEqual(Object.keys(state), ['filter', 'tab', 'reports', 'active', 'view']);
  assert.deepEqual({ ...state.active }, { drivers: 0 });
  delete state.view;
  assert.ok(!('view' in state) && !('view' in panelStore.getState()));
  assert.equal(state.missing, undefined);
});

test('an assignment tells the store\'s subscribers once; the same value and a change in place tell no one', () => {
  const state = storeState({ filter: 'all', rows: [], seen: new Set() });
  const told = [];
  const unsubscribe = panelStore.subscribe((now, before) => told.push([before.filter, now.filter]));
  state.filter = 'needs';
  state.filter = 'needs';
  state.rows.push('answer');
  state.seen.add('key');
  unsubscribe();
  assert.deepEqual(told, [['all', 'needs']]);
  assert.deepEqual(state.rows, ['answer'], 'the change in place is still made');
});
