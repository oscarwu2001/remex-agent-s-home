'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findIdentifiers } = require('../src/assistant/phi');

// Every value here is invented.
const kinds = (text) => [...new Set(findIdentifiers(text).map((f) => f.kind))].sort();

test('plain office text raises nothing', () => {
  assert.deepEqual(findIdentifiers('Please summarise the meeting on 3 March about the Q2 budget and the new printer.'), []);
});

test('record numbers, dates of birth and national ids are found', () => {
  assert.deepEqual(kinds('Patient MRN: 00482913, DOB 12/04/1961'), ['date-of-birth', 'record-number']);
  assert.deepEqual(kinds('ID A123456789 was admitted'), ['national-id']);
  assert.deepEqual(kinds('SSN 123-45-6789'), ['national-id']);
  assert.deepEqual(kinds('born on 1961-04-12'), ['date-of-birth']);
});

test('a name after "patient" is flagged, a plain name is not', () => {
  assert.deepEqual(kinds('Follow-up for patient Jane Doe next week'), ['patient-name']);
  assert.deepEqual(kinds('Patient name: Wang Xiaoming'), ['patient-name']);
  assert.deepEqual(kinds('Ask Jane Doe to book the room'), []);
});

test('case folders and DICOM identifiers are flagged', () => {
  assert.deepEqual(kinds('files are in C:\\Data\\Cases\\Case_0042\\CT'), ['case-path']);
  assert.deepEqual(kinds('see /mnt/scans/patient_17/series2'), ['case-path']);
  assert.deepEqual(kinds('StudyInstanceUID 1.2.840.113619.2.55.3.604688119'), ['dicom-uid']);
});

test('contact details are flagged too', () => {
  assert.deepEqual(kinds('write to someone@example.com or call +886 2 2345 6789'), ['email', 'phone']);
});

test('each finding says where it is, for highlighting, and repeats are listed once', () => {
  const text = 'MRN 55512345 and again MRN 55512345';
  const found = findIdentifiers(text);
  assert.equal(found.length, 1);
  assert.equal(text.slice(found[0].index, found[0].index + found[0].text.length), found[0].text);
  assert.ok(found[0].label.length > 0);
});
