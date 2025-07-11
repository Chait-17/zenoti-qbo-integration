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

  try {
    const codatApiKey = process.env.CODAT_API_KEY;
    if (!codatApiKey) {
      return res.status(500).json({ error: 'Codat API key not configured' });
    }

    // Find company by name with robust link-based pagination
    let allCompanies = [];
    let nextUrl = 'https://api.codat.io/companies?page=1&pageSize=100';

    while (nextUrl) {
      console.log('Fetching URL:', nextUrl); // Log the exact URL being fetched
      try {
        const companiesResponse = await axios.get(nextUrl, {
          headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' }
        });
        const pageData = companiesResponse.data.results || [];
        allCompanies = allCompanies.concat(pageData);
        console.log(`Fetched page, companies count: ${pageData.length}, total so far: ${allCompanies.length}`);
        console.log(`Page companies: ${pageData.map(c => c.name).join(', ')}`);
        nextUrl = companiesResponse.data._links?.next?.href;
        if (nextUrl && !nextUrl.startsWith('http')) {
          nextUrl = `https://api.codat.io${nextUrl}`; // Convert relative URL to absolute
        }
      } catch (error) {
        console.error('Error fetching companies page, URL:', nextUrl, error.response?.data || error.message);
        if (error.response?.status === 429) { // Rate limit
          console.log('Rate limit hit, waiting before retry...');
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        throw error;
      }
      if (allCompanies.length >= 1811) break; // Safety check based on totalResults
    }
    console.log('All companies fetched:', allCompanies.length, `Expected: 1811`);
    const company = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
    if (!company) throw new Error(`Company '${companyName}' not found in Codat. Available: ${allCompanies.map(c => c.name).join(', ')}`);
    const companyId = company.id;

    // Define required accounts
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

    // Fetch existing accounts and create missing ones
    const accountsResponse = await axios.get(
      `https://api.codat.io/companies/${companyId}/data/accounts`,
      { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } }
    );
    const existingAccounts = accountsResponse.data.results || [];
    const accountMap = {};
    for (const [accountName, { type }] of Object.entries({ ...requiredAccounts.sales, ...requiredAccounts.collections })) {
      let account = existingAccounts.find(a => a.name === accountName && a.accountType === type);
      if (!account) {
        const createResponse = await axios.post(
          `https://api.codat.io/companies/${companyId}/data/accounts`,
          {
            account: {
              name: accountName,
              accountType: type,
              status: 'Active',
              fullyQualifiedName: accountName,
              classification: type === 'Income' ? 'Revenue' : type === 'Current Liability' ? 'Liability' : 'Asset'
            }
          },
          { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } }
        );
        account = createResponse.data.data;
        console.log(`Created account: ${accountName}, ID: ${account.id}`);
      }
      accountMap[accountName] = account.id;
    }

    // Fetch Zenoti data in 7-day chunks
    const syncedDetails = [];
    let currentStart = new Date(startDate);
    const end = new Date(endDate);
    while (currentStart <= end) {
      const chunkEnd = new Date(currentStart);
      chunkEnd.setDate(chunkEnd.getDate() + 6); // 7-day window
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

      // Aggregate by day and create journal entries
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

        // Process sales (credits)
        sales.forEach(tx => {
          let account;
          switch (tx.item.type) {
            case 0: account = 'Zenoti service sales'; break; // Service
            case 2: account = 'Zenoti product sales'; break; // Product
            case 3: account = 'membership revenue account'; break; // Membership
            case 4: account = 'Zenoti package liability account'; break; // Package
            case 6: account = 'Zenoti gift card liability account'; break; // Gift Card
            default: account = 'Zenoti service sales'; // Default
          }
          const amount = tx.final_sale_price || 0;
          totalAmount += amount;
          journalLines.push({ accountRef: { id: accountMap[account] }, description: tx.item.name || 'Sale', amount: amount, isCredit: true });
        });

        // Process collections/redemptions (debits)
        collections.forEach(tx => {
          let account;
          switch (tx.paymentMethod) {
            case 'cash': account = 'Zenoti undeposited cash funds'; break;
            case 'card': account = 'Zenoti undeposited card payment'; break;
            case 'package': account = 'Zenoti package liability'; break;
            case 'membership': account = 'Membership redemptions'; break;
            case 'gift card': account = 'Zenoti gift card liability account'; break;
            case 'prepaid card': account = 'Zenoti prepaid card liability account'; break;
            default: account = 'Zenoti undeposited cash funds'; // Default
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

    res.json({ syncedDetails });
  } catch (error) {
    const errorMessage = error.response?.data?.error || error.message;
    console.error('Sync error details:', {
      message: errorMessage,
      response: error.response?.data,
      stack: error.stack
    });
    res.status(500).json({ error: `Sync failed: ${errorMessage}` });
  }
});

module.exports = app;
