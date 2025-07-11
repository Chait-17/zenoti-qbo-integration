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

         // Find company by name
         const companiesResponse = await axios.get('https://api.codat.io/companies', {
           headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' }
         });
         const company = companiesResponse.data.results.find(c => c.name === companyName);
         if (!company) throw new Error('Company not found');
         const companyId = company.id;

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

           const salesData = salesResponse.data.sales || [];
           const collectionData = collectionResponse.data.collections || [];
           const allTransactions = [...salesData, ...collectionData];

           // Aggregate by day and create journal entries
           const transactionsByDate = {};
           allTransactions.forEach(tx => {
             const date = new Date(tx.date).toISOString().split('T')[0];
             if (!transactionsByDate[date]) transactionsByDate[date] = [];
             transactionsByDate[date].push(tx);
           });

           for (const [date, transactions] of Object.entries(transactionsByDate)) {
             const totalAmount = transactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);
             const journalResponse = await axios.post(
               `https://api.codat.io/companies/${companyId}/data/journals`,
               {
                 journal: {
                   journalLines: transactions.map(tx => ({
                     accountRef: { id: '1' }, // Replace with valid account ID from QBO
                     description: tx.description || 'Zenoti Sync',
                     amount: tx.amount || 0
                   })),
                   date: date
                 }
               },
               {
                 headers: { 'Authorization': `Basic ${codatApiKey}`, 'Content-Type': 'application/json' }
               }
             );
             const journalEntryId = journalResponse.data.data.id;
             syncedDetails.push({ date, totalAmount, journalEntryId });
           }

           currentStart.setDate(chunkEnd.getDate() + 1);
         }

         res.json({ syncedDetails });
       } catch (error) {
         const errorMessage = error.response?.data?.error || error.message;
         console.error('Sync error:', error.response?.data || error.message);
         res.status(500).json({ error: `Sync failed: ${errorMessage}` });
       }
     });

     module.exports = app;
