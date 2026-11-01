import { afterEach, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { AiCard, AiHolder, aiHolder } from '../../sidepanel/panel/ai-view.jsx';

// Luna's cards in React (2026-11-01): what renderAi and runAssist said with h(), drawn
// from what they say now (a row's `aiCard`, the holder's `say`). Which card a suggestion gets, its
// wording and what each button then does are checked by the safety tests (renderAi, runAssist, the
// approval and confirmation runs); here, that each card is drawn as before (classes, wording, the
// buttons the Luna mock clicks by name) and what each button asks for.

afterEach(cleanup);

const buttons = (node) => [...node.querySelectorAll('button')].map((b) => [b.className, b.textContent]);
// A promise the test settles: what applyAi does while the answer goes in.
const later = () => {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, settle };
};

test('a suggestion: what the AI suggests, why, the extension’s checks, Use this answer and No thanks', () => {
  const asked = [];
  const card = { kind: 'suggest', choice: 'No', tip: 'The intake says no hazmat.', why: 'cited evidence: operations.hazmat · Evidence checked · needs your review',
    checks: ['"No" is one of the page’s choices'], use: () => { asked.push('use'); return null; }, noThanks: () => asked.push('no thanks') };
  const { container } = render(<AiCard card={card} />);
  const box = container.firstChild;
  expect(box.className).toBe('ai-box');
  expect([...box.children].map((c) => [c.className, c.textContent])).toEqual([
    ['ai-says', 'AI suggests No'], ['ai-tip', 'The intake says no hazmat.'],
    ['ai-why', 'cited evidence: operations.hazmat · Evidence checked · needs your review'],
    ['ai-check', 'Checked by the extension: "No" is one of the page’s choices'],
    ['ai-actions', 'Use this answerNo thanks'],
  ]);
  expect(box.querySelector('.ai-says b').textContent).toBe('No');
  expect(buttons(box)).toEqual([['primary accept', 'Use this answer'], ['ghost', 'No thanks']]);
  box.querySelector('.accept').click();
  box.querySelector('.ghost').click();
  expect(asked).toEqual(['use', 'no thanks']);
  // Nothing started (a fill is running): the button stays as it was.
  expect([box.querySelector('.accept').disabled, box.querySelector('.accept').textContent]).toEqual([false, 'Use this answer']);
});

test('Use this answer says it is going in until it ends, then is as before', async () => {
  const going = later();
  let used = 0;
  const card = { kind: 'suggest', choice: 'typing “7”', tip: null, why: 'Evidence checked · needs your review', checks: [], use: () => { used++; return going.promise; }, noThanks: () => {} };
  const { container } = render(<AiCard card={card} />);
  expect(container.querySelector('.ai-tip')).toBe(null);
  const use = container.querySelector('.accept');
  act(() => { use.click(); });
  expect([used, use.disabled, use.textContent]).toEqual([1, true, 'Putting it in…']);
  use.click();
  expect(used).toBe(1);
  await act(async () => { going.settle(); });
  expect([use.disabled, use.textContent]).toEqual([false, 'Use this answer']);
});

test('a pick the AI put in: Picked by the AI, its notes, Continue waits, Approve and Reject', () => {
  const asked = [];
  const card = { kind: 'picked', choice: 'No', tip: 'The intake says no.', notes: ['Picked before the intake or unit changed.'],
    approve: () => asked.push('approve'), reject: () => asked.push('reject') };
  const { container } = render(<AiCard card={card} />);
  const box = container.firstChild;
  expect([...box.children].map((c) => [c.className, c.textContent])).toEqual([
    ['ai-says', 'Picked by the AI: No'], ['ai-tip', 'The intake says no.'], ['ai-tip', 'Picked before the intake or unit changed.'],
    ['ai-why', 'Continue waits for your answer.'], ['ai-actions', 'ApproveReject'],
  ]);
  expect(buttons(box)).toEqual([['primary accept', 'Approve'], ['ghost ai-reject', 'Reject']]);
  box.querySelector('.accept').click();
  box.querySelector('.ai-reject').click();
  expect(asked).toEqual(['approve', 'reject']);
});

test('what happened to a suggestion: rejected (with Confirm while it holds Continue), not taken, put in, the agent’s own', () => {
  let confirmed = 0;
  const { container, rerender } = render(<AiCard card={{ kind: 'rejected', text: 'AI answer rejected: answer it on the page.', confirm: () => { confirmed++; } }} />);
  expect([container.firstChild.className, container.querySelector('.grow').textContent]).toEqual(['ai-done bad', 'AI answer rejected: answer it on the page.']);
  expect(buttons(container)).toEqual([['link small ai-reject', 'Confirm the current page answer']]);
  container.querySelector('button').click();
  expect(confirmed).toBe(1);
  rerender(<AiCard card={{ kind: 'rejected', text: 'The page answer changed; review it.', confirm: null }} />);
  expect([container.textContent, buttons(container)]).toEqual(['The page answer changed; review it.', []]);
  rerender(<AiCard card={{ kind: 'error', text: 'The page didn\'t take the AI answer (the page changed). Answer it on the page.' }} />);
  expect([container.firstChild.className, container.textContent]).toEqual(['ai-done bad', 'The page didn\'t take the AI answer (the page changed). Answer it on the page.']);
  rerender(<AiCard card={{ kind: 'done', text: 'Put in “No” (purple on the page).' }} />);
  expect([container.firstChild.className, [...container.firstChild.children].map((c) => c.textContent)]).toEqual(['ai-done', ['✓', 'Put in “No” (purple on the page).']]);
  rerender(<AiCard card={{ kind: 'mine' }} />);
  expect([container.firstChild.className, [...container.firstChild.children].map((c) => [c.tagName, c.className, c.textContent])]).toEqual(['ai-done mine',
    [['B', '', '✓'], ['SPAN', 'grow', 'You changed this answer on the page.'], ['SPAN', 'note', 'Won’t be refilled']]]);
});

test('a question left to the agent: its tip and Luna’s recommendation, and no button', () => {
  const { container, rerender } = render(<AiCard card={{ kind: 'tip', says: 'AI: this one is yours to decide.', tip: 'Not on the intake.', next: 'Confirm placard use with the client.' }} />);
  expect([...container.firstChild.children].map((c) => [c.className, c.textContent])).toEqual([
    ['ai-says', 'AI: this one is yours to decide.'], ['ai-tip', 'Not on the intake.'], ['ai-tip ai-next', 'Luna recommends: Confirm placard use with the client.']]);
  expect(container.querySelector('.ai-next b').textContent).toBe('Luna recommends: ');
  expect(buttons(container)).toEqual([]);
  rerender(<AiCard card={{ kind: 'tip', says: 'AI tip', tip: null, next: null }} />);
  expect(container.firstChild.textContent).toBe('AI tip');
});

test('above the list: asking, a failure, a missing key with Add the key, then Use all and the cards without a row', async () => {
  const { container, rerender } = render(<AiHolder said={{ wait: 'Asking Luna about 2 questions left for you…' }} />);
  expect([container.firstChild.tagName, container.firstChild.className, container.textContent]).toEqual(['P', 'ai-wait', 'Asking Luna about 2 questions left for you…']);
  rerender(<AiHolder said={{ bad: 'AI assistant: Luna is rate-limited. Try again shortly.' }} />);
  expect([container.firstChild.className, container.textContent]).toEqual(['card bad small', 'AI assistant: Luna is rate-limited. Try again shortly.']);
  let added = 0;
  rerender(<AiHolder said={{ needsKey: { text: 'Luna needs an OpenAI API key. ', add: () => { added++; } } }} />);
  expect([container.firstChild.className, container.textContent, buttons(container)]).toEqual(['note-line', 'Luna needs an OpenAI API key. Add the key', [['link small', 'Add the key']]]);
  container.querySelector('button').click();
  expect(added).toBe(1);
  const going = later();
  let put = 0;
  const orphan = { id: 0, label: 'Mock Luna choice', card: { kind: 'picked', choice: 'No', tip: null, notes: [], approve: () => {}, reject: () => {} } };
  rerender(<AiHolder said={{ useAll: { label: 'Use all 2 AI answers', put: () => { put++; return going.promise; } }, orphans: [orphan] }} />);
  expect([...container.children].map((c) => c.className)).toEqual(['ai-actions', 'ai-orphan']);
  expect(container.querySelector('.ai-orphan > b').textContent).toBe('Mock Luna choice');
  expect(container.querySelector('.ai-orphan > .ai-box .ai-says').textContent).toBe('Picked by the AI: No');
  const useAll = container.querySelector('.ai-actions > button');
  expect([useAll.className, useAll.textContent]).toEqual(['ghost', 'Use all 2 AI answers']);
  act(() => { useAll.click(); });
  expect([put, useAll.disabled, useAll.textContent]).toEqual([1, true, 'Putting it in…']);
  await act(async () => { going.settle(); });
  expect(useAll.disabled).toBe(false);
  // Nothing to say: empty, so the holder takes no room (.ai-holder:empty).
  rerender(<AiHolder said={{ useAll: null, orphans: [] }} />);
  expect(container.childElementCount).toBe(0);
});

test('aiHolder draws what it is told before say returns, says whether it is on screen, and is taken down', () => {
  const holder = aiHolder();
  expect([holder.node.tagName, holder.node.className, holder.isConnected]).toEqual(['DIV', 'ai-holder', false]);
  document.body.append(holder.node);
  expect(holder.isConnected).toBe(true);
  holder.say({ wait: 'Asking Luna about 1 question left for you…' });
  expect(holder.node.textContent).toBe('Asking Luna about 1 question left for you…');
  holder.say({ bad: 'Luna: the tab or page changed. Click Fill this page to ask again.' });
  expect(holder.node.querySelector('.card.bad').textContent).toBe('Luna: the tab or page changed. Click Fill this page to ask again.');
  holder.remove();
  expect([holder.isConnected, holder.node.childElementCount]).toEqual([false, 0]);
});
