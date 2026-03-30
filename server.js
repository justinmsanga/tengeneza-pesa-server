const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();

app.use(cors());
app.use(express.json());

// ── CONFIG ─────────────────────────────────────────
const ZENOPAY_ACCOUNT_ID  = process.env.ZENOPAY_ACCOUNT_ID  || 'WEKA_HAPA';
const ZENOPAY_API_KEY     = process.env.ZENOPAY_API_KEY     || 'WEKA_HAPA';
const ZENOPAY_API_URL     = 'https://api.zenopay.net/api/v1';
const DRIVE_FOLDER        = 'https://drive.google.com/drive/folders/117yvGXV_j3wHZpdc_6caktAnTQmCysIx?usp=sharing';
const WA_NUM              = '255694953087';

// Hifadhi orders zilizolipwa (kwa production tumia database)
const paidOrders = new Set();

// ── 1. STK PUSH ─────────────────────────────────────
// Funnel inaitumia kupeleka namba ya simu na amount
app.post('/pay', async (req, res) => {
  try {
    const { phone, amount, name, order_id } = req.body;

    // Validate
    if (!phone || !amount) {
      return res.status(400).json({ success: false, message: 'Namba ya simu na amount vinahitajika' });
    }

    // Clean phone number - ensure format 255XXXXXXXXX
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '255' + cleanPhone.slice(1);
    if (!cleanPhone.startsWith('255')) cleanPhone = '255' + cleanPhone;

    // Generate order ID
    const orderId = order_id || `TP-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

    console.log(`📱 STK Push: ${cleanPhone} | TZS ${amount} | Order: ${orderId}`);

    // Send STK Push to ZenoPay
    const response = await axios.post(`${ZENOPAY_API_URL}/order/create`, {
      account_id:  ZENOPAY_ACCOUNT_ID,
      amount:      parseInt(amount),
      msisdn:      cleanPhone,
      reference:   orderId,
      webhook_url: `${process.env.SERVER_URL || 'https://your-app.onrender.com'}/webhook`,
      metadata: JSON.stringify({ name: name || 'Mteja', order_id: orderId })
    }, {
      headers: {
        'x-api-key':    ZENOPAY_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ ZenoPay Response:', response.data);

    res.json({
      success:  true,
      order_id: orderId,
      message:  'Simu yako italia sasa hivi — ingiza PIN yako kukamilisha malipo',
      data:     response.data
    });

  } catch (error) {
    console.error('❌ STK Push Error:', error?.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'Tatizo la malipo — jaribu tena au wasiliana nasi',
      error:   error?.response?.data || error.message
    });
  }
});

// ── 2. CHECK STATUS ──────────────────────────────────
// Funnel inauliza kila sekunde 3 kama malipo yamekamilika
app.get('/status/:order_id', async (req, res) => {
  const { order_id } = req.params;

  // Check local paid orders first
  if (paidOrders.has(order_id)) {
    return res.json({
      success:      true,
      paid:         true,
      download_url: DRIVE_FOLDER,
      message:      'Malipo yamekamilika! Pakua bundle yako sasa.'
    });
  }

  try {
    // Check with ZenoPay
    const response = await axios.get(`${ZENOPAY_API_URL}/order/status/${order_id}`, {
      headers: { 'x-api-key': ZENOPAY_API_KEY }
    });

    const data = response.data;
    const isPaid = data?.status === 'COMPLETED' || data?.status === 'SUCCESS';

    if (isPaid) {
      paidOrders.add(order_id);
      console.log(`✅ Paid: ${order_id}`);
    }

    res.json({
      success:      true,
      paid:         isPaid,
      status:       data?.status,
      download_url: isPaid ? DRIVE_FOLDER : null,
      message:      isPaid ? 'Malipo yamekamilika!' : 'Inasubiri malipo...'
    });

  } catch (error) {
    console.error('❌ Status Error:', error?.response?.data || error.message);
    res.json({ success: false, paid: false, message: 'Inasubiri...' });
  }
});

// ── 3. WEBHOOK ───────────────────────────────────────
// ZenoPay inatuma hapa ukimalipa
app.post('/webhook', (req, res) => {
  try {
    const data = req.body;
    console.log('🔔 Webhook received:', JSON.stringify(data));

    const orderId = data?.reference || data?.order_id || data?.metadata?.order_id;
    const status  = data?.status;

    if (orderId && (status === 'COMPLETED' || status === 'SUCCESS' || status === 'successful')) {
      paidOrders.add(orderId);
      console.log(`✅ Webhook confirmed payment: ${orderId}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Webhook Error:', error.message);
    res.status(200).json({ received: true });
  }
});

// ── 4. HEALTH CHECK ──────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'running',
    service: 'Tengeneza Pesa — ZenoPay Server',
    time:    new Date().toISOString()
  });
});

// ── START ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server inaendesha kwenye port ${PORT}`);
  console.log(`📡 Account ID: ${ZENOPAY_ACCOUNT_ID}`);
});
