const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// DEPLOYMENT CHECK 1: Middleware loaded
console.log('Middleware loaded');

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
      res.json({ error: 'No centers found' });
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

    let allCompanies = [];
    let nextUrl = 'https://api.codat.io/companies?page=1&pageSize=100';
    while (nextUrl) {
      const companiesResponse = await axios({ method: 'get', url: nextUrl, headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
      console.log(`Companies API response status: ${companiesResponse.status}, URL: ${nextUrl}`);
      allCompanies = allCompanies.concat(companiesResponse.data.results || []);
      nextUrl = companiesResponse.data._links?.next?.href;
      if (nextUrl && !nextUrl.startsWith('http')) nextUrl = `https://api.codat.io${nextUrl}`;
      if (allCompanies.length >= 1811) break;
    }
    const company = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
    if (!company) throw new Error(`Company '${companyName}' not found`);
    const companyId = company.id;

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

    let accountMap;
    const accountsResponse = await axios.get(`https://api.codat.io/companies/${companyId}/data/accounts`, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
    console.log(`Accounts API response status: ${accountsResponse.status}, URL: https://api.codat.io/companies/${companyId}/data/accounts`);
    const existingAccounts = accountsResponse.data.results || [];
    const requiredAccounts = {
      sales: { 'Zenoti service sales': { type: 'Income' }, 'Zenoti product sales': { type: 'Income' }, 'membership revenue account': { type: 'Income' }, 'Zenoti package liability account': { type: 'Liability' }, 'Zenoti gift card liability account': { type: 'Liability' } },
      collections: { 'Zenoti undeposited cash funds': { type: 'Asset' }, 'Zenoti undeposited card payment': { type: 'Asset' }, 'Zenoti package liability': { type: 'Liability' }, 'Membership redemptions': { type: 'Income' } }
    };
    accountMap = {};
    for (const [accountName, { type }] of Object.entries({ ...requiredAccounts.sales, ...requiredAccounts.collections })) {
      const normalizedName = accountName.toLowerCase().trim();
      let account = existingAccounts.find(a => a.name.toLowerCase().trim() === normalizedName);
      if (!account) {
        const category = categoryMap[type];
        if (!category || !validCategories.includes(category)) throw new Error(`Invalid category ${category}`);
        const createResponse = await axios.post(`https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/accounts`, {
          name: accountName, description: `Account for ${accountName}`, fullyQualifiedCategory: category, fullyQualifiedName: accountName, currency: 'USD', currentBalance: 0, type, status: 'Active'
        }, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
        console.log(`Account creation response status: ${createResponse.status}, URL: https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/accounts, pushOperationKey: ${createResponse.data.pushOperationKey}`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10-second delay
        let operationStatus = 'Pending';
        let attempt = 0;
        while (operationStatus === 'Pending' && attempt < 10) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          try {
            const operationResponse = await axios.get(`https://api.codat.io/companies/${companyId}/push/operations/${createResponse.data.pushOperationKey}`, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
            console.log(`Operation status response: ${operationResponse.status}, URL: https://api.codat.io/companies/${companyId}/push/operations/${createResponse.data.pushOperationKey}, pushOperationKey: ${createResponse.data.pushOperationKey}, Data: ${JSON.stringify(operationResponse.data)}`);
            operationStatus = operationResponse.data.status;
            if (operationStatus === 'Success') account = operationResponse.data.results?.data;
          } catch (error) {
            console.error(`Operation status error: ${error.message}, URL: https://api.codat.io/companies/${companyId}/push/operations/${createResponse.data.pushOperationKey}, Response: ${JSON.stringify(error.response?.data)}`);
            break;
          }
          attempt++;
        }
      }
      accountMap[accountName] = account?.id || null;
    }

    const syncedDetails = [];
    let currentStart = new Date(startDate);
    const end = new Date(endDate);
    while (currentStart <= end) {
      const chunkEnd = new Date(currentStart);
      chunkEnd.setDate(chunkEnd.getDate() + 6);
      if (chunkEnd > end) chunkEnd.setDate(end.getDate());

      const salesResponse = await axios.get(`https://api.zenoti.com/v1/sales/salesreport`, {
        headers: { 'Authorization': `apikey ${apiKey}`, 'Content-Type': 'application/json' },
        params: { center_id: centerId, start_date: currentStart.toISOString().split('T')[0], end_date: chunkEnd.toISOString().split('T')[0] }
      });
      console.log(`Sales API response status: ${salesResponse.status}, URL: https://api.zenoti.com/v1/sales/salesreport`);
      const collectionResponse = await axios.get(`https://api.zenoti.com/v1/Centers/${centerId}/collections_report`, {
        headers: { 'Authorization': `apikey ${apiKey}`, 'Content-Type': 'application/json' },
        params: { start_date: currentStart.toISOString().split('T')[0], end_date: chunkEnd.toISOString().split('T')[0] }
      });
      console.log(`Collections API response status: ${collectionResponse.status}, URL: https://api.zenoti.com/v1/Centers/${centerId}/collections_report`);

      const salesData = salesResponse.data.center_sales_report || [];
      const collectionData = collectionResponse.data.collections_report || [];
      const transactionsByDate = {};
      salesData.forEach(tx => { const date = new Date(tx.sold_on).toISOString().split('T')[0]; (transactionsByDate[date] ||= { sales: [], collections: [] }).sales.push(tx); });
      collectionData.forEach(tx => { const date = new Date(tx.created_date).toISOString().split('T')[0]; (transactionsByDate[date] ||= { sales: [], collections: [] }).collections.push(tx); });

      for (const [date, { sales, collections }] of Object.entries(transactionsByDate)) {
        let totalAmount = 0;
        const journalLines = [];
        sales.forEach(tx => {
          const account = [0, 2, 3, 4, 6].includes(tx.item.type) ? ['Zenoti service sales', 'Zenoti product sales', 'membership revenue account', 'Zenoti package liability account', 'Zenoti gift card liability account'][tx.item.type] : 'Zenoti service sales';
          const amount = tx.final_sale_price || 0;
          totalAmount += amount;
          if (accountMap[account]) journalLines.push({ description: tx.item.name || 'Sale', netAmount: amount, currency: 'USD', accountRef: { id: accountMap[account] } });
          const debitAccount = accountMap['Zenoti undeposited cash funds'] || accountMap['Zenoti undeposited card payment'];
          if (debitAccount) journalLines.push({ description: tx.item.name || 'Sale Debit', netAmount: -amount, currency: 'USD', accountRef: { id: debitAccount } });
        });
        collections.forEach(tx => {
          const account = { cash: 'Zenoti undeposited cash funds', CC: 'Zenoti undeposited card payment', Package: 'Zenoti package liability', Membership: 'Membership redemptions', GiftCard: 'Zenoti gift card liability account', PrepaidCard: 'Zenoti prepaid card liability account' }[tx.items[0].type] || 'Zenoti undeposited cash funds';
          const amount = tx.total_collection || 0;
          totalAmount += amount;
          if (accountMap[account]) journalLines.push({ description: tx.items[0].name || 'Collection', netAmount: amount, currency: 'USD', accountRef: { id: accountMap[account] } });
          const creditAccount = accountMap['membership revenue account'] || accountMap['Zenoti package liability account'];
          if (creditAccount) journalLines.push({ description: tx.items[0].name || 'Collection Credit', netAmount: -amount, currency: 'USD', accountRef: { id: creditAccount } });
        });

        if (journalLines.length > 0) {
          const journalResponse = await axios.post(`https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/journalEntries`, {
            postedOn: `${date}T00:00:00`, journalLines, modifiedDate: '0001-01-01T00:00:00'
          }, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
          console.log(`Journal API response status: ${journalResponse.status}, URL: https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/journalEntries, Data: ${JSON.stringify(journalResponse.data)}`);
          // Poll the journal push operation status
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second initial delay
          let journalOperationStatus = 'Pending';
          let attempt = 0;
          let pushOperationKey = journalResponse.data.pushOperationKey;
          while (journalOperationStatus === 'Pending' && attempt < 10) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
              const operationResponse = await axios.get(`https://api.codat.io/companies/${companyId}/push/operations/${pushOperationKey}`, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
              console.log(`Journal operation status response: ${operationResponse.status}, URL: https://api.codat.io/companies/${companyId}/push/operations/${pushOperationKey}, Data: ${JSON.stringify(operationResponse.data)}`);
              journalOperationStatus = operationResponse.data.status;
              if (journalOperationStatus === 'Success') syncedDetails.push({ date, totalAmount, journalEntryId: operationResponse.data.data?.id || pushOperationKey });
            } catch (error) {
              console.error(`Journal operation status error: ${error.message}, URL: https://api.codat.io/companies/${companyId}/push/operations/${pushOperationKey}, Response: ${JSON.stringify(error.response?.data)}`);
              break;
            }
            attempt++;
          }
        }
      }
      currentStart.setDate(chunkEnd.getDate() + 1);
    }

    res.json({ syncedDetails });
  } catch (error) {
    console.error(`Sync error: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ error: `Sync failed: ${error.message}` });
  }
});

// DEPLOYMENT CHECK 4: Sync endpoint defined
console.log('Sync endpoint defined');

// DEPLOYMENT CHECK 5: File fully deployed
console.log('Server.js deployed successfully');

module.exports = app;
