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
         if (!codatApiKey) {
           return res.status(500).json({ error: 'Codat API key not configured' });
         }

         // Create a Codat company
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

         // Generate QuickBooks OAuth link
         const authResponse = await axios.post(
           `https://api.codat.io/companies/${companyId}/connections`,
           {
             platformKey: 'qbo'
           },
           {
             headers: {
               'Authorization': `Basic ${codatApiKey}`,
               'Content-Type': 'application/json'
             }
           }
         );
         const authUrl = authResponse.data.data.authUri;

         res.json({ authUrl });
       } catch (error) {
         console.error('Codat API error:', error.response?.data || error.message);
         res.status(500).json({ error: 'Failed to generate auth link: ' + (error.response?.data?.error || error.message) });
       }
     });

     app.post('/api/sync', async (req, res) => {
       res.json({ error: 'Not implemented' });
     });

     module.exports = app;
     
