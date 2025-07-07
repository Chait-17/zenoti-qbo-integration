const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// Codat API configuration
const CODAT_API_KEY = process.env.CODAT_API_KEY;
const CODAT_BASE_URL = 'https://api.codat.io';
const ZENOTI_BASE_URL = 'https://api.zenoti.com/v1';

// Store company IDs in memory (use a database in production)
const companyIds = {};

// Middleware to validate Zenoti API key
async function validateZenotiApiKey(req, res, next) {
  const { apiKey, companyName } = req.body;
  if (!apiKey || !companyName) {
    return res.status(400).json({ error: 'Zenoti API key and company name are required' });
  }
  try {
    const response = await axios.get(`${ZENOTI_BASE_URL}/centers`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.status === 200) {
      req.zenotiApiKey = apiKey;
      req.companyName = companyName;
      next();
    } else {
      res.status(401).json({ error: 'Invalid Zenoti API key' });
    }
  } catch (error) {
    res.status(401).json({ error: 'Failed to validate Zenoti API key' });
  }
}

// Create or retrieve Codat company
async function getOrCreateCodatCompany(companyName) {
  if (companyIds[companyName]) {
    return companyIds[companyName];
  }
  try {
    const response = await axios.post(
      `${CODAT_BASE_URL}/companies`,
      { name: companyName },
      { headers: { Authorization: `Bearer ${CODAT_API_KEY}` } }
    );
    companyIds[companyName] = response.data.id;
    return response.data.id;
  } catch (error) {
    console.error('Error creating Codat company:', error);
    throw error;
  }
}

// Fetch Zenoti centers
app.post('/api/centers', validateZenotiApiKey, async (req, res) => {
  try {
    const response = await axios.get(`${ZENOTI_BASE_URL}/centers`, {
      headers: { Authorization: `Bearer ${req.zenotiApiKey}` },
    });
    res.json({ centers: response.data.centers });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch centers' });
  }
});

// Generate Codat authorization link
app.post('/api/auth-link', validateZenotiApiKey, async (req, res) => {
  const { centerId, companyName } = req.body;
  try {
    const companyId = await getOrCreateCodatCompany(companyName);
    const response = await axios.post(
      `${CODAT_BASE_URL}/connections`,
      { platformKey: 'qbo', companyId },
      { headers: { Authorization: `Bearer ${CODAT_API_KEY}` } }
    );
    res.json({ authUrl: response.data.redirect });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate auth link' });
  }
});

// Sync data to QuickBooks
app.post('/api/sync', validateZenotiApiKey, async (req, res) => {
  const { centerId, companyName } = req.body;
  const today = new Date().toISOString().split('T')[0];

  try {
    const companyId = await getOrCreateCodatCompany(companyName);

    // Fetch sales report
    const salesResponse = await axios.get(
      `${ZENOTI_BASE_URL}/sales/salesreport?center_id=${centerId}&start_date=${today}&end_date=${today}&item_type=7&status=2`,
      { headers: { Authorization: `Bearer ${req.zenotiApiKey}` } }
    );
    const sales = salesResponse.data.center_sales_report;

    // Fetch collections report
    const collectionsResponse = await axios.get(
      `${ZENOTI_BASE_URL}/Centers/${centerId}/collections_report?start_date=${today}&end_date=${today}`,
      { headers: { Authorization: `Bearer ${req.zenotiApiKey}` } }
    );
    const collections = collectionsResponse.data.collections_report;

    // Map item types to QBO accounts
    const accountMapping = {
      0: { name: 'Zenoti service sales', type: 'Income' },
      1: { name: 'Zenoti product sales', type: 'Income' },
      3: { name: 'membership revenue account', type: 'Income' },
      4: { name: 'Zenoti package liability account', type: 'Liability' },
      5: { name: 'Zenoti gift card liability account', type: 'Liability' },
      6: { name: 'Zenoti prepaid card liability account', type: 'Liability' },
    };

    const paymentAccountMapping = {
      CASH: { name: 'Zenoti undeposited cash funds', type: 'Asset' },
      CC: { name: 'Zenoti undeposited card payment', type: 'Asset' },
      'package_redemption': { name: 'Zenoti package liability', type: 'Liability' },
      'membership_redemption': { name: 'Membership redemptions', type: 'Income' },
      'prepaid_card_redemption': { name: 'Zenoti prepaid card liability account', type: 'Liability' },
      'gift_card_redemption': { name: 'Zenoti gift card liability account', type: 'Liability' },
    };

    // Fetch or create QBO accounts
    const accounts = {};
    const allAccountNames = [
      ...Object.values(accountMapping).map((acc) => acc.name),
      ...Object.values(paymentAccountMapping).map((acc) => acc.name),
      'Zenoti due account',
    ];

    for (const accountName of allAccountNames) {
      let account = await getQboAccount(accountName, companyId);
      if (!account) {
        const accountType = accountMapping[Object.keys(accountMapping).find(
          (key) => accountMapping[key].name === accountName
        )]?.type || paymentAccountMapping[Object.keys(paymentAccountMapping).find(
          (key) => paymentAccountMapping[key].name === accountName
        )]?.type || 'Asset';
        account = await createQboAccount(accountName, accountType, companyId);
      }
      accounts[accountName] = account.Id;
    }

    // Process sales and collections
    const journalEntries = [];
    const salesByType = {};
    sales.forEach((sale) => {
      const itemType = sale.item.type;
      const accountName = accountMapping[itemType]?.name || 'Zenoti service sales';
      salesByType[accountName] = (salesByType[accountName] || 0) + sale.final_sale_price;
    });

    const paymentsByType = {};
    collections.forEach((collection) => {
      collection.items.forEach((item) => {
        item.payments.forEach((payment) => {
          const paymentType = payment.type === 'CASH' ? 'CASH' : payment.type === 'CC' ? 'CC' : item.cashback_redemption > 0 ? 'cashback_redemption' : item[item.payment_type.toLowerCase()];
          const accountName = paymentAccountMapping[paymentType]?.name || 'Zenoti undeposited card payment';
          paymentsByType[accountName] = (paymentsByType[accountName] || 0) + payment.amount;
        });
      });
    });

    // Create journal entry
    const journalEntry = {
      Line: [],
      TxnDate: today,
    };

    // Credit sales accounts
    for (const [accountName, amount] of Object.entries(salesByType)) {
      if (amount > 0) {
        journalEntry.Line.push({
          DetailType: 'JournalEntryLineDetail',
          Amount: amount,
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { value: accounts[accountName] },
          },
        });
      }
    }

    // Debit payment accounts
    for (const [accountName, amount] of Object.entries(paymentsByType)) {
      if (amount > 0) {
        journalEntry.Line.push({
          DetailType: 'JournalEntryLineDetail',
          Amount: amount,
          JournalEntryLineDetail: {
            PostingType: 'Debit',
            AccountRef: { value: accounts[accountName] },
          },
        });
      }
    }

    // Handle due amounts
    const totalSales = Object.values(salesByType).reduce((sum, val) => sum + val, 0);
    const totalPayments = Object.values(paymentsByType).reduce((sum, val) => sum + val, 0);
    const dueAmount = totalSales - totalPayments;

    if (dueAmount !== 0) {
      journalEntry.Line.push({
        DetailType: 'JournalEntryLineDetail',
        Amount: Math.abs(dueAmount),
        JournalEntryLineDetail: {
          PostingType: dueAmount > 0 ? 'Debit' : 'Credit',
          AccountRef: { value: accounts['Zenoti due account'] },
        },
      });
    }

    // Post journal entry to QBO
    await postJournalEntry(journalEntry, companyId);

    res.json({ message: 'Data synced successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Sync failed: ' + error.message });
  }
});

// Helper functions for QBO interaction
async function getQboAccount(accountName, companyId) {
  try {
    const response = await axios.get(
      `${CODAT_BASE_URL}/companies/${companyId}/data/accounts`,
      { headers: { Authorization: `Bearer ${CODAT_API_KEY}` } }
    );
    return response.data.results.find((acc) => acc.name === accountName);
  } catch (error) {
    console.error('Error fetching QBO account:', error);
    return null;
  }
}

async function createQboAccount(accountName, accountType, companyId) {
  try {
    const response = await axios.post(
      `${CODAT_BASE_URL}/companies/${companyId}/data/accounts`,
      {
        name: accountName,
        accountType,
        currency: 'USD',
      },
      { headers: { Authorization: `Bearer ${CODAT_API_KEY}` } }
    );
    return response.data;
  } catch (error) {
    console.error('Error creating QBO account:', error);
    throw error;
  }
}

async function postJournalEntry(journalEntry, companyId) {
  try {
    await axios.post(
      `${CODAT_BASE_URL}/companies/${companyId}/data/journalEntries`,
      journalEntry,
      { headers: { Authorization: `Bearer ${CODAT_API_KEY}` } }
    );
  } catch (error) {
    console.error('Error posting journal entry:', error);
    throw error;
  }
}

// Vercel serverless function compatibility
module.exports = app;