const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

app.post('/api/centers', async (req, res) => {
  const { apiKey, companyName } = req.body;
  if (!apiKey || !companyName) {
    return res.status(400).json({ error: 'Missing API key or company name' });
  }

  try {
    const response = await axios.get('https://api.zenoti.com/v1/centers', {
      headers: {
        'Authorization': `apikey ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    const centers = response.data.centers || response.data;
    if (centers && Array.isArray(centers)) {
      res.json({ centers });
    } else {
      res.json({ error: 'No centers found in response' });
    }
  } catch (error) {
    console.error('Zenoti API error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch centers from Zenoti: ' + (error.response?.data?.error || error.message) });
  }
});

app.post('/api/auth-link', async (req, res) => {
  const { apiKey, companyName, centerId } = req.body;
  if (!apiKey || !companyName || !centerId) {
    return res.status(400).json({ error: 'Missing API key, company name, or center ID' });
  }

  try {
    const codatApiKey = process.env.CODAT_API_KEY;
    console.log('CODAT_API_KEY:', codatApiKey);
    if (!codatApiKey) {
      return res.status(500).json({ error: 'Codat API key not configured' });
    }

    // Create a Codat company
    console.log('Creating Codat company for:', companyName);
    const companyResponse = await axios.post(
      'https://api.codat.io/companies',
      { name: companyName },
      {
        headers: {
          'Authorization': `Basic ${codatApiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const companyId = companyResponse.data.id;
    console.log('Company created, ID:', companyId);

    // Generate QuickBooks OAuth link
    console.log('Generating QBO connection for company:', companyId);
    const authResponse = await axios.post(
      `https://api.codat.io/companies/${companyId}/connections`,
      {
        platformKey: 'qhyg'
      },
      {
        headers: {
          'Authorization': `Basic ${codatApiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const authUrl = authResponse.data.linkUrl;
    console.log('Auth URL generated:', authUrl);

    res.json({ authUrl });
  } catch (error) {
    const errorMessage = error.response?.data?.error || error.message;
    console.error('Codat API error:', error.response?.data || error.message);
    res.status(500).json({ error: `Failed to generate auth link: ${errorMessage}` });
  }
});

app.post('/api/sync', async (req, res) => {
  const { apiKey, companyName, centerId, startDate, endDate } = req.body;
  if (!apiKey || !companyName || !centerId || !startDate || !endDate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate centerId as a UUID
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuidRegex.test(centerId)) {
    return res.status(400).json({ error: `Invalid centerId: ${centerId}. Must be a valid UUID.` });
  }
  console.log('Using centerId:', centerId);

  try {
    const codatApiKey = process.env.CODAT_API_KEY;
    if (!codatApiKey) {
      return res.status(500).json({ error: 'Codat API key not configured' });
    }

    // Fetch companies with robust link-based pagination
    let allCompanies = [];
    let nextUrl = 'https://api.codat.io/companies?page=1&pageSize=100';

    try {
      while (nextUrl) {
        console.log('Fetching URL:', nextUrl);
        const companiesResponse = await axios({
          method: 'get',
          url: nextUrl,
          headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' }
        });
        const pageData = companiesResponse.data.results || [];
        allCompanies = allCompanies.concat(pageData);
        console.log(`Fetched page, companies count: ${pageData.length}, total so far: ${allCompanies.length}, status: ${companiesResponse.status}`);
        console.log(`Page companies: ${pageData.map(c => c.name).join(', ')}`);
        nextUrl = companiesResponse.data._links?.next?.href;
        if (nextUrl && !nextUrl.startsWith('http')) {
          nextUrl = `https://api.codat.io${nextUrl}`;
        }
        if (allCompanies.length >= 1811) break; // Safety check
      }
    } catch (paginationError) {
      console.error('Pagination error:', {
        message: paginationError.message,
        url: nextUrl,
        status: paginationError.response?.status,
        data: paginationError.response?.data
      });
      throw new Error(`Failed to fetch companies: ${paginationError.message}`);
    }
    console.log('All companies fetched:', allCompanies.length, `Expected: 1811`);
    const company = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
    if (!company) throw new Error(`Company '${companyName}' not found in Codat. Available: ${allCompanies.map(c => c.name).join(', ')}`);
    const companyId = company.id;

    // Fetch connection details
    const connectionsResponse = await axios.get(
      `https://api.codat.io/companies/${companyId}/connections`,
      { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } }
    );
    const connectionId = connectionsResponse.data.results[0]?.id;
    if (!connectionId) throw new Error('No connection found for company');

    // Fetch valid account creation options
    let validCategories = [];
    try {
      const optionsResponse = await axios.get(
        `https://api.codat.io/companies/${companyId}/connections/${connectionId}/options/chartOfAccounts`,
        { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } }
      );
      validCategories = optionsResponse.data.properties.fullyQualifiedCategory.options.map(opt => opt.value);
      console.log('Fetched valid categories:', validCategories);
    } catch (optionsError) {
      console.error('Failed to fetch account options:', {
        message: optionsError.message,
        status: optionsError.response?.status,
        data: optionsError.response?.data
      });
      throw new Error('Failed to fetch account creation options');
    }

    // Map account types to specific categories
    const categoryMap = {
      'Income': 'Income.Income.ServiceFeeIncome',
      'Current Liability': 'Liability.Other Current Liability.CurrentLiabilities',
      'Current Asset': 'Asset.Other Current Asset.UndepositedFunds'
    };

    // Fetch and process accounts
    let accountMap;
    try {
      const accountsResponse = await axios.get(
        `https://api.codat.io/companies/${companyId}/data/accounts`,
        { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } }
      );
      const existingAccounts = accountsResponse.data.results || [];
      console.log('Existing accounts:', existingAccounts.map(a => ({ name: a.name, type: a.accountType })));
      const requiredAccounts = {
        sales: {
          'Zenoti service sales': { type: 'Income' },
          'Zenoti product sales': { type: 'Income' },
          'membership revenue account': { type: 'Income' },
          'Zenoti package liability account': { type: 'Current Liability' },
          'Zenoti gift card liability account': { type: 'Current Liability' }
        },
        collections: {
          'Zenoti undeposited cash funds': { type: 'Current Asset' },
          'Zenoti undeposited card payment': { type: 'Current Asset' },
          'Zenoti package liability': { type: 'Current Liability' },
          'Membership redemptions': { type: 'Income' }
        }
      };
      accountMap = {};
      for (const [accountName, { type }] of Object.entries({ ...requiredAccounts.sales, ...requiredAccounts.collections })) {
        const normalizedName = accountName.toLowerCase().trim();
        let account = existingAccounts.find(a => a.name.toLowerCase().trim() === normalizedName && a.accountType === type);
        if (!account) {
          console.log(`Attempting to create account: ${accountName}, Type: ${type}, Company ID: ${companyId}`);
          const category = categoryMap[type];
          if (!category || !validCategories.includes(category)) {
            throw new Error(`Invalid category ${category} for type ${type}. Available: ${validCategories.join(', ')}`);
          }
          console.log('Payload for account creation:', {
            name: accountName,
            description: `Account for ${accountName}`,
            fullyQualifiedCategory: category,
            fullyQualifiedName: accountName,
            currency: 'USD',
            currentBalance: 0,
            type: type,
            status: 'Active'
          });
          try {
            const createResponse = await axios.post(
              `https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/accounts`,
              {
                name: accountName,
                description: `Account for ${accountName}`,
                fullyQualifiedCategory: category,
                fullyQualifiedName: accountName,
                currency: 'USD',
                currentBalance: 0,
                type: type,
                status: 'Active'
              },
              { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } }
            );
            account = createResponse.data.data;
            console.log(`Created account: ${accountName}, ID: ${account.id}`);
          } catch (createError) {
            console.error(`Failed to create account ${accountName}:`, {
              status: createError.response?.status,
              data: createError.response?.data || createError.message
            });
            account = existingAccounts.find(a => a.name.toLowerCase().trim() === normalizedName) || { id: null };
            console.log(`Falling back to existing or skipping account: ${accountName}`);
          }
        } else {
          console.log(`Account already exists: ${accountName}, ID: ${account.id}`);
          accountMap[accountName] = account.id;
          continue;
        }
        accountMap[accountName] = account.id || accountMap[accountName] || null;
      }
    } catch (accountsError) {
      console.error('Accounts error:', {
        message: accountsError.message,
        status: accountsError.response?.status,
        data: accountsError.response?.data
      });
      throw new Error(`Failed to process accounts: ${accountsError.message}`);
    }

    // Fetch Zenoti data and sync
    const syncedDetails = [];
    try {
      let currentStart = new Date(startDate);
      const end = new Date(endDate);
      while (currentStart <= end) {
        const chunkEnd = new Date(currentStart);
        chunkEnd.setDate(chunkEnd.getDate() + 6);
        if (chunkEnd > end) chunkEnd.setDate(end.getDate());

        const salesResponse = await axios.get(`https://api.zenoti.com/v1/sales/salesreport`, {
          headers: { 'Authorization': `apikey ${apiKey}`, 'Content-Type': 'application/json' },
          params: { centerId, startDate: currentStart.toISOString().split('T')[0], endDate: chunkEnd.toISOString().split('T')[0] }
        });
        const collectionResponse = await axios.get(`https://api.zenoti.com/v1/collections_report`, {
          headers: { 'Authorization': `apikey ${apiKey}`, 'Content-Type': 'application/json' },
          params: { centerId, startDate: currentStart.toISOString().split('T')[0], endDate: chunkEnd.toISOString().split('T')[0] }
        });

        const salesData = salesResponse.data.center_sales_report || [];
        const collectionData = collectionResponse.data.collections || [];

        const transactionsByDate = {};
        salesData.forEach(tx => {
          const date = new Date(tx.sold_on).toISOString().split('T')[0];
          if (!transactionsByDate[date]) transactionsByDate[date] = { sales: [], collections: [] };
          transactionsByDate[date].sales.push(tx);
        });
        collectionData.forEach(tx => {
          const date = new Date(tx.date).toISOString().split('T')[0];
          if (!transactionsByDate[date]) transactionsByDate[date] = { sales: [], collections: [] };
          transactionsByDate[date].collections.push(tx);
        });

        for (const [date, { sales, collections }] of Object.entries(transactionsByDate)) {
          let totalAmount = 0;
          const journalLines = [];

          sales.forEach(tx => {
            let account;
            switch (tx.item.type) {
              case 0: account = 'Zenoti service sales'; break;
              case 2: account = 'Zenoti product sales'; break;
              case 3: account = 'membership revenue account'; break;
              case 4: account = 'Zenoti package liability account'; break;
              case 6: account = 'Zenoti gift card liability account'; break;
              default: account = 'Zenoti service sales';
            }
            const amount = tx.final_sale_price || 0;
            totalAmount += amount;
            journalLines.push({ accountRef: { id: accountMap[account] }, description: tx.item.name || 'Sale', amount: amount, isCredit: true });
          });

          collections.forEach(tx => {
            let account;
            switch (tx.paymentMethod) {
              case 'cash': account = 'Zenoti undeposited cash funds'; break;
              case 'card': account = 'Zenoti undeposited card payment'; break;
              case 'package': account = 'Zenoti package liability'; break;
              case 'membership': account = 'Membership redemptions'; break;
              case 'gift card': account = 'Zenoti gift card liability account'; break;
              case 'prepaid card': account = 'Zenoti prepaid card liability account'; break;
              default: account = 'Zenoti undeposited cash funds';
            }
            const amount = tx.amount || 0;
            totalAmount += amount;
            journalLines.push({ accountRef: { id: accountMap[account] }, description: tx.description || 'Collection/Redemption', amount: amount, isCredit: false });
          });

          if (journalLines.length > 0) {
            const journalResponse = await axios.post(
              `https://api.codat.io/companies/${companyId}/data/journals`,
              {
                journal: {
                  journalLines,
                  date: date
                }
              },
              { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } }
            );
            const journalEntryId = journalResponse.data.data.id;
            syncedDetails.push({ date, totalAmount, journalEntryId });
          }
        }

        currentStart.setDate(chunkEnd.getDate() + 1);
      }
    } catch (syncError) {
      console.error('Sync error:', {
        message: syncError.message,
        status: syncError.response?.status,
        data: syncError.response?.data
      });
      throw new Error(`Failed to sync data: ${syncError.message}`);
    }

    res.json({ syncedDetails });
  } catch (error) {
    const errorMessage = error.message;
    console.error('Sync error details:', {
      message: errorMessage,
      response: error.response?.data,
      stack: error.stack
    });
    res.status(500).json({ error: `Sync failed: ${errorMessage}` });
  }
});

module.exports = app;
