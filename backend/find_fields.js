const https = require('https');

const SF = process.env.SF_INSTANCE_URL;
const CID = process.env.SF_CLIENT_ID;
const CS = process.env.SF_CLIENT_SECRET;

function requireEnv() {
  const missing = [];
  if (!SF) missing.push('SF_INSTANCE_URL');
  if (!CID) missing.push('SF_CLIENT_ID');
  if (!CS) missing.push('SF_CLIENT_SECRET');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}. Configure trusted certificates with NODE_EXTRA_CA_CERTS if your network requires a custom CA.`);
  }
}

function sfFetch(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(SF + path, {
      headers: { 'Authorization': 'Bearer ' + token }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sfPost(path, body) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams(body).toString();
    const req = https.request(SF + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

async function go() {
  requireEnv();
  console.log('Getting token...');
  const auth = await sfPost('/services/oauth2/token', {
    grant_type: 'client_credentials',
    client_id: CID,
    client_secret: CS
  });
  console.log('Token OK');
  const tk = auth.access_token;

  console.log('Describing Case...');
  const desc = await sfFetch('/services/data/v60.0/sobjects/Case/describe', tk);
  
  if (desc.message) {
    console.log('Error:', desc.message, desc.errorCode);
    return;
  }

  const fields = desc.fields || [];
  console.log('Total fields:', fields.length);

  for (const f of fields) {
    const n = f.name || '';
    const l = f.label || '';
    if (f.type === 'picklist' && (n.endsWith('__c') || ['Status', 'Origin', 'Priority'].includes(n))) {
      const vals = (f.picklistValues || []).filter(v => v.active);
      console.log('\n=== ' + n + ' | ' + l + ' ===');
      vals.forEach(v => console.log('  ' + v.label + ' => ' + v.value));
    }
  }
}

go().catch(e => console.error(e.message));
