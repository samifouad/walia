import crypto from 'crypto';
import { Client } from '@libsql/client';

// Initialize the database client
const client = new Client({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Function to verify the webhook signature
async function verifySignature(req) {
  const payload = await req.text(); // Get raw body text to hash
  const signature = crypto
    .createHmac('sha1', process.env.WEBHOOK_SECRET) // Use the secret from env variables
    .update(payload)
    .digest('hex');
  
  return signature === req.headers['x-vercel-signature']; // Compare with the signature from headers
}

export default async function handler(req, res) {
  const { PSI_API_KEY, SECURE_KEY } = process.env;
  const { key, url } = req.query; // query parameters
  const strategy = 'mobile';

  // Check if the request is from a cron job or a webhook
  const isCronJob = req.headers['x-vercel-deployment-id'] === undefined; // Adjust based on your actual check

  // For webhook, verify the signature
  if (!isCronJob) {
    const isVerified = await verifySignature(req);
    if (!isVerified) {
      return res.status(403).json({ error: 'Invalid webhook signature' });
    }

    // Extract deployment information from payload
    const payload = req.body;
    const { deployment } = payload;
    
    if (!deployment || !deployment.id || !url) {
      return res.status(400).json({ error: 'Deployment ID or URL is missing' });
    }

    var deploymentId = deployment.id;

    // Validate the provided secure key
    if (key !== SECURE_KEY) {
      return res.status(403).json({ error: 'Unauthorized access' });
    }

  } else {
    // For cron job, set live flag and leave deployment ID blank
    deploymentId = '';
  }

  const categories = ['PERFORMANCE', 'BEST_PRACTICES', 'ACCESSIBILITY', 'SEO'];

  // Function to fetch data for a specific category and extract the score
  const fetchCategoryData = async (category) => {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${url}&key=${PSI_API_KEY}&strategy=${strategy}&category=${category}`;
    const response = await fetch(apiUrl);

    if (!response.ok) {
      throw new Error(`API call for ${category} failed with status ${response.status}`);
    }

    const data = await response.json();

    // Extract the score based on the category
    const scores = {
      PERFORMANCE: data.lighthouseResult.categories.performance?.score * 100,
      BEST_PRACTICES: data.lighthouseResult.categories['best-practices']?.score * 100,
      ACCESSIBILITY: data.lighthouseResult.categories.accessibility?.score * 100,
      SEO: data.lighthouseResult.categories.seo?.score * 100
    };

    // Return the score for the requested category
    return scores[category];
  };

  try {
    // Trigger fetch requests for all categories concurrently using Promise.all
    const results = await Promise.all(categories.map(fetchCategoryData));

    // Prepare data to insert into the database
    const data = {
      url: url,
      deploymentId: deploymentId,
      live: isCronJob, // Set "live" to true for cron jobs
      PERFORMANCE: results[0],
      BEST_PRACTICES: results[1],
      ACCESSIBILITY: results[2],
      SEO: results[3],
    };

    // Insert the data into the database
    await client.execute(`
      INSERT INTO your_table_name (url, deployment_id, live, performance, best_practices, accessibility, seo)
      VALUES (:url, :deploymentId, :live, :performance, :bestPractices, :accessibility, :seo)
    `, data);

    // Return a success response
    res.status(200).json(data);
  } catch (error) {
    // Handle errors
    console.error('Error fetching PageSpeed Insights data or saving to database:', error);
    res.status(500).json({ error: 'Failed to fetch PageSpeed Insights data or save to database' });
  }
}
