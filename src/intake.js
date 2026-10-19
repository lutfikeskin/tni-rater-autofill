// Reads the fillable fields out of an intake PDF. Takes the pdf.js module as an argument so the
// same code runs in the side panel and in Node tests.
export async function readIntakeFields(pdfjs, bytes) {
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  try {
    const objects = (await doc.getFieldObjects()) ?? {};
    const raw = {};
    for (const [name, widgets] of Object.entries(objects)) {
      const typed = widgets.filter((w) => w.type);
      if (!typed.length) continue;
      if (typed[0].type === 'checkbox' || typed[0].type === 'radiobutton') {
        raw[name] = typed.some((w) => w.value && w.value !== 'Off');
      } else {
        raw[name] = typeof typed[0].value === 'string' ? typed[0].value : '';
      }
    }
    return raw;
  } finally {
    await doc.destroy();
  }
}

// Where each fillable field is drawn on the intake PDF, so the panel can show an answer on the
// form: its page (0-based) and its first widget's rectangle in PDF units ([x1, y1, x2, y2], from
// the page's bottom left), with each page's size. Fields without a widget are left out.
export async function readIntakePlaces(pdfjs, bytes) {
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const [x1, y1, x2, y2] = (await doc.getPage(i)).view;
      pages.push({ width: x2 - x1, height: y2 - y1 });
    }
    const fields = {};
    for (const [name, widgets] of Object.entries((await doc.getFieldObjects()) ?? {})) {
      const w = widgets.find((x) => x.type && Number.isInteger(x.page) && Array.isArray(x.rect));
      if (w) fields[name] = { page: w.page, rect: w.rect.map((n) => Math.round(n * 10) / 10) };
    }
    return { pages, fields };
  } finally {
    await doc.destroy();
  }
}
