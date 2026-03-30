const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ── CREDENTIALS ─────────────────────────────────
const ACCOUNT_ID = process.env.ZENOPAY_ACCOUNT_ID || 'zp72197485';
const API_KEY    = process.env.ZENOPAY_API_KEY    || 'VEuTf8hvrFSNrcNWg-vuaMpRHIIlYy3zfeqjIZVeslVuyrjzm3yZRf8kr38NElJolunNH2yDCm_N24HA3ebeew';
const SERVER_URL = process.env.SERVER_URL         || 'https://tengeneza-pesa-server.onrender.com';
const BASE_URL   = 'https://zenoapi.com/api/payments';

// ── IN-MEMORY STORE ──────────────────────────────
// { orderId: { status, amount, mobile, name, category, created_at } }
const orders = {};

// ── HEALTH CHECK ────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'running', service: 'Tengeneza Pesa Server', time: new Date().toISOString() });
});

// ── ROUTE 1: ANZA MALIPO ─────────────────────────
// POST /create-payment  { phone, amount, name, category }
app.post('/create-payment', async (req, res) => {
  const { phone, amount, name, category } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({ success: false, message: 'Nambari ya simu na kiasi vinahitajika.' });
  }

  let mobile = phone.replace(/\D/g, '');
  if (mobile.startsWith('255')) mobile = '0' + mobile.slice(3);
  if (!mobile.startsWith('0'))  mobile = '0' + mobile;

  const orderId = `TP-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

  try {
    const payload = {
      order_id:    orderId,
      buyer_email: 'customer@tengenezapesa.co.tz',
      buyer_name:  name || 'Mteja',
      buyer_phone: mobile,
      amount:      Number(amount),
      webhook_url: `${SERVER_URL}/webhook`,
    };

    console.log(`[CREATE] ${mobile} | TZS ${amount} | ${orderId}`);

    const response = await axios.post(
      `${BASE_URL}/mobile_money_tanzania`,
      payload,
      { headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY }, timeout: 30000 }
    );

    const data = response.data;
    console.log('[CREATE] ZenoPay:', JSON.stringify(data));

    if (data.status === 'success') {
      orders[orderId] = {
        status:     'PENDING',
        amount:     Number(amount),
        mobile,
        name:       name || 'Mteja',
        category:   category || 'extraIncome',
        created_at: new Date().toISOString()
      };
      return res.json({ success: true, orderId, message: 'STK Push imetumwa.' });
    } else {
      return res.status(400).json({ success: false, message: data.message || 'Imeshindwa kutuma.' });
    }

  } catch (err) {
    const e = err.response?.data;
    console.error('[CREATE] Kosa:', e || err.message);
    return res.status(500).json({ success: false, message: e?.message || 'Tatizo la mtandao.' });
  }
});

// ── ROUTE 2: ANGALIA HALI ────────────────────────
// GET /payment-status?orderId=TP-xxx
app.get('/payment-status', async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ success: false, message: 'orderId inahitajika.' });

  // Kwanza angalia store — webhook inaweza kuwa imefika tayari
  if (orders[orderId]?.status === 'PAID') {
    return res.json({ success: true, paid: true, status: 'PAID', category: orders[orderId].category });
  }

  try {
    const response = await axios.get(
      `${BASE_URL}/order-status`,
      { params: { order_id: orderId }, headers: { 'x-api-key': API_KEY }, timeout: 15000 }
    );

    const data      = response.data;
    const orderData = Array.isArray(data.data) ? data.data[0] : data.data;
    const status    = orderData?.payment_status || data.status || 'PENDING';
    const isPaid    = ['COMPLETED','PAID','SUCCESS','SUCCESSFUL'].includes(String(status).toUpperCase());

    console.log(`[STATUS] ${orderId}: ${status}`);

    if (isPaid && orders[orderId]) orders[orderId].status = 'PAID';

    return res.json({
      success:  true,
      paid:     isPaid,
      status:   isPaid ? 'PAID' : status,
      category: orders[orderId]?.category || 'extraIncome'
    });

  } catch (err) {
    console.error('[STATUS] Kosa:', err.response?.data || err.message);
    return res.json({ success: true, paid: false, status: orders[orderId]?.status || 'PENDING' });
  }
});

// ── ROUTE 3: WEBHOOK ─────────────────────────────
// ZenoPay inatuma hapa baada ya malipo kukamilika
app.post('/webhook', (req, res) => {
  const data    = req.body;
  const orderId = data.order_id;
  const status  = data.payment_status || data.status;

  console.log('[WEBHOOK]', JSON.stringify(data));

  if (orderId) {
    const isPaid = ['COMPLETED','PAID','SUCCESS','SUCCESSFUL'].includes(String(status).toUpperCase());
    if (isPaid) {
      orders[orderId] = { ...(orders[orderId] || {}), status: 'PAID' };
      console.log(`[WEBHOOK] IMELIPWA: ${orderId}`);
    }
  }

  res.status(200).json({ received: true });
});

// ── ROUTE 4: RECOVER ─────────────────────────────
// GET /recover?phone=07XXXXXXXX
// Mteja aliyelipa anatafuta access yake tena
app.get('/recover', (req, res) => {
  let { phone } = req.query;
  if (!phone) return res.status(400).json({ success: false, message: 'Namba inahitajika.' });

  let mobile = phone.replace(/\D/g, '');
  if (mobile.startsWith('255')) mobile = '0' + mobile.slice(3);
  if (!mobile.startsWith('0'))  mobile = '0' + mobile;

  // Tafuta order yoyote iliyolipwa kwa namba hii
  const found = Object.entries(orders).find(
    ([, o]) => o.mobile === mobile && o.status === 'PAID'
  );

  if (found) {
    const [orderId, order] = found;
    console.log(`[RECOVER] Namba ${mobile} — IMEPATIKANA: ${orderId}`);
    return res.json({ success: true, found: true, orderId, category: order.category });
  }

  console.log(`[RECOVER] Namba ${mobile} — HAIJAPATIKANA`);
  return res.json({ success: true, found: false });
});

// ── START ────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tengeneza Pesa Server — port ${PORT}`);
  console.log(`BASE: ${BASE_URL} | URL: ${SERVER_URL}`);
});
