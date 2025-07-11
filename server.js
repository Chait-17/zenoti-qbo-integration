const express = require('express');
const app = express();
const fetch = require('node-fetch');

app.use(express.json());

let currentPageData = { pageNumber: 1, pageSize: 100, totalResults: 0, nextPageUrl: '/companies' };

app.get('/api/companies', async (req, res) => {
  try {
    const response = await fetch(currentPageData.nextPageUrl);
    if (!response.ok) throw new Error('API request failed');
    const data = await response.json();
    currentPageData = {
      pageNumber: data.pageNumber,
      pageSize: data.pageSize,
      totalResults: data.totalResults,
      nextPageUrl: data._links.next?.href || null
    };
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
