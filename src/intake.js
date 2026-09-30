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
