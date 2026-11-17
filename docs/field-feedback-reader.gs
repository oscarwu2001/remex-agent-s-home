/**
 * Agent's Home reader
 *
 * Lets Agent's Home on your computer read the "REMEX Web Reports" tab of
 * this spreadsheet. It only reads; it never changes the sheet.
 * It answers only a POST that carries the secret saved under
 * Project Settings > Script properties as READER_SECRET (make one with
 * makeSecret below). Without that secret it refuses every request.
 *
 * @OnlyCurrentDoc  (Google limits this script to this one spreadsheet)
 */
const TAB = 'REMEX Web Reports';

function doPost(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('READER_SECRET') || '';
  let sent = '';
  try {
    sent = String(JSON.parse(e.postData.contents).secret || '');
  } catch (err) {
    sent = ''; // a request that is not JSON is refused just below
  }
  if (secret.length < 32 || !same_(sent, secret)) return reply_({ ok: false, error: 'not allowed' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB);
  if (!sheet) return reply_({ ok: false, error: 'tab not found' });
  return reply_({ ok: true, tab: TAB, values: sheet.getDataRange().getDisplayValues() });
}

function doGet() {
  return reply_({ ok: false, error: 'not allowed' });
}

/** Run once from the editor (Run > makeSecret), then copy the secret from Project Settings > Script properties. */
function makeSecret() {
  const s = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('READER_SECRET', s);
  Logger.log('A new secret is saved under Project Settings > Script properties (READER_SECRET).');
}

function same_(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function reply_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
