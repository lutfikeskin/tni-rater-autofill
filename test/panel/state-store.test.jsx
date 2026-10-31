import { test, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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
