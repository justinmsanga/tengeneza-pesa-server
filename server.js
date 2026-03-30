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

// ── IN-MEMORY STORE ──────────────────────────────
const orders = {};

// ── HEALTH CHECK ────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Tengeneza Pesa Server', time: new Date().toISOString() });
});

// ── ROUTE 1: ANZISHA MALIPO ──────────────────────
app.post('/pay', async (req, res) => {
  const { phone, amount, name, order_id } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({ success: false, message: 'Nambari ya simu na kiasi vinahitajika.' });
  }

  let mobile = phone.replace(/\D/g, '');
  if (mobile.startsWith('0'))    mobile = '255' + mobile.slice(1);
  if (!mobile.startsWith('255')) mobile = '255' + mobile;

  const externalId = order_id || `TP-${Date.now()}`;

  try {
    const payload = {
      account_id:  ACCOUNT_ID,
      api_key:     API_KEY,
      amount:      String(amount),
      mobile:      mobile,
      external_id: externalId,
      webhook_url: `${SERVER_URL}/webhook`,
    };

    console.log(`[PAY] Kutuma STK Push kwa ${mobile} — TZS ${amount}`);

    const response = await axios.post(
      'https://api.zenopay.co.tz/api/v1/payments/mobile-money',
      payload,
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const data = response.data;
    console.log('[PAY] ZenoPay response:', JSON.stringify(data));

    const returnedOrderId = data.order_id || data.data?.order_id || data.reference || externalId;

    if (data.status === 'success' || data.success || data.order_id || data.data?.order_id) {
      orders[returnedOrderId] = { status: 'PENDING', amount, mobile, name: name || 'Mteja', created_at: new Date().toISOString() };
      if (returnedOrderId !== externalId) orders[externalId] = orders[returnedOrderId];

      return res.json({ success: true, order_id: returnedOrderId, message: 'STK Push imetumwa. Angalia simu yako na ingiza PIN.' });
    } else {
      console.error('[PAY] ZenoPay ilikataa:', data);
      return res.status(400).json({ success: false, message: data.message || data.error || 'Imeshindwa kutuma STK Push. Jaribu tena.' });
    }

  } catch (err) {
    const errData = err.response?.data;
    console.error('[PAY] Kosa:', errData || err.message);
    return res.status(500).json({ success: false, message: errData?.message || 'Tatizo la mtandao. Angalia internet yako na jaribu tena.' });
  }
});

// ── ROUTE 2: ANGALIA HALI YA MALIPO ─────────────
app.get('/status/:order_id', async (req, res) => {
  const { order_id } = req.params;

  if (orders[order_id]?.status === 'PAID') {
    return res.json({ success: true, paid: true, status: 'PAID' });
  }

  try {
    const response = await axios.get(
      `https://api.zenopay.co.tz/api/v1/payments/${order_id}`,
      { params: { account_id: ACCOUNT_ID, api_key: API_KEY }, timeout: 15000 }
    );

    const data   = response.data;
    const status = data.status || data.data?.status || data.payment_status || 'PENDING';
    console.log(`[STATUS] ${order_id}: ${status}`);

    const isPaid = ['PAID', 'COMPLETED', 'SUCCESS', 'SUCCESSFUL'].includes(String(status).toUpperCase());

    if (isPaid) {
      if (orders[order_id]) orders[order_id].status = 'PAID';
      return res.json({ success: true, paid: true, status: 'PAID' });
    }

    return res.json({ success: true, paid: false, status });

  } catch (err) {
    console.error('[STATUS] Kosa:', err.response?.data || err.message);
    const localStatus = orders[order_id]?.status || 'PENDING';
    return res.json({ success: true, paid: localStatus === 'PAID', status: localStatus });
  }
});

// ── ROUTE 3: WEBHOOK ─────────────────────────────
app.post('/webhook', (req, res) => {
  const data = req.body;
  console.log('[WEBHOOK] Received:', JSON.stringify(data));

  const orderId = data.order_id || data.external_id || data.reference;
  const status  = data.status   || data.payment_status;

  if (orderId) {
    const isPaid = ['PAID', 'COMPLETED', 'SUCCESS', 'SUCCESSFUL'].includes(String(status).toUpperCase());
    if (isPaid) {
      orders[orderId] = { ...(orders[orderId] || {}), status: 'PAID' };
      console.log(`[WEBHOOK] Order ${orderId} — IMELIPWA!`);
    }
  }

  res.status(200).json({ received: true });
});

// ── START ────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tengeneza Pesa Server — port ${PORT}`);
  console.log(`Account ID: ${ACCOUNT_ID}`);
  console.log(`Server URL: ${SERVER_URL}`);
});
