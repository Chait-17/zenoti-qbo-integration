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
         const centers = response.data.centers || response.data; // Adjust based on Zenoti response structure
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
       // Implement Codat auth link logic
       res.json({ error: 'Not implemented' });
     });

     app.post('/api/sync', async (req, res) => {
       // Implement sync logic
       res.json({ error: 'Not implemented' });
     });

     module.exports = app;
