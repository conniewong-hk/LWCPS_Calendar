const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.use(express.json());
app.use(cors());

// Parse service account credentials
function parseServiceAccountKey(rawKey) {
  if (!rawKey) {
    throw new Error('Missing SERVICE_ACCOUNT_KEY in environment variables.');
  }

  try {
    return JSON.parse(rawKey);
  } catch (err) {
    throw new Error(`Invalid SERVICE_ACCOUNT_KEY JSON: ${err.message}`);
  }
}

function getGoogleErrorMessage(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.error ||
    error?.message ||
    'Unknown Google API error'
  );
}

const serviceAccount = parseServiceAccountKey(process.env.SERVICE_ACCOUNT_KEY);

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar',
  ],
});

const sheets = google.sheets({
  version: 'v4',
  auth: auth,
});

const calendar = google.calendar({
  version: 'v3',
  auth: auth,
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend is running!' });
});

// Read bookings from Google Sheets
app.get('/api/bookings', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: process.env.SHEET_RANGE || 'Sheet1!A:Z',
    });
    res.json(response.data.values || []);
  } catch (error) {
    const errorMessage = getGoogleErrorMessage(error);
    console.error('Error reading sheets:', errorMessage);
    res.status(500).json({ error: errorMessage });
  }
});

// Add booking to Google Sheets
app.post('/api/bookings', async (req, res) => {
  try {
    const { values } = req.body;
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: process.env.SHEET_RANGE || 'Sheet1!A:Z',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
    res.json(response.data);
  } catch (error) {
    const errorMessage = getGoogleErrorMessage(error);
    console.error('Error appending to sheets:', errorMessage);
    res.status(500).json({ error: errorMessage });
  }
});

// Add calendar event
app.post('/api/calendar-events', async (req, res) => {
  try {
    const { event } = req.body;
    const response = await calendar.events.insert({
      calendarId: process.env.CALENDAR_ID,
      requestBody: event,
    });
    res.json(response.data);
  } catch (error) {
    const errorMessage = getGoogleErrorMessage(error);
    console.error('Error creating calendar event:', errorMessage);
    console.error('Full error details:', JSON.stringify(error.response?.data || error.message, null, 2));
    res.status(500).json({ error: errorMessage, details: error.response?.data || null });
  }
});

// Check calendar access
app.get('/api/calendar-check', async (req, res) => {
  try {
    const response = await calendar.calendars.get({
      calendarId: process.env.CALENDAR_ID,
    });
    res.json({ ok: true, summary: response.data.summary, id: response.data.id });
  } catch (error) {
    const errorMessage = getGoogleErrorMessage(error);
    console.error('Calendar check failed:', errorMessage);
    res.status(500).json({ ok: false, error: errorMessage, details: error.response?.data || null });
  }
});

// Add audit log
app.post('/api/audit', async (req, res) => {
  try {
    const { action, actor, description, reason } = req.body;
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: process.env.AUDIT_RANGE || 'AuditLog!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: { 
        values: [[new Date().toISOString(), actor, action, description, reason || '']] 
      },
    });
    res.json(response.data);
  } catch (error) {
    const errorMessage = getGoogleErrorMessage(error);
    console.error('Error writing audit log:', errorMessage);
    res.status(500).json({ error: errorMessage });
  }
});

// Read audit log
app.get('/api/audit', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: process.env.AUDIT_RANGE || 'AuditLog!A:E',
    });
    const rows = response.data.values || [];
    const entries = rows.slice(1).map(row => ({
      timestamp: row[0] || '',
      actor: row[1] || '',
      action: row[2] || 'sub',
      description: row[3] || '',
      reason: row[4] || '',
    }));
    res.json({ entries });
  } catch (error) {
    const errorMessage = getGoogleErrorMessage(error);
    console.error('Error reading audit log:', errorMessage);
    res.status(500).json({ error: errorMessage });
  }
});

// Derive sheet tab name from SHEET_NAME or SHEET_RANGE env vars
function getSheetName() {
  if (process.env.SHEET_NAME) return process.env.SHEET_NAME;
  const range = process.env.SHEET_RANGE || 'Sheet1!A:Z';
  return range.split('!')[0];
}

// Update status in sheet
app.put('/api/sheets/update-status', async (req, res) => {
  try {
    const { rowIndex, status } = req.body;
    const range = `${getSheetName()}!L${rowIndex}`;
    const response = await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[status]] },
    });
    res.json(response.data);
  } catch (error) {
    const errorMessage = getGoogleErrorMessage(error);
    console.error('Error updating status:', errorMessage);
    res.status(500).json({ error: errorMessage });
  }
});

// Update fields in sheet
app.put('/api/sheets/update-fields', async (req, res) => {
  try {
    const { rowIndex, fields } = req.body;
    const sheetName = getSheetName();
    const data = [
      { range: `${sheetName}!E${rowIndex}`, values: [[fields.eventName]] },
      { range: `${sheetName}!F${rowIndex}`, values: [[fields.startTime]] },
      { range: `${sheetName}!G${rowIndex}`, values: [[fields.endTime]] },
      { range: `${sheetName}!H${rowIndex}`, values: [[fields.venue]] },
      { range: `${sheetName}!I${rowIndex}`, values: [[fields.date]] },
    ];
    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.SHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: data,
      },
    });
    res.json(response.data);
  } catch (error) {
    const errorMessage = getGoogleErrorMessage(error);
    console.error('Error updating fields:', errorMessage);
    res.status(500).json({ error: errorMessage });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
  console.log(`📝 Test: http://localhost:${PORT}/api/test`);
});