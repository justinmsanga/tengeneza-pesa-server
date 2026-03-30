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
const orders = {};

// ── HEALTH CHECK ────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'running', service: 'Tengeneza Pesa — ZenoPay Server', time: new Date().toISOString() });
});

// ── ROUTE 1: ANZISHA MALIPO ──────────────────────
// Frontend inatuma: { phone, amount, name, order_id }
app.post('/pay', async (req, res) => {
  const { phone, amount, name, order_id } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({ success: false, message: 'Nambari ya simu na kiasi vinahitajika.' });
  }

  // Safisha nambari — tumia format ya Tanzania: 07XXXXXXXX
  let mobile = phone.replace(/\D/g, '');
  if (mobile.startsWith('255')) mobile = '0' + mobile.slice(3);
  if (!mobile.startsWith('0'))  mobile = '0' + mobile;

  const externalId = order_id || `TP-${Date.now()}`;

  try {
    const payload = {
      order_id:    externalId,
      buyer_email: 'customer@tengenezapesa.co.tz',
      buyer_name:  name || 'Mteja',
      buyer_phone: mobile,
      amount:      Number(amount),
      webhook_url: `${SERVER_URL}/webhook`,
    };

    console.log(`[PAY] Kutuma STK Push kwa ${mobile} — TZS ${amount}`);
    console.log('[PAY] Payload:', JSON.stringify(payload));

    const response = await axios.post(
      `${BASE_URL}/mobile_money_tanzania`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key':    API_KEY,
        },
        timeout: 30000
      }
    );

    const data = response.data;
    console.log('[PAY] ZenoPay response:', JSON.stringify(data));

    if (data.status === 'success') {
      const returnedOrderId = data.order_id || externalId;
      orders[returnedOrderId] = {
        status:     'PENDING',
        amount,
        mobile,
        name:       name || 'Mteja',
        created_at: new Date().toISOString()
      };
      // Hifadhi pia kwa externalId kama tofauti
      if (returnedOrderId !== externalId) orders[externalId] = orders[returnedOrderId];

      return res.json({
        success:  true,
        order_id: returnedOrderId,
        message:  data.message || 'STK Push imetumwa. Angalia simu yako na ingiza PIN.'
      });
    } else {
      console.error('[PAY] ZenoPay ilikataa:', data);
      return res.status(400).json({
        success: false,
        message: data.message || 'Imeshindwa kutuma STK Push. Jaribu tena.'
      });
    }

  } catch (err) {
    const errData = err.response?.data;
    console.error('[PAY] Kosa:', JSON.stringify(errData) || err.message);
    return res.status(500).json({
      success: false,
      message: errData?.message || 'Tatizo la mtandao. Angalia internet yako na jaribu tena.'
    });
  }
});

// ── ROUTE 2: ANGALIA HALI YA MALIPO ─────────────
app.get('/status/:order_id', async (req, res) => {
  const { order_id } = req.params;

  // Kwanza angalia store — kama webhook ilikuja tayari
  if (orders[order_id]?.status === 'PAID') {
    return res.json({ success: true, paid: true, status: 'PAID' });
  }

  try {
    const response = await axios.get(
      `${BASE_URL}/order-status`,
      {
        params:  { order_id },
        headers: { 'x-api-key': API_KEY },
        timeout: 15000
      }
    );

    const data   = response.data;
    console.log(`[STATUS] ${order_id}:`, JSON.stringify(data));

    // ZenoPay inarudisha data.data array
    const orderData = Array.isArray(data.data) ? data.data[0] : data.data;
    const status    = orderData?.payment_status || data.status || 'PENDING';

    const isPaid = ['COMPLETED', 'PAID', 'SUCCESS', 'SUCCESSFUL'].includes(
      String(status).toUpperCase()
    );

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

  const orderId = data.order_id;
  const status  = data.payment_status || data.status;

  if (orderId) {
    const isPaid = ['COMPLETED', 'PAID', 'SUCCESS', 'SUCCESSFUL'].includes(
      String(status).toUpperCase()
    );
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
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Server URL: ${SERVER_URL}`);
});
