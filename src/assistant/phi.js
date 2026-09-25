'use strict';

// A local check, run before a task leaves the computer, for text that looks
// like it identifies a real patient: record numbers, dates of birth, national
// ID numbers, a name right after "patient", case folders, DICOM identifiers
// and contact details. It is a safety net, not a guarantee: it errs toward
// asking, and the user decides (see the warning in the Front desk).

const RULES = [
  {
    kind: 'record-number',
    label: 'Medical record number',
    re: /\b(?:MRN|medical record(?: number| no\.?)?|chart (?:number|no\.?)|hospital number|病歷號(?:碼)?)\s*[:#]?\s*([A-Z]{0,3}\d{5,12})\b/gi,
  },
  {
    kind: 'date-of-birth',
    label: 'Date of birth',
    re: /\b(?:DOB|D\.O\.B\.?|date of birth|born(?: on)?|birth ?date|出生(?:日期)?)\s*[:#]?\s*(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|\d{1,2} [A-Z][a-z]{2,8} \d{4})/gi,
  },
  { kind: 'national-id', label: 'National ID number', re: /\b[A-Z][12]\d{8}\b/g }, // Taiwan
  { kind: 'national-id', label: 'National ID number', re: /\b\d{3}-\d{2}-\d{4}\b/g }, // US SSN
  { kind: 'national-id', label: 'National ID number', re: /\bNHS(?: number| no\.?)?\s*[:#]?\s*\d{3}\s?\d{3}\s?\d{4}\b/gi },
  {
    kind: 'patient-name',
    label: 'Patient name',
    // "patient Jane Doe", "Patient name: Wang Xiaoming". Acronyms (MRN) are not names.
    re: /\b[Pp]atient(?:'s)?(?: [Nn]ame)?\s*:?\s+((?:Mr|Mrs|Ms|Dr)\.?\s+)?([A-Z][a-z]+(?:[ -][A-Z][a-z]+){1,2})/g,
  },
  { kind: 'patient-name', label: 'Patient name', re: /(?:病患|病人|患者)\s*[:：]?\s*[一-鿿]{2,4}/g },
  {
    kind: 'case-path',
    label: 'Case or patient folder',
    re: /(?:[A-Za-z]:\\|\\\\|\/)[^\s"'<>|]*(?:case|patient|subject|dicom)[_ -]?\d*[^\s"'<>|]*/gi,
  },
  { kind: 'dicom-uid', label: 'DICOM identifier', re: /\b1\.2\.840\.\d+(?:\.\d+){3,}\b/g },
  { kind: 'email', label: 'Email address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'phone', label: 'Phone number', re: /(?<![\w.])\+?\d{1,3}[ -]\d{1,4}(?:[ -]\d{2,5}){2,3}\b/g },
];

// [{ kind, label, text, index }] in the order they appear, each distinct
// piece of text once.
function findIdentifiers(text) {
  const s = String(text ?? '');
  const out = [];
  const seen = new Set();
  for (const rule of RULES) {
    for (const m of s.matchAll(rule.re)) {
      const hit = m[0].trim();
      const key = `${rule.kind}|${hit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: rule.kind, label: rule.label, text: hit, index: m.index + m[0].indexOf(hit) });
    }
  }
  // A DICOM UID also matches the phone pattern's digits in some layouts;
  // keep the more specific finding when two cover the same text.
  const specific = out.filter((f) => !out.some((g) => g !== f && g.kind !== f.kind && f.kind === 'phone'
    && g.index <= f.index && g.index + g.text.length >= f.index + f.text.length));
  return specific.sort((a, b) => a.index - b.index);
}

module.exports = { findIdentifiers };
