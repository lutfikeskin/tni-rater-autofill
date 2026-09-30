// Read-only page-layout capture, for pasting into a devtools console (or a browser automation
// tool) on a rater page while an agent does a real quote. Same idea as the extension's
// "Capture page layout", without needing the extension. Records labels, ids, options and which
// choice is selected; never the text typed into boxes.
(() => {
  const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const vis = (el) => (el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden') || [...(el.labels ?? [])].some((l) => l.getClientRects().length);
  const txt = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('select,option,textarea,button,script,style,noscript,[hidden],[aria-hidden="true"]') ? 2 : 1) });
    let t = ''; while (w.nextNode()) t += ` ${w.currentNode.nodeValue}`; return one(t);
  };
  const SEL = 'input:not([type=hidden]), select, textarea';
  const label = (el) => {
    const p = [];
    const lb = el.getAttribute('aria-labelledby'); if (lb) lb.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) p.push(n.textContent); });
    for (const l of el.labels ?? []) p.push(txt(l));
    if (el.getAttribute('aria-label')) p.push(el.getAttribute('aria-label'));
    if (!one(p.join(''))) for (let c = el.parentElement, i = 0; c && i < 5 && c !== document.body; c = c.parentElement, i++) { if (c.querySelectorAll(SEL).length > 1) break; const t = txt(c); if (t) { p.push(t); break; } }
    // Table layouts: the label often sits in the previous cell.
    if (!one(p.join(''))) { const td = el.closest('td'); const prev = td?.previousElementSibling; if (prev) p.push(txt(prev)); }
    if (!one(p.join('')) && el.placeholder) p.push(el.placeholder);
    if (!one(p.join('')) && el.title) p.push(el.title);
    return one(p.join(' ')).slice(0, 200);
  };
  const groupLabel = (radios, opts) => {
    const fs = radios[0].closest('fieldset'); const lg = fs?.querySelector('legend'); if (lg && radios.every((r) => fs.contains(r))) return one(lg.textContent);
    let c = radios[0].parentElement; while (c && !radios.every((r) => c.contains(r))) c = c.parentElement;
    for (let i = 0; c && i < 4; i++, c = c.parentElement) {
      let t = txt(c); for (const o of opts) if (o) t = t.replace(o, ' '); t = one(t);
      if (t) return t.slice(0, 200);
      const prev = c.closest('td')?.previousElementSibling; if (prev && txt(prev)) return txt(prev).slice(0, 200);
    }
    return radios[0].name;
  };
  const section = (el) => {
    for (let p = el.parentElement, i = 0; p && i < 10; p = p.parentElement, i++) {
      const hs = [...p.querySelectorAll('h1,h2,h3,h4,legend,[role=heading]')].filter((h) => h.compareDocumentPosition(el) & 4);
      if (hs.length) return one(hs.at(-1).textContent).slice(0, 100);
    }
    return '';
  };
  const postback = (el) => /__doPostBack|AutoPostBack|setTimeout\(/i.test(`${el.getAttribute('onchange') ?? ''} ${el.getAttribute('onclick') ?? ''}`);
  const out = []; const groups = new Map();
  for (const el of document.querySelectorAll(SEL)) {
    const type = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : el.tagName.toLowerCase();
    if (['submit', 'button', 'reset', 'image', 'file', 'password'].includes(type) || !vis(el)) continue;
    if (type === 'radio') {
      const k = el.name || el.id; let g = groups.get(k);
      if (!g) { g = { kind: 'radio', radios: [] }; groups.set(k, g); out.push(g); }
      g.radios.push(el); continue;
    }
    const o = { kind: el.tagName === 'SELECT' ? 'select' : type === 'checkbox' ? 'checkbox' : 'text', type, label: label(el), id: el.id || null, name: el.name || null, required: el.required || el.getAttribute('aria-required') === 'true', disabled: el.disabled || undefined, readOnly: el.readOnly || undefined, maxLength: el.maxLength > 0 ? el.maxLength : undefined, section: section(el), postback: postback(el) || undefined };
    if (o.kind === 'select') { o.options = [...el.options].map((x) => one(x.text)).slice(0, 80); o.optionCount = el.options.length; o.selected = one(el.selectedOptions[0]?.text ?? ''); }
    if (o.kind === 'checkbox') o.selected = el.checked;
    if (o.kind === 'text') o.filled = el.value.trim() !== '';
    out.push(o);
  }
  for (const g of groups.values()) {
    const opts = g.radios.map((r) => one([...(r.labels ?? [])].map(txt).join(' ')) || r.value);
    const r0 = g.radios[0];
    Object.assign(g, { type: 'radio', label: groupLabel(g.radios, opts), name: r0.name || null, ids: g.radios.map((r) => r.id || null), options: opts, selected: opts[g.radios.findIndex((r) => r.checked)] ?? '', section: section(r0), postback: g.radios.some(postback) || undefined });
    delete g.radios;
  }
  return {
    url: location.origin + location.pathname,
    page: new URLSearchParams(location.search).get('pageName'),
    title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3,legend,[role=heading]')].filter(vis).map((h) => one(h.textContent)).filter(Boolean).slice(0, 50),
    tabs: [...document.querySelectorAll('nav a, [role=tab], .nav a, ul[class*=tab] a')].filter(vis).map((a) => one(a.textContent)).filter(Boolean).slice(0, 20),
    controls: out,
    customWidgets: [...document.querySelectorAll('[role=combobox]:not(input):not(select), [role=listbox], [contenteditable=true], [class*=autocomplete], [class*=typeahead]')].filter(vis).slice(0, 30).map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), id: el.id || null, cls: String(el.className).slice(0, 80), label: label(el) })),
    frames: [...document.querySelectorAll('iframe')].map((f) => f.src || '(inline)'),
  };
})()
