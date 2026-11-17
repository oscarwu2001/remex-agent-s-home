/** @OnlyCurrentDoc */
/*
 * Agent's Home reader
 *
 * Lets Agent's Home on your computer read one tab of this spreadsheet.
 * It only reads; it never changes the sheet. @OnlyCurrentDoc (above, on its
 * own line) makes Google limit this script to this one spreadsheet: the
 * permission prompt should mention only "spreadsheets that this application
 * has been installed in".
 *
 * It answers only a POST that carries the secret saved under
 * Project Settings > Script properties as READER_SECRET (make one with
 * makeSecret below). Without that secret it refuses every request.
 *
 * Dates go out as UTC times (ISO, ending in Z) and numbers as numbers, with
 * the spreadsheet's time zone for anything typed as plain text.
 */
const TAB = 'Form Responses 1'; // the name of the tab your answers go to

function doPost(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('READER_SECRET') || '';
  let sent = '';
  try {
    sent = String(JSON.parse(e.postData.contents).secret || '');
  } catch (err) {
    sent = ''; // a request that is not JSON is refused just below
  }
  if (secret.length < 32 || !same_(sent, secret)) return reply_({ ok: false, error: 'not allowed' });
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(TAB);
  if (!sheet) return reply_({ ok: false, error: 'tab not found' });
  return reply_({
    ok: true,
    tab: TAB,
    timeZone: book.getSpreadsheetTimeZone(),
    values: sheet.getDataRange().getValues(),
  });
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
