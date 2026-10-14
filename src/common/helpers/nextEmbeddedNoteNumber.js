/**
 * Next sequential note number for an embedded notes array (Note #1, #2, …).
 * Skips invalid / missing values so deleted notes keep stable numbers for survivors.
 */
function nextEmbeddedNoteNumber(notes = []) {
  let max = 0;
  for (const note of notes || []) {
    const n = Number(note?.noteNumber);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

module.exports = { nextEmbeddedNoteNumber };
