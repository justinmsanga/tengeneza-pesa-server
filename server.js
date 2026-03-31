const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── CREDENTIALS ───────────────────────────────────────────
const ACCOUNT_ID     = process.env.ZENOPAY_ACCOUNT_ID;
const API_KEY        = process.env.ZENOPAY_API_KEY;
const WEBHOOK_SECRET = process.env.ZENOPAY_WEBHOOK_SECRET || '';
const SERVER_URL     = process.env.SERVER_URL || 'https://tengeneza-pesa-server.onrender.com';
const BASE_URL       = 'https://zenoapi.com/api/payments';

if (!ACCOUNT_ID || !API_KEY) {
  console.error('ZENOPAY_ACCOUNT_ID au ZENOPAY_API_KEY hazijasetwa!');
  process.exit(1);
}

// ── JSON FILE STORE ───────────────────────────────────────
// Inabadilisha better-sqlite3 — pure Node.js, hakuna compilation
const DB_FILE = path.join('/tmp', 'orders.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e) { return {}; }
}
function saveDB(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('[DB] Kosa la kuhifadhi:', e.message); }
}

const dbGet = (id) => {
  const db = loadDB();
  return db[id] || null;
};
const dbSet = (o) => {
  const db = loadDB();
  db[o.order_id] = o;
  saveDB(db);
};
const dbPaid = (id) => {
  const db = loadDB();
  if (db[id]) { db[id].status = 'PAID'; saveDB(db); }
};
const dbFindByPhone = (mobile) => {
  const db = loadDB();
  const matches = Object.values(db)
    .filter(o => o.mobile === mobile && o.status === 'PAID')
    .sort((a, b) => b.created_at - a.created_at);
  return matches[0] || null;
};

// ── RATE LIMITING ─────────────────────────────────────────
const rateMap = {};
function checkRate(ip, max=5, windowMs=60000) {
  const now=Date.now(), r=rateMap[ip]||{count:0,start:now};
  if(now-r.start>windowMs){r.count=0;r.start=now;}
  r.count++; rateMap[ip]=r; return r.count>max;
}

// ── VALIDATION ────────────────────────────────────────────
function validAmount(a) { const n=Number(a); return !isNaN(n)&&n>=100&&n<=500000; }
function validPhone(p)  { const d=p.replace(/\D/g,''); return d.length>=9&&d.length<=13; }
function cleanPhone(p)  {
  let d=p.replace(/\D/g,'');
  if(d.startsWith('255')) d='0'+d.slice(3);
  if(!d.startsWith('0'))  d='0'+d;
  return d;
}

// ── 1. HEALTH ─────────────────────────────────────────────
app.get('/', (req,res) => res.json({
  status:'running', service:'Tengeneza Pesa Server', time:new Date().toISOString()
}));

// ── 2. ANZA MALIPO ────────────────────────────────────────
app.post('/create-payment', async (req,res) => {
  const ip = req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown';
  if(checkRate(ip)) return res.status(429).json({success:false, message:'Umejaribu mara nyingi. Subiri dakika moja.'});

  const {phone, amount, name, category} = req.body;
  if(!phone||!validPhone(String(phone)))  return res.status(400).json({success:false, message:'Namba ya simu si sahihi.'});
  if(!amount||!validAmount(amount))       return res.status(400).json({success:false, message:'Kiasi si sahihi.'});

  const mobile  = cleanPhone(String(phone));
  const orderId = `TP-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

  try {
    const payload = {
      order_id:    orderId,
      buyer_email: 'customer@tengenezapesa.co.tz',
      buyer_name:  name||'Mteja',
      buyer_phone: mobile,
      amount:      Number(amount),
      webhook_url: `${SERVER_URL}/webhook`,
    };
    console.log(`[CREATE] ${mobile} | TZS ${amount} | ${orderId}`);

    const response = await axios.post(
      `${BASE_URL}/mobile_money_tanzania`, payload,
      {headers:{'Content-Type':'application/json','x-api-key':API_KEY}, timeout:30000}
    );
    const data = response.data;
    console.log('[CREATE] ZenoPay:', JSON.stringify(data));

    if(data.status==='success') {
      dbSet({
        order_id:   orderId,
        status:     'PENDING',
        amount:     Number(amount),
        mobile,
        name:       name||'Mteja',
        category:   category||'extraIncome',
        created_at: Date.now()
      });
      return res.json({success:true, orderId, message:'STK Push imetumwa.'});
    } else {
      return res.status(400).json({success:false, message:data.message||'Imeshindwa kutuma.'});
    }
  } catch(err) {
    const e = err.response?.data;
    console.error('[CREATE] Kosa:', e||err.message);
    return res.status(500).json({success:false, message:e?.message||'Tatizo la mtandao.'});
  }
});

// ── 3. ANGALIA HALI ───────────────────────────────────────
app.get('/payment-status', async (req,res) => {
  const {orderId} = req.query;
  if(!orderId) return res.status(400).json({success:false, message:'orderId inahitajika.'});

  const order = dbGet(orderId);

  // Angalia DB kwanza
  if(order?.status==='PAID')
    return res.json({success:true, paid:true, status:'PAID', category:order.category});

  try {
    const response = await axios.get(
      `${BASE_URL}/order-status`,
      {params:{order_id:orderId}, headers:{'x-api-key':API_KEY}, timeout:15000}
    );
    const data      = response.data;
    const orderData = Array.isArray(data.data)?data.data[0]:data.data;
    const status    = orderData?.payment_status||data.status||'PENDING';
    const isPaid    = ['COMPLETED','PAID','SUCCESS','SUCCESSFUL'].includes(String(status).toUpperCase());

    console.log(`[STATUS] ${orderId}: ${status}`);
    if(isPaid) dbPaid(orderId);

    return res.json({
      success:  true,
      paid:     isPaid,
      status:   isPaid?'PAID':'PENDING',
      category: order?.category||'extraIncome'
    });
  } catch(err) {
    console.error('[STATUS] Kosa:', err.response?.data||err.message);
    return res.json({success:true, paid:false, status:'PENDING', category:order?.category||'extraIncome'});
  }
});

// ── 4. WEBHOOK ────────────────────────────────────────────
app.post('/webhook', (req,res) => {
  if(WEBHOOK_SECRET) {
    const sig      = req.headers['x-zenopay-signature']||req.headers['x-signature']||'';
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
                           .update(JSON.stringify(req.body)).digest('hex');
    if(sig!==expected) {
      console.warn('[WEBHOOK] Signature batili');
      return res.status(401).json({error:'Signature batili'});
    }
  }

  const data    = req.body;
  const orderId = data.order_id;
  const status  = data.payment_status||data.status;
  console.log('[WEBHOOK]', JSON.stringify(data));

  if(orderId) {
    const isPaid = ['COMPLETED','PAID','SUCCESS','SUCCESSFUL'].includes(String(status).toUpperCase());
    if(isPaid) {
      dbPaid(orderId);
      console.log(`[WEBHOOK] IMELIPWA: ${orderId}`);
    }
  }
  res.status(200).json({received:true});
});

// ── 5. RECOVER ────────────────────────────────────────────
app.get('/recover', (req,res) => {
  const {phone} = req.query;
  if(!phone) return res.status(400).json({success:false, message:'Namba inahitajika.'});

  const mobile = cleanPhone(String(phone));
  const order  = dbFindByPhone(mobile);

  if(order) {
    console.log(`[RECOVER] ${mobile} → ${order.order_id}`);
    return res.json({success:true, found:true, orderId:order.order_id, category:order.category});
  }
  console.log(`[RECOVER] ${mobile} — haijapatikana`);
  return res.json({success:true, found:false});
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT||3000;
app.listen(PORT, () => {
  console.log(`Tengeneza Pesa Server — port ${PORT}`);
  console.log(`Store: JSON file (${DB_FILE})`);
  console.log(`URL: ${SERVER_URL}`);
});
