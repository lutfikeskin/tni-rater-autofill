// Read-only capture for Progressive's ForAgentsOnly commercial quote pages (ExtJS 6 + Duck Creek
// "dct" components). Uses each component's own caption (dctCaption) and the question id at the
// end of the field name (e.g. "string_2C05|..." -> 2C05). Records choices that are selected,
// never text typed into boxes.
(() => {
  const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const qid = (name) => (String(name ?? '').match(/^[a-z]+_([0-9A-F]+)/i) ?? [])[1] ?? null;
  const caption = (cmp) => { for (let c = cmp, i = 0; c && i < 6; c = c.ownerCt, i++) if (c.dctCaption) return one(c.dctCaption.replace(/<[^>]+>/g, ' ')); return null; };
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
    const type = (el.type || el.tagName).toLowerCase();
    if (['submit', 'button', 'reset', 'image', 'file', 'password'].includes(type)) continue;
    let cmp = window.Ext?.getCmp(el.id.replace(/-inputEl$/, ''));
    if (type === 'radio' || type === 'checkbox') {
      const group = cmp?.up?.('dctradiogroup, radiogroup, checkboxgroup');
      if (type === 'radio' || group) {
        const g = group ?? cmp;
        if (!g || seen.has(g.id)) continue;
        seen.add(g.id);
        const items = g.items?.items ?? [cmp];
        if (!items.some((i) => vis(i.el?.dom))) continue;
        out.push({
          q: qid(el.name), kind: type === 'radio' ? 'radio' : 'checkgroup', caption: caption(g),
          required: !!g.dctRequired, options: items.map((i) => one(i.boxLabel)), selected: items.filter((i) => i.getValue?.()).map((i) => one(i.boxLabel)).join(' | '),
        });
        continue;
      }
    }
    if (!vis(el)) continue;
    const f = {
      q: qid(el.name), kind: cmp?.xtype ?? type, caption: caption(cmp) ?? one(el.labels?.[0]?.textContent ?? el.getAttribute('aria-label') ?? ''),
      required: !!(cmp?.dctRequired ?? el.required), maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      format: String(el.name).split('|')[1]?.split(':')[0] || undefined,
    };
    if (cmp?.store) {
      const recs = cmp.store.getRange();
      f.optionCount = recs.length;
      f.options = recs.slice(0, 60).map((r) => one(r.get(cmp.displayField)));
      f.selected = one(cmp.getRawValue?.() ?? '');
      f.editable = cmp.editable;
    } else if (el.tagName === 'SELECT') {
      f.options = [...el.options].map((o) => one(o.text)).slice(0, 60);
      f.selected = one(el.selectedOptions[0]?.text ?? '');
    } else if (type === 'checkbox') {
      f.selected = el.checked;
    } else {
      f.filled = el.value.trim() !== '';
    }
    out.push(f);
  }
  const params = new URLSearchParams(location.search);
  return {
    page: params.get('pageName'),
    lastFieldChanged: params.get('lastFieldChanged'),
    title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map((h) => one(h.textContent)).filter(Boolean),
    fields: out,
  };
})()
