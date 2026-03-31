const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

// ── CREDENTIALS ───────────────────────────────────────────
const ACCOUNT_ID      = process.env.ZENOPAY_ACCOUNT_ID;
const API_KEY         = process.env.ZENOPAY_API_KEY;
const WEBHOOK_SECRET  = process.env.ZENOPAY_WEBHOOK_SECRET || '';
const SERVER_URL      = process.env.SERVER_URL || 'https://tengeneza-pesa-server.onrender.com';
const BASE_URL        = 'https://zenoapi.com/api/payments';

if (!ACCOUNT_ID || !API_KEY) {
  console.error('❌ ZENOPAY_ACCOUNT_ID au ZENOPAY_API_KEY hazijasetwa!');
  process.exit(1);
}

// ── SQLite DATABASE ───────────────────────────────────────
const db = new Database('./orders.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    order_id   TEXT PRIMARY KEY,
    status     TEXT DEFAULT 'PENDING',
    amount     INTEGER,
    mobile     TEXT,
    name       TEXT,
    category   TEXT DEFAULT 'extraIncome',
    package    TEXT DEFAULT 'mini',
    created_at INTEGER
  )
`);

// Helper functions
const dbGet = (id)   => db.prepare('SELECT * FROM orders WHERE order_id=?').get(id);
const dbSet = (o)    => db.prepare(
  'INSERT OR REPLACE INTO orders (order_id,status,amount,mobile,name,category,package,created_at) VALUES (?,?,?,?,?,?,?,?)'
).run(o.order_id, o.status, o.amount, o.mobile, o.name, o.category, o.package, o.created_at);
const dbPaid = (id)  => db.prepare("UPDATE orders SET status='PAID' WHERE order_id=?").run(id);
const dbFindByPhone = (mobile) =>
  db.prepare("SELECT * FROM orders WHERE mobile=? AND status='PAID' ORDER BY created_at DESC LIMIT 1").get(mobile);

// ── RATE LIMITING ─────────────────────────────────────────
const rateMap = {};
function checkRate(ip, max=5, windowMs=60000) {
  const now=Date.now(), r=rateMap[ip]||{count:0,start:now};
  if(now-r.start>windowMs){r.count=0;r.start=now;}
  r.count++; rateMap[ip]=r; return r.count>max;
}

// ── VALIDATION ────────────────────────────────────────────
function validAmount(a){const n=Number(a);return !isNaN(n)&&n>=500&&n<=100000;}
function validPhone(p){const d=p.replace(/\D/g,'');return d.length>=9&&d.length<=13;}
function cleanPhone(p){
  let d=p.replace(/\D/g,'');
  if(d.startsWith('255'))d='0'+d.slice(3);
  if(!d.startsWith('0'))d='0'+d;
  return d;
}

// ── 1. HEALTH ─────────────────────────────────────────────
app.get('/', (req,res) => res.json({status:'running',service:'Tengeneza Pesa Server',time:new Date().toISOString()}));
app.get('/health', (req,res) => res.json({ok:true,time:new Date().toISOString()}));

// ── 2. ANZA MALIPO ────────────────────────────────────────
app.post('/create-payment', async (req,res) => {
  const ip = req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown';
  if(checkRate(ip)) return res.status(429).json({success:false,message:'Umejaribu mara nyingi. Subiri dakika moja.'});

  const {phone, amount, name, category, package: pkg} = req.body;
  if(!phone||!validPhone(String(phone))) return res.status(400).json({success:false,message:'Namba ya simu si sahihi.'});
  if(!amount||!validAmount(amount)) return res.status(400).json({success:false,message:'Kiasi si sahihi.'});

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
    const response = await axios.post(`${BASE_URL}/mobile_money_tanzania`, payload,
      {headers:{'Content-Type':'application/json','x-api-key':API_KEY},timeout:30000});
    const data = response.data;
    console.log('[CREATE] ZenoPay:', JSON.stringify(data));

    if(data.status==='success'){
      // Hifadhi kwenye SQLite — inabaki hata server ikianzishwa upya
      dbSet({order_id:orderId, status:'PENDING', amount:Number(amount),
        mobile, name:name||'Mteja', category:category||'extraIncome',
        package:pkg||'mini', created_at:Date.now()});
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
  if(!orderId) return res.status(400).json({success:false,message:'orderId inahitajika.'});

  const order = dbGet(orderId);

  // Angalia DB kwanza
  if(order?.status==='PAID')
    return res.json({success:true,paid:true,status:'PAID',category:order.category});

  // Expired baada ya dakika 10
  if(order && Date.now()-order.created_at > 600000)
    return res.json({success:true,paid:false,status:'EXPIRED'});

  try {
    const response = await axios.get(`${BASE_URL}/order-status`,
      {params:{order_id:orderId}, headers:{'x-api-key':API_KEY}, timeout:15000});
    const data      = response.data;
    const orderData = Array.isArray(data.data)?data.data[0]:data.data;
    const status    = orderData?.payment_status||data.status||'PENDING';
    const isPaid    = ['COMPLETED','PAID','SUCCESS','SUCCESSFUL'].includes(String(status).toUpperCase());
    console.log(`[STATUS] ${orderId}: ${status}`);
    if(isPaid) dbPaid(orderId);
    return res.json({success:true, paid:isPaid, status:isPaid?'PAID':'PENDING',
      category:order?.category||'extraIncome'});
  } catch(err) {
    console.error('[STATUS] Kosa:', err.response?.data||err.message);
    return res.json({success:true, paid:false, status:'PENDING'});
  }
});

// ── 4. WEBHOOK ────────────────────────────────────────────
app.post('/webhook', (req,res) => {
  // Signature verification — ikiwa ZenoPay inatoa signature
  if(WEBHOOK_SECRET) {
    const sig      = req.headers['x-zenopay-signature'] || req.headers['x-signature'] || '';
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
                           .update(JSON.stringify(req.body))
                           .digest('hex');
    if(sig !== expected) {
      console.warn('[WEBHOOK] ⚠️ Signature batili — imekataliwa');
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
      console.log(`[WEBHOOK] ✅ IMELIPWA: ${orderId}`);
    }
  }
  res.status(200).json({received:true});
});

// ── 5. RECOVER ────────────────────────────────────────────
app.get('/recover', (req,res) => {
  const {phone} = req.query;
  if(!phone) return res.status(400).json({success:false,message:'Namba inahitajika.'});
  const mobile = cleanPhone(String(phone));
  const order  = dbFindByPhone(mobile);
  if(order) {
    console.log(`[RECOVER] ✅ ${mobile} → ${order.order_id}`);
    return res.json({success:true, found:true, orderId:order.order_id, category:order.category});
  }
  console.log(`[RECOVER] ❌ ${mobile} — haijapatikana`);
  return res.json({success:true, found:false});
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT||3000;
app.listen(PORT, () => {
  console.log(`✅ Tengeneza Pesa Server — port ${PORT}`);
  console.log(`📦 Database: SQLite (orders.db)`);
  console.log(`🔐 Webhook signature: ${WEBHOOK_SECRET?'IMEWASHWA':'IMEZIMWA (weka ZENOPAY_WEBHOOK_SECRET)'}`);
});
