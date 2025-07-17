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
      collections: { 'Zenoti undeposited cash funds': { type: 'Asset' }, 'Zenoti undeposited card payment': { type: 'Asset' }, 'Zenoti package liability': { type: 'Liability' }, 'Membership redemptions': { type: 'Income' } },
      due: { 'Due Amount': { type: 'Asset' } }
    };
    accountMap = {};
    for (const [accountName, { type }] of Object.entries({ ...requiredAccounts.sales, ...requiredAccounts.collections, ...requiredAccounts.due })) {
      const normalizedName = accountName.toLowerCase().trim();
      let account = existingAccounts.find(a => a.name.toLowerCase().trim() === normalizedName || (a.fullyQualifiedName && a.fullyQualifiedName.toLowerCase().trim() === normalizedName));
      if (!account) {
        const category = categoryMap[type];
        if (!category || !validCategories.includes(category)) throw new Error(`Invalid category ${category}`);
        const createResponse = await axios.post(`https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/accounts`, {
          name: accountName, description: `Account for ${accountName}`, fullyQualifiedCategory: category, fullyQualifiedName: accountName, currency: 'USD', currentBalance: 0, type, status: 'Active'
        }, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
        console.log(`Account creation response status: ${createResponse.status}, URL: https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/accounts, pushOperationKey: ${createResponse.data.pushOperationKey}`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // Reduced delay to 10 seconds
        let operationStatus = 'Pending';
        let attempt = 0;
        const maxAttempts = 10; // Reduced to 10 attempts
        const startTime = Date.now();
        const maxDuration = 60000; // 60-second max duration
        while (operationStatus === 'Pending' && attempt < maxAttempts && (Date.now() - startTime) < maxDuration) {
          await new Promise(resolve => setTimeout(resolve, 3000)); // Reduced wait to 3 seconds
          try {
            const operationResponse = await axios.get(`https://api.codat.io/companies/${companyId}/push/${createResponse.data.pushOperationKey}`, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
            console.log(`Operation status response: ${operationResponse.status}, URL: https://api.codat.io/companies/${companyId}/push/${createResponse.data.pushOperationKey}, Data: ${JSON.stringify(operationResponse.data)}`);
            operationStatus = operationResponse.data.status;
            if (operationStatus === 'Success') {
              account = operationResponse.data.results?.data;
            } else if (operationStatus === 'Failed' && operationResponse.data.errorMessage && operationResponse.data.errorMessage.includes('already exists')) {
              account = existingAccounts.find(a => a.name.toLowerCase().trim() === normalizedName || (a.fullyQualifiedName && a.fullyQualifiedName.toLowerCase().trim() === normalizedName));
              break;
            }
          } catch (error) {
            if (error.response?.status === 404) {
              console.warn(`Operation not found yet, retrying... Error: ${error.message}, URL: https://api.codat.io/companies/${companyId}/push/${createResponse.data.pushOperationKey}`);
              continue; // Retry on 404
            } else {
              console.error(`Operation status error: ${error.message}, URL: https://api.codat.io/companies/${companyId}/push/${createResponse.data.pushOperationKey}, Response: ${JSON.stringify(error.response?.data)}`);
              break;
            }
          }
          attempt++;
        }
        if (!account) {
          console.warn(`Account ${accountName} creation timed out or failed, proceeding with existing check`);
          account = existingAccounts.find(a => a.name.toLowerCase().trim() === normalizedName || (a.fullyQualifiedName && a.fullyQualifiedName.toLowerCase().trim() === normalizedName));
        }
      }
      if (account) {
        accountMap[accountName] = account.id;
      } else {
        throw new Error(`Account ${accountName} not found or creation failed`);
      }
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
      console.log(`Sales API response status: ${salesResponse.status}, URL: https://api.zenoti.com/v1/sales/salesreport, Data: ${JSON.stringify(salesResponse.data)}`);
      const collectionResponse = await axios.get(`https://api.zenoti.com/v1/Centers/${centerId}/collections_report`, {
        headers: { 'Authorization': `apikey ${apiKey}`, 'Content-Type': 'application/json' },
        params: { start_date: currentStart.toISOString().split('T')[0], end_date: chunkEnd.toISOString().split('T')[0] }
      });
      console.log(`Collections API response status: ${collectionResponse.status}, URL: https://api.zenoti.com/v1/Centers/${centerId}/collections_report, Data: ${JSON.stringify(collectionResponse.data)}`);

      const salesData = salesResponse.data.center_sales_report || [];
      const collectionData = collectionResponse.data.collections_report || [];
      const transactionsByDate = {};
      salesData.forEach(tx => {
        const date = (tx.item.type === 0 ? new Date(tx.serviced_on) : new Date(tx.sold_on)).toISOString().split('T')[0];
        if (date !== '0001-01-01' && tx.final_sale_price > 0) {
          (transactionsByDate[date] ||= { salesByType: { 0: 0, 2: 0, 3: 0, 4: 0, 6: 0 }, refunds: [], payments: [], redemptions: [], refundPayments: [] }).salesByType[tx.item.type] += tx.final_sale_price;
        }
      });
      collectionData.forEach(tx => {
        const date = new Date(tx.created_date).toISOString().split('T')[0];
        const type = tx.items[0].type;
        (transactionsByDate[date] ||= { salesByType: { 0: 0, 2: 0, 3: 0, 4: 0, 6: 0 }, refunds: [], payments: [], redemptions: [], refundPayments: [] })[type === 'Refund' ? 'refunds' : type === 'Payment' ? 'payments' : type === 'Redemption' ? 'redemptions' : type === 'RefundPayment' ? 'refundPayments' : 'payments'].push(tx);
      });

      for (const [date, { salesByType, refunds, payments, redemptions, refundPayments }] of Object.entries(transactionsByDate)) {
        console.log(`Processing date ${date}: SalesByType ${JSON.stringify(salesByType)}, Refunds ${refunds.length}, Payments ${payments.length}, Redemptions ${redemptions.length}, RefundPayments ${refundPayments.length}`);
        let totalSales = Object.values(salesByType).reduce((sum, value) => sum + value, 0);
        let totalRefunds = refunds.reduce((sum, tx) => sum + (tx.total_collection || 0), 0);
        let totalPayments = payments.reduce((sum, tx) => sum + (tx.total_collection || 0), 0);
        let totalRedemptions = redemptions.reduce((sum, tx) => sum + (tx.total_collection || 0), 0);
        let totalRefundPayments = refundPayments.reduce((sum, tx) => sum + (tx.total_collection || 0), 0);

        let netSales = totalSales - totalRefunds;
        let netPayments = totalPayments + totalRedemptions - totalRefundPayments;
        let dueAmount = netPayments - netSales;
        console.log(`For ${date}: netSales ${netSales}, netPayments ${netPayments}, dueAmount ${dueAmount}`);

        const journalLines = [];
        // Credit sales by type
        const typeMap = { 0: 'Service', 2: 'Product', 3: 'Membership', 4: 'Package', 6: 'Gift Card' };
        if (salesByType[0] > 0 && accountMap['Zenoti service sales']) {
          journalLines.push({ description: typeMap[0], netAmount: salesByType[0], currency: 'USD', accountRef: { id: accountMap['Zenoti service sales'] } });
        }
        if (salesByType[2] > 0 && accountMap['Zenoti product sales']) {
          journalLines.push({ description: typeMap[2], netAmount: salesByType[2], currency: 'USD', accountRef: { id: accountMap['Zenoti product sales'] } });
        }
        if (salesByType[3] > 0 && accountMap['membership revenue account']) {
          journalLines.push({ description: typeMap[3], netAmount: salesByType[3], currency: 'USD', accountRef: { id: accountMap['membership revenue account'] } });
        }
        if (salesByType[4] > 0 && accountMap['Zenoti package liability account']) {
          journalLines.push({ description: typeMap[4], netAmount: salesByType[4], currency: 'USD', accountRef: { id: accountMap['Zenoti package liability account'] } });
        }
        if (salesByType[6] > 0 && accountMap['Zenoti gift card liability account']) {
          journalLines.push({ description: typeMap[6], netAmount: salesByType[6], currency: 'USD', accountRef: { id: accountMap['Zenoti gift card liability account'] } });
        }
        // Debit refunds
        refunds.forEach(tx => {
          const amount = tx.total_collection || 0;
          if (accountMap['Zenoti undeposited cash funds'] && amount > 0) {
            journalLines.push({ description: 'Refund', netAmount: -amount, currency: 'USD', accountRef: { id: accountMap['Zenoti undeposited cash funds'] } });
            // Credit to offset refund (e.g., reduce sales or liability)
            journalLines.push({ description: 'Refund Offset', netAmount: amount, currency: 'USD', accountRef: { id: accountMap['Zenoti service sales'] } });
          }
        });
        // Debit payments based on payment method and credit receivables
        payments.forEach(tx => {
          tx.items[0].payments.forEach(payment => {
            const amount = payment.amount || 0;
            if (amount > 0) {
              // Map payment type to account
              let paymentAccount;
              if (payment.type === 'CC') {
                paymentAccount = accountMap['Zenoti undeposited card payment'];
              } else if (payment.type === 'Cash' || (salesData.some(s => s.payment_type === 'Cash' && s.invoice_no === tx.invoice_no))) {
                paymentAccount = accountMap['Zenoti undeposited cash funds'];
              } else {
                paymentAccount = accountMap['Zenoti undeposited cash funds']; // Default to cash if unknown
              }
              if (paymentAccount) {
                journalLines.push({ description: `Payment (${payment.type} ${payment.detail_type})`, netAmount: -amount, currency: 'USD', accountRef: { id: paymentAccount } });
                // Credit receivables to balance
                journalLines.push({ description: 'Payment Received', netAmount: amount, currency: 'USD', accountRef: { id: accountMap['Due Amount'] } });
              }
            }
          });
        });
        // Debit redemptions and credit revenue
        redemptions.forEach(tx => {
          const amount = tx.total_collection || 0;
          if (accountMap['Membership redemptions'] && amount > 0) {
            journalLines.push({ description: 'Redemption', netAmount: -amount, currency: 'USD', accountRef: { id: accountMap['Membership redemptions'] } });
            journalLines.push({ description: 'Redemption Revenue', netAmount: amount, currency: 'USD', accountRef: { id: accountMap['membership revenue account'] } });
          }
        });
        // Credit refund payments to liability
        refundPayments.forEach(tx => {
          const amount = tx.total_collection || 0;
          if (accountMap['Zenoti package liability account'] && amount > 0) {
            journalLines.push({ description: 'Refund Payment', netAmount: amount, currency: 'USD', accountRef: { id: accountMap['Zenoti package liability account'] } });
            // Debit to balance (e.g., cash or undeposited funds)
            journalLines.push({ description: 'Refund Payment Offset', netAmount: -amount, currency: 'USD', accountRef: { id: accountMap['Zenoti undeposited cash funds'] } });
          }
        });
        // Add due amount to balance (Debit if sales > payments, Credit if payments > sales for Asset account)
        if (dueAmount !== 0 && accountMap['Due Amount']) {
          journalLines.push({ description: 'Due Amount', netAmount: dueAmount < 0 ? -dueAmount : dueAmount, currency: 'USD', accountRef: { id: accountMap['Due Amount'] } });
        }

        if (journalLines.length > 0) {
          console.log(`Journal Lines for ${date}: ${JSON.stringify(journalLines)}`);
          const totalDebit = journalLines.filter(line => line.netAmount < 0).reduce((sum, line) => sum + -line.netAmount, 0);
          const totalCredit = journalLines.filter(line => line.netAmount > 0).reduce((sum, line) => sum + line.netAmount, 0);
          console.log(`For ${date}: Total Debits ${totalDebit}, Total Credits ${totalCredit}`);
          if (Math.abs(totalDebit - totalCredit) > 0.01) { // Allow for minor rounding differences
            throw new Error(`Journal for ${date} is unbalanced: Debits ${totalDebit}, Credits ${totalCredit}`);
          }

          const journalResponse = await axios.post(`https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/journalEntries`, {
            postedOn: `${date}T00:00:00`, journalLines, modifiedDate: '0001-01-01T00:00:00'
          }, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
          console.log(`Journal API response status: ${journalResponse.status}, URL: https://api.codat.io/companies/${companyId}/connections/${connectionId}/push/journalEntries, Data: ${JSON.stringify(journalResponse.data)}`);
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second initial delay
          let journalOperationStatus = 'Pending';
          let attempt = 0;
          let pushOperationKey = journalResponse.data.pushOperationKey;
          while (journalOperationStatus === 'Pending' && attempt < 10) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
              const operationResponse = await axios.get(`https://api.codat.io/companies/${companyId}/push/${pushOperationKey}`, { headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' } });
              console.log(`Journal operation status response: ${operationResponse.status}, URL: https://api.codat.io/companies/${companyId}/push/${pushOperationKey}, Data: ${JSON.stringify(operationResponse.data)}`);
              journalOperationStatus = operationResponse.data.status;
              if (journalOperationStatus === 'Success') syncedDetails.push({ date, totalAmount: totalDebit, journalEntryId: operationResponse.data.data?.id || pushOperationKey });
            } catch (error) {
              console.error(`Journal operation status error: ${error.message}, URL: https://api.codat.io/companies/${companyId}/push/${pushOperationKey}, Response: ${JSON.stringify(error.response?.data)}`);
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
