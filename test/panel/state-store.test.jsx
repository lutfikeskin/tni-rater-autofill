import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useStore } from 'zustand';
import { panelStore, storeState } from '../../sidepanel/panel/state-store.js';

// A React view and the older code share the panel's state: the older code assigns `state`, and the
// view subscribed to that field redraws (React PR 2, 2026-10-31).
function Filter() {
  const filter = useStore(panelStore, (s) => s.filter);
  return <p>Showing {filter}</p>;
}

test('a view redraws when the older code assigns the field it reads', () => {
  const state = storeState({ filter: 'all', rows: [] });
  render(<Filter />);
  expect(screen.getByText('Showing all')).toBeTruthy();
  act(() => { state.filter = 'needs'; });
  expect(screen.getByText('Showing needs')).toBeTruthy();
});

test('a change made in place does not redraw: a view needs it assigned as a new value', () => {
  const state = storeState({ filter: 'all', rows: [] });
  let draws = 0;
  function Rows() {
    draws++;
    const rows = useStore(panelStore, (s) => s.rows);
    return <p>{rows.length} rows</p>;
  }
  render(<Rows />);
  act(() => { state.rows.push('answer'); });
  expect(screen.getByText('0 rows')).toBeTruthy();
  act(() => { state.rows = [...state.rows]; });
  expect(screen.getByText('1 rows')).toBeTruthy();
  expect(draws).toBe(2);
});

// Review of PR #282: a fill starting and ending reaches the developer recording (its fills and its
// store), now that core.js hears `state.filling` through the store, not through a setter on `state`.
test('a fill starting and ending is noted in the recording', () => {
  cleanup();
  const core = readFileSync('sidepanel/panel/core.js', 'utf8');
  const start = core.indexOf('let fillingPrevious');
  const block = core.slice(start, core.indexOf('\n});', start) + 4);
  const added = [];
  const rec = { fills: [], store: { add: (events) => added.push(...events) } };
  const state = storeState({ filling: false, recording: rec });
  new Function('panelStore', 'state', block)(panelStore, state);
  state.filling = true;
  state.filling = true;
  state.filling = false;
  expect(rec.fills).toHaveLength(1);
  expect(rec.fills[0].end).toBeGreaterThanOrEqual(rec.fills[0].start);
  expect(added.map((e) => [e.kind, e.on])).toEqual([['fill', true], ['fill', false]]);
  // What went in (audit 2026-11-07, FLOW-15): the agent's pick from a row and an AI answer say so,
  // the end as its start, whatever the kind is set to meanwhile; none said is a fill.
  for (const kind of ['pick', 'ai', null]) {
    state.fillingKind = kind;
    state.filling = true;
    state.fillingKind = 'fill';
    state.filling = false;
  }
  expect(added.slice(2).map((e) => [e.on, e.what])).toEqual([[true, 'pick'], [false, 'pick'], [true, 'ai'], [false, 'ai'], [true, 'fill'], [false, 'fill']]);
  expect(rec.fills.slice(1).map((f) => f.what)).toEqual(['pick', 'ai', 'fill']);
  // Each place that puts something in says what before it sets `filling`.
  const fill = readFileSync('sidepanel/panel/fill.js', 'utf8');
  expect(fill).toMatch(/state\.fillingKind = 'fill';\n\s+state\.filling = true;/);
  expect(fill).toMatch(/state\.fillingKind = 'pick';\n\s+state\.filling = true;/);
  expect(readFileSync('sidepanel/panel/coordinator.js', 'utf8')).toMatch(/state\.fillingKind = 'fill';\n\s+state\.filling = true;/);
  expect(readFileSync('sidepanel/panel/assistant.js', 'utf8')).toMatch(/state\.fillingKind = 'ai';\n\s+state\.filling = true;/);
  expect((fill + readFileSync('sidepanel/panel/coordinator.js', 'utf8') + readFileSync('sidepanel/panel/assistant.js', 'utf8')).match(/state\.filling = true;/g)).toHaveLength(4);
});
