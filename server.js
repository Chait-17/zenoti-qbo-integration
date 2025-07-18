const express = require('express');
const axios = require('axios');
const { sql } = require('@vercel/postgres');

const app = express();

app.use(express.json());

// DEPLOYMENT CHECK 1: Middleware loaded
console.log('Middleware loaded');

// Initialize database tables
async function initDatabase() {
  try {
    await sql`CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      codat_company_id TEXT UNIQUE NOT NULL,
      authorized BOOLEAN DEFAULT false
    );`;

    await sql`CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      codat_account_id TEXT NOT NULL,
      company_id INTEGER REFERENCES companies(id)
    );`;

    await sql`CREATE TABLE IF NOT EXISTS synced_journals (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      journal_entry_id TEXT NOT NULL,
      company_id INTEGER REFERENCES companies(id),
      total_amount NUMERIC NOT NULL,
      status TEXT NOT NULL
    );`;
    console.log('Database tables initialized');
  } catch (error) {
    console.error('Database initialization error', error);
  }
}
initDatabase();

// /api/centers Endpoint
app.post('/api/centers', async (req, res) => {
  const { apiKey, companyName } = req.body;
  if (!apiKey || !companyName) {
    return res.status(400).json({ error: 'Missing API key or company name' });
  }

  try {
    const response = await axios.get('https://api.zenoti.com/v1/centers', {
      headers: { 'Authorization': `apikey ${apiKey}`, 'Content-Type': 'application/json' }
    });
    const centers = response.data.centers || response.data;
    if (centers && Array.isArray(centers)) {
      res.json({ centers });
    } else {
      res.json({ error: 'No refunds found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch centers: ' + (error.response?.data?.error || error.message) });
  }
});

// DEPLOYMENT CHECK 2: Centers endpoint defined
console.log('Centers endpoint defined');

// /api/auth-link Endpoint
app.post('/api/auth-link', async (req, res) => {
  const { apiKey, companyName, centerId } = req.body;
  if (!apiKey || !companyName || !centerId) {
    return res.status(400).json({ error: 'Missing API key, company name, or center ID' });
  }

  try {
    const codatApiKey = process.env.CODAT_API_KEY;
    if (!codatApiKey) {
      return res.status(500).json({ error: 'Codat API key not configured' });
    }

    const companyResponse = await axios.post('https://api.codat.io/companies', { name: companyName }, {
      headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' }
    });
    const companyId = companyResponse.data.id;

    const authResponse = await axios.post(`https://api.codat.io/companies/${companyId}/connections`, { platformKey: 'qhyg' }, {
      headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' }
    });
    const authUrl = authResponse.data.linkUrl;

    // Store company information in database
    await sql`INSERT INTO companies (name, codat_company_id, authorized) VALUES (${companyName}, ${companyId}, true) ON CONFLICT (name) DO UPDATE SET codat_company_id = ${companyId}, authorized = true`;

    res.json({ authUrl });
  } catch (error) {
    res.status(500).json({ error: `Failed to generate auth link: ${error.response?.data?.error || error.message}` });
  }
});

// DEPLOYMENT CHECK 3: Auth-link endpoint defined
console.log('Auth-link endpoint defined');

// /api/sync Endpoint
app.post('/api/sync', async (req, res) => {
  const { apiKey, companyName, centerId, startDate, endDate } = req.body;
  if (!apiKey || !companyName || !centerId || !startDate || !endDate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuidRegex.test(centerId)) {
    return res.status(400).json({ error: `Invalid centerId: ${centerId}` });
  }

  try {
    const codatApiKey = process.env.CODAT_API_KEY;
    if (!codatApiKey) {
      return res.status(500).json({ error: 'Codat API key not configured' });
    }

    // Check if company is authorized
    const companyQuery = await sql`SELECT codat_company_id, authorized FROM companies WHERE name = ${companyName}`;
    if (!companyQuery.rows.length || !companyQuery.rows[0].authorized) {
      return res.status(403).json({ error: 'Company not authorized' });
    }
    const companyId = companyQuery.rows[0].codat_company_id;

    const connectionsResponse = await axios.get(`https://api.codat.io/companies/${companyId}/connections`, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
    console.log(`Connections API response status: ${connectionsResponse.status}, URL: https://api.codat.io/companies/${companyId}/connections`);
    const connectionId = connectionsResponse.data.results[0]?.id;
    if (!connectionId) throw new Error('No connection found');

    let validCategories = [];
    const optionsResponse = await axios.get(`https://api.codat.io/companies/${companyId}/connections/${connectionId}/options/chartOfAccounts`, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
    console.log(`Options API response status: ${optionsResponse.status}, URL: https://api.codat.io/companies/${companyId}/connections/${connectionId}/options/chartOfAccounts`);
    validCategories = optionsResponse.data.properties.fullyQualifiedCategory.options.map(opt => opt.value);

    const categoryMap = {
      'Income': 'Income.Income.ServiceFeeIncome',
      'Liability': 'Liability.Other Current Liability.CurrentLiabilities',
      'Asset': 'Asset.Other Current Asset.OtherCurrentAssets'
    };

    let accountMap = {};
    let allAccounts = [];
    let accountsNextUrl = `https://api.codat.io/companies/${companyId}/data/accounts?page=1&pageSize=100`;
    while (accountsNextUrl) {
      const accountsResponse = await axios.get(accountsNextUrl, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
      console.log(`Accounts API response status: ${accountsResponse.status}, URL: ${accountsNextUrl}`);
      allAccounts = allAccounts.concat(accountsResponse.data.results || []);
      accountsNextUrl = accountsResponse.data._links?.next?.href;
      if (accountsNextUrl && !accountsNextUrl.startsWith('http')) accountsNextUrl = `https://api.codat.io${accountsNextUrl}`;
    }
    const existingAccounts = allAccounts;
    const requiredAccounts = {
      sales: { 'Zenoti service sales': { type: 'Income' }, 'Zenoti product sales': { type: 'Income' }, 'membership revenue account': { type: 'Income' }, 'Zenoti package liability account': { type: 'Liability' }, 'Zenoti gift card liability account': { type: 'Liability' } },
      collections: { 'Zenoti undeposited cash funds': { type: 'Asset' }, 'Zenoti undeposited card payment': { type: 'Asset' }, 'Zenoti package liability': { type: 'Liability' }, 'Membership redemptions': { type: 'Income' } },
      due: { 'Due Amount': { type: 'Asset' } }
    };
    for (const [accountName, { type }] of Object.entries({ ...requiredAccounts.sales, ...requiredAccounts.collections, ...requiredAccounts.due })) {
      const normalizedName = accountName.toLowerCase().trim();
      let account = existingAccounts.find(a => a.name.toLowerCase().trim() === normalizedName);
      if (!account) {
        const category = categoryMap[type];
        if (!category || !validCategories.includes(category)) throw new Error(`Invalid category ${category}`);
        const createResponse = await axios.post(`https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/accounts`, {
          name: accountName, description: `Account for ${accountName}`, fullyQualifiedCategory: category, fullyQualifiedName: accountName, currency: 'USD', currentBalance: 0, type, status: 'Active'
        }, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
        console.log(`Account creation response status: ${createResponse.status}, URL: https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/accounts, pushOperationKey: ${createResponse.data.pushOperationKey}`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Reduced initial delay to 5 seconds
        let operationStatus = 'Pending';
        let attempt = 0;
        let waitTime = 2000; // Initial wait time in ms
        while (operationStatus === 'Pending' && attempt < 5) { // Reduced to 5 attempts
          await new Promise(resolve => setTimeout(resolve, waitTime));
          try {
            const operationResponse = await axios.get(`https://api.codat.io/companies/${companyId}/push/${createResponse.data.pushOperationKey}`, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
            console.log(`Operation status response: ${operationResponse.status}, URL: https://api.codat.io/companies/${companyId}/push/${createResponse.data.pushOperationKey}, pushOperationKey: ${createResponse.data.pushOperationKey}, Data: ${JSON.stringify(operationResponse.data)}`);
            operationStatus = operation
