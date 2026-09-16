const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/)) {
  const t=line.trim(); if(!t||t.startsWith('#')||!t.includes('=')) continue;
  const i=t.indexOf('='); const k=t.slice(0,i).trim(); let v=t.slice(i+1).trim().replace(/^['"]|['"]$/g,''); process.env[k]=v;
}
const token=process.env.TELEGRAM_BOT_TOKEN, base=process.env.PUBLIC_BASE_URL, secret=process.env.TELEGRAM_WEBHOOK_SECRET;
if(!token||!base) throw new Error('Isi TELEGRAM_BOT_TOKEN dan PUBLIC_BASE_URL di .env');
fetch(`https://api.telegram.org/bot${token}/setWebhook`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:`${base.replace(/\/$/,'')}/telegram/webhook`,secret_token:secret||undefined,allowed_updates:['message','edited_message']})}).then(r=>r.json()).then(console.log).catch(console.error);
