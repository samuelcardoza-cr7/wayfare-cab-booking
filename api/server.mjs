import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { verifyToken } from '@clerk/backend';
import { createClient } from '@supabase/supabase-js';

const required = [
  'APP_ORIGIN', 'CLERK_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'
];
const missing = required.filter(key => !process.env[key]);
if (missing.length) throw new Error(`Missing server environment settings: ${missing.join(', ')}`);

const app = express();
const database = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const appOrigin = new URL(process.env.APP_ORIGIN).origin;
const currency = (process.env.RAZORPAY_CURRENCY || 'INR').toUpperCase();
const razorpayAuth = `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;

app.use(cors({ origin: appOrigin }));

function signHmac(value, secret) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function signaturesMatch(received, expected) {
  if (typeof received !== 'string' || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const actual = Buffer.from(received, 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function razorpayRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: razorpayAuth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`Razorpay API request failed with status ${response.status}.`);
    throw new Error('Razorpay could not complete the request.');
  }
  return data;
}

// Razorpay signs the exact raw request body, so this route must be registered before express.json().
app.post('/api/razorpay/webhook', express.raw({ type: 'application/json' }), async (request, response) => {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return response.status(503).json({ error: 'Webhook verification is not configured.' });
  if (!Buffer.isBuffer(request.body)) return response.status(400).json({ error: 'Webhook body is invalid.' });
  const signature = request.headers['x-razorpay-signature'];
  const expected = signHmac(request.body, process.env.RAZORPAY_WEBHOOK_SECRET);
  if (!signaturesMatch(signature, expected)) return response.status(400).json({ error: 'Webhook signature is invalid.' });

  let event;
  try { event = JSON.parse(request.body.toString('utf8')); }
  catch { return response.status(400).json({ error: 'Webhook body is invalid.' }); }

  const payment = event.payload?.payment?.entity;
  const order = event.payload?.order?.entity;
  let orderId = payment?.order_id || order?.id;
  let paymentId = payment?.id || null;
  let status;
  if (event.event === 'payment.captured' || event.event === 'order.paid') status = 'paid';
  else if (event.event === 'payment.failed') status = 'failed';
  else return response.json({ received: true });
  if (!orderId) return response.status(400).json({ error: 'Webhook has no order identifier.' });

  const patch = { status, ...(paymentId ? { razorpay_payment_id: paymentId } : {}) };
  let query = database.from('payments').update(patch).eq('razorpay_order_id', orderId);
  if (status === 'failed') query = query.neq('status', 'paid');
  const { error } = await query;
  if (error) return response.status(500).json({ error: 'Could not save payment status.' });
  return response.json({ received: true });
});

app.use(express.json({ limit: '20kb' }));
app.get('/api/health', (_request, response) => response.json({ ok: true }));

async function requireRider(request, response, next) {
  try {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return response.status(401).json({ error: 'Sign in is required.' });
    const claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    request.riderId = claims.sub;
    return next();
  } catch { return response.status(401).json({ error: 'Your sign-in session is invalid or expired.' }); }
}

app.post('/api/payments/checkout', requireRider, async (request, response) => {
  const rideId = request.body?.rideId;
  if (typeof rideId !== 'string') return response.status(400).json({ error: 'A ride ID is required.' });

  const { data: ride, error: rideError } = await database.from('rides')
    .select('id,rider_id,destination,ride_type,fare_estimate,payment_method,status')
    .eq('id', rideId).eq('rider_id', request.riderId).single();
  if (rideError || !ride) return response.status(404).json({ error: 'Ride not found.' });
  if (ride.status !== 'completed') return response.status(409).json({ error: 'Payment is available after the ride is completed.' });
  if (ride.payment_method !== 'Razorpay Checkout') return response.status(409).json({ error: 'This ride was not booked for online payment.' });

  const amount = Math.round(Number(ride.fare_estimate) * 100);
  if (!Number.isSafeInteger(amount) || amount < 100) return response.status(400).json({ error: 'The fare must be at least ₹1 to pay online.' });

  const { data: previousPayment } = await database.from('payments')
    .select('status,razorpay_order_id').eq('ride_id', ride.id).maybeSingle();
  if (previousPayment?.status === 'paid') return response.status(409).json({ error: 'This ride has already been paid.' });
  if (previousPayment?.status === 'pending' && previousPayment.razorpay_order_id) {
    return response.json({
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: previousPayment.razorpay_order_id,
      amount,
      currency,
      name: 'wayfare',
      description: `${ride.ride_type} ride`
    });
  }

  try {
    const order = await razorpayRequest('/orders', {
      method: 'POST',
      body: {
        amount,
        currency,
        receipt: ride.id,
        notes: { ride_id: ride.id, rider_id: ride.rider_id }
      }
    });
    if (!order.id || order.amount !== amount || order.currency !== currency) {
      return response.status(502).json({ error: 'Razorpay returned an invalid order.' });
    }

    const { error: paymentError } = await database.from('payments').upsert({
      ride_id: ride.id,
      rider_id: ride.rider_id,
      razorpay_order_id: order.id,
      razorpay_payment_id: null,
      amount: ride.fare_estimate,
      currency: currency.toLowerCase(),
      status: 'pending'
    }, { onConflict: 'ride_id' });
    if (paymentError) return response.status(500).json({ error: 'Could not record payment order.' });

    return response.json({
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      name: 'wayfare',
      description: `${ride.ride_type} ride`
    });
  } catch {
    return response.status(502).json({ error: 'Razorpay checkout could not start. Check the server payment settings.' });
  }
});

app.post('/api/payments/verify', requireRider, async (request, response) => {
  const { rideId, razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = request.body || {};
  if (![rideId, orderId, paymentId, signature].every(value => typeof value === 'string' && value.length <= 300)) {
    return response.status(400).json({ error: 'Payment verification details are incomplete.' });
  }

  const expected = signHmac(`${orderId}|${paymentId}`, process.env.RAZORPAY_KEY_SECRET);
  if (!signaturesMatch(signature, expected)) return response.status(400).json({ error: 'Razorpay payment signature is invalid.' });

  const { data: record, error: recordError } = await database.from('payments')
    .select('ride_id,rider_id,razorpay_order_id,amount,currency,status')
    .eq('ride_id', rideId).eq('rider_id', request.riderId).eq('razorpay_order_id', orderId).single();
  if (recordError || !record) return response.status(404).json({ error: 'Payment order not found for this rider.' });
  if (record.status === 'paid') return response.json({ status: 'paid' });

  try {
    const payment = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`);
    const expectedAmount = Math.round(Number(record.amount) * 100);
    if (payment.order_id !== orderId || payment.amount !== expectedAmount || payment.currency !== record.currency.toUpperCase()) {
      return response.status(400).json({ error: 'Payment details do not match this ride.' });
    }

    const status = payment.status === 'captured' ? 'paid' : payment.status === 'failed' ? 'failed' : 'pending';
    const { error: updateError } = await database.from('payments').update({ razorpay_payment_id: paymentId, status })
      .eq('ride_id', rideId).eq('rider_id', request.riderId).eq('razorpay_order_id', orderId);
    if (updateError) return response.status(500).json({ error: 'Could not save verified payment.' });
    return response.json({ status });
  } catch {
    return response.status(502).json({ error: 'Could not confirm the payment with Razorpay yet.' });
  }
});

const port = Number(process.env.PORT || 4242);
app.listen(port, () => console.log(`Wayfare API listening on port ${port}`));
