// @ts-check
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { answerRecord, needRecord, reopenRow, settleRow } from '../../sidepanel/panel/report-rows.js';
import { SOURCE } from '../../sidepanel/panel/messages.js';
import { reviewGroups, reviewRowHead } from '../../sidepanel/panel/review-groups.js';

/**
 * @param {string} kind
 * @param {string} label
 * @param {string} value
 * @param {Record<string, any>} [extra]
 */
function mkAnswer(kind, label, value, extra = {}) {
  const tagMap = {
    intake: SOURCE.tag.intake(' (p. 1)'),
    derived: SOURCE.tag.derived,
    standard: SOURCE.tag.standard,
    own: SOURCE.tag.own,
    edited: SOURCE.tag.edited,
    page: SOURCE.tag.page,
    clicked: SOURCE.tag.clicked,
    yours: SOURCE.tag.yours,
    changed: SOURCE.tag.changed,
  };
  const rec = answerRecord({ field: `f-${label}`, kind, label, value, answer: value, source: { tag: tagMap[kind] ?? null, title: kind, quote: value }, ...extra });
  if (extra.pending) rec.pending = true;
  if (extra.changed) rec.changed = extra.changed;
  if (extra.gone) rec.gone = true;
  return rec;
}

/**
 * @param {string} label
 * @param {Record<string, any>} [extra]
 */
function mkNeed(label, extra = {}) {
  return needRecord({ key: `k-${label}`, label, why: 'Blank on the intake', ...extra });
}

describe('reviewGroups', () => {
  test('empty or missing list returns empty groups and zero counts', () => {
    expect(reviewGroups()).toEqual({ needs: [], worth: [], rest: [], intakeCount: 0, all: [] });
    expect(reviewGroups([])).toEqual({ needs: [], worth: [], rest: [], intakeCount: 0, all: [] });
  });

  test('Needs you holds every unsettled need and pending AI pick in page order without capping', () => {
    const items = Array.from({ length: 8 }, (_, i) => mkNeed(`Question ${i + 1}`));
    const pendingAi = mkAnswer('intake', 'Garage county', 'Dallas', { pending: true });
    const list = [...items.slice(0, 4), pendingAi, ...items.slice(4)];

    const grouped = reviewGroups(list);
    expect(grouped.needs).toHaveLength(9);
    expect(grouped.needs[4]).toBe(pendingAi);
    expect(grouped.worth).toEqual([]);
    expect(grouped.all).toBe(list);
    expect(grouped.all).toHaveLength(9);
  });

  test('Worth a look follows Q1 default ranks uncapped and excludes intake and derived answers', () => {
    const std1 = mkAnswer('standard', 'Medical payments', '$5,000');
    const intake1 = mkAnswer('intake', 'DOT number', '1234567');
    const derived1 = mkAnswer('derived', 'Years in business', '6');
    const markedNeed = mkNeed('Prior carrier upload');
    settleRow(markedNeed, 'marked');
    const own1 = mkAnswer('own', 'Physical damage deductible', '$2,500');
    const pickedNeed = mkNeed('Radius class');
    settleRow(pickedNeed, 'picked', null, '200 miles');
    const edited1 = mkAnswer('edited', 'Garaging ZIP', '75001');
    const changed1 = mkAnswer('intake', 'Liability limit', '$1,000,000', { changed: 'Changed on the page to $750,000' });
    const intake2 = mkAnswer('intake', 'Business name', 'Acme Trucking LLC');
    const extraStandards = Array.from({ length: 10 }, (_, i) => mkAnswer('standard', `Standard ${i + 1}`, 'No'));

    const list = [
      std1,
      intake1,
      derived1,
      markedNeed,
      own1,
      pickedNeed,
      edited1,
      changed1,
      intake2,
      ...extraStandards,
    ];

    const grouped = reviewGroups(list);
    expect(grouped.needs).toEqual([]);
    // Rank 0: edited1, changed1; Rank 1: own1, pickedNeed; Rank 2: markedNeed; Rank 3: std1 + 10 extraStandards
    expect(grouped.worth).toEqual([
      edited1,
      changed1,
      own1,
      pickedNeed,
      markedNeed,
      std1,
      ...extraStandards,
    ]);
    expect(grouped.rest).toEqual([intake1, derived1, intake2]);
    expect(grouped.intakeCount).toBe(2);
    expect(grouped.all.length).toBe(list.length);
  });

  test('reopening a settled need moves it back from Worth a look to Needs you; gone rows stay out of groups', () => {
    const need = mkNeed('Driver license state');
    settleRow(need, 'answered', null, 'TX');
    expect(reviewGroups([need]).worth).toEqual([need]);

    reopenRow(need);
    expect(reviewGroups([need]).needs).toEqual([need]);

    need.gone = true;
    const intakeGone = mkAnswer('intake', 'Gone field', 'Yes', { gone: true });
    const grouped = reviewGroups([need, intakeGone]);
    expect(grouped.needs).toEqual([]);
    expect(grouped.worth).toEqual([]);
    expect(grouped.rest).toEqual([]);
    expect(grouped.intakeCount).toBe(0);
    expect(grouped.all).toHaveLength(2);
  });

  test('reviewRowHead shows Marked done with no You tag when a need was settled as marked', () => {
    const marked = mkNeed('Upload loss runs');
    settleRow(marked, 'marked');
    const head = reviewRowHead(marked);
    expect(head.value).toBe('Marked done');
    expect(head.tag).toBeNull();
  });

  test('review-groups.js imports only report-rows.js and neither review module caps rows', () => {
    const groupsSrc = fs.readFileSync('sidepanel/panel/review-groups.js', 'utf8');
    const viewSrc = fs.readFileSync('sidepanel/panel/review-view.jsx', 'utf8');
    const imports = [...groupsSrc.matchAll(/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./report-rows.js']);
    for (const src of [groupsSrc, viewSrc]) {
      expect(src).not.toMatch(/WORTH_CAP|needsCap|\.slice\(\s*0\s*,/);
    }
  });
});
