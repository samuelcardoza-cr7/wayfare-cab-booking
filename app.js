import { initializeIntegrations, configured, currentUser, toggleAuthentication, openAccountManagement, suggestPlaces, selectPlace, routeBetween, createRide, validatePromoCode, saveReview, getRideHistory, cancelRide, finishRide, subscribeToRide, getRideLocation, getDriverQueue, acceptRide, declineRide, getAssignedRides, getDriverStats, updateDriverRide, createSupportTicket, watchDriverLocation, updateDriverMarker, sendSos, subscribeToSos, makePaymentSession, verifyRazorpayPayment } from './integrations.js?v=razorpay-checkout-20261111';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const storageKey = 'wayfare-v2';
const defaultState = { rides: [], activeRide: null, promo: '', promoDiscount: 0, payment: 'Cash', schedule: 'Ride now', name: 'Rider', email: '', phone: '', stops: [] };
let state;
try { state = { ...defaultState, ...JSON.parse(localStorage.getItem(storageKey) || '{}') }; } catch { state = structuredClone(defaultState); }
const normalizePaymentPreference = method => ['Card (Stripe)', 'Stripe Checkout'].includes(method) ? 'Razorpay Checkout' : method;
const normalizeStoredPayment = method => method === 'Card (Stripe)' ? 'Stripe Checkout' : method;
state.payment = normalizePaymentPreference(state.payment);
if (state.activeRide) state.activeRide.payment = normalizeStoredPayment(state.activeRide.payment);
state.rides = (state.rides || []).map(ride => ({ ...ride, paymentMethod: normalizeStoredPayment(ride.paymentMethod) }));
let selectedRide = 'Wayfare Go';
let toastTimer;
let lastFocus;
let pickupPlace = null;
let destinationPlace = null;
let liveRideUnsubscribe = null;
const driverWatchers = new Map();
const driverSosSubscriptions = new Map();

async function openRazorpayCheckout(rideId) {
  const order = await makePaymentSession(rideId);
  if (typeof window.Razorpay !== 'function') throw new Error('Razorpay Checkout did not load. Refresh the page and try again.');
  const checkout = new window.Razorpay({
    key: order.keyId,
    amount: order.amount,
    currency: order.currency,
    name: order.name || 'wayfare',
    description: order.description || 'Completed ride',
    order_id: order.orderId,
    handler: async payment => {
      try {
        const result = await verifyRazorpayPayment(rideId, payment);
        toast(result.status === 'paid' ? 'Payment confirmed. Your ride payment is recorded.' : 'Payment received by Razorpay; confirmation is still processing.');
        if (state.activeRide?.id === rideId) state.activeRide.paymentStatus = result.status;
        state.rides = state.rides.map(ride => ride.id === rideId ? { ...ride, paymentStatus: result.status } : ride);
        save();
        if (state.activeRide?.id === rideId) showActiveRide();
        else showTripList();
      } catch (error) { toast(error.message); }
    },
    modal: { ondismiss: () => toast('Checkout closed. You can try payment again from this ride.') },
    theme: { color: '#77b900' }
  });
  checkout.on('payment.failed', event => toast(event.error?.description || 'Razorpay could not complete the payment. Please try again.'));
  checkout.open();
}

async function syncAuth(user) {
  const button = $('#authButton');
  button.textContent = user ? 'Sign out' : 'Sign in / sign up';
  let driverButton = $('#driverDashboardButton');
  if (user?.publicMetadata?.role === 'driver') {
    if (!driverButton) { driverButton = document.createElement('button'); driverButton.id = 'driverDashboardButton'; driverButton.className = 'help-button'; driverButton.textContent = 'Driver dashboard'; $('.top-actions').prepend(driverButton); }
    driverButton.onclick = showDriverDashboard;
  } else driverButton?.remove();
  $('#authButton').setAttribute('aria-label', user ? `Signed in as ${user.fullName || user.primaryEmailAddress?.emailAddress || 'rider'}. Sign out` : 'Sign in');
  if (user) {
    state.name = user.fullName || user.firstName || user.primaryEmailAddress?.emailAddress || state.name;
    $('.account-copy strong').textContent = state.name;
    $('.top-avatar').textContent = state.name.slice(0, 1).toUpperCase();
    $('.breadcrumb span:first-child').textContent = `Hello, ${state.name}`;
    try { const rides = await getRideHistory(); if (rides) { state.rides = rides.map(row => { const review = Array.isArray(row.ride_reviews) ? row.ride_reviews[0] : row.ride_reviews; const payment = Array.isArray(row.payments) ? row.payments[0] : row.payments; return { id: row.id, pickup: row.pickup, destination: row.destination, ride: row.ride_type, fare: row.fare_estimate, date: new Date(row.created_at).toLocaleString(), requestedAt: row.created_at, status: row.status, rating: review?.rating, review: review?.review, paymentStatus: payment?.status || 'unpaid', paymentMethod: row.payment_method, live: true }; }); if (state.activeRide?.id) state.activeRide.paymentStatus = state.rides.find(ride => ride.id === state.activeRide.id)?.paymentStatus; renderRecentTrips(); } } catch (error) { toast(`Could not load ride history: ${error.message}`); }
  } else { state.rides = []; state.activeRide = null; state.name = 'Rider'; state.email = ''; state.phone = ''; save(); renderRecentTrips(); $('.account-copy strong').textContent = 'Rider'; $('.top-avatar').textContent = 'R'; $('.breadcrumb span:first-child').textContent = 'Hello, Rider'; }
}

async function showDriverDashboard() {
  const realDriver = currentUser()?.publicMetadata?.role === 'driver';
  if (!realDriver && configured.auth) return toast('This account does not have driver access.');
  if (!realDriver) return showDemoDriverDashboard();
  openModal('<span class="step-label">WAYFARE DRIVER</span><h2>Driver dashboard</h2><p>Ride requests and your active trips.</p><div class="driver-summary" id="driverSummary">Loading your stats…</div><div id="driverQueue" class="trip-list-view">Loading rides…</div>');
  const render = async () => {
    const [requests, active, stats] = await Promise.all([getDriverQueue(), getAssignedRides(), getDriverStats()]);
    $('#driverSummary').innerHTML = `<div><small>COMPLETED TRIPS</small><strong>${stats.trips}</strong></div><div><small>FARE TOTAL</small><strong>${formatMoney(stats.fareTotal)}</strong></div><div><small>RIDER RATING</small><strong>${stats.averageRating == null ? '—' : `${stats.averageRating.toFixed(1)} ★`}</strong></div>`;
    const items = [
      ...requests.map(ride => `<article class="trip-row"><span class="trip-icon">＋</span><span class="trip-route"><strong>${escapeHTML(ride.pickup)} → ${escapeHTML(ride.destination)}</strong><small>${stopRouteText(ride) ? `Via ${escapeHTML(stopRouteText(ride))} · ` : ''}${escapeHTML(ride.ride_type)} · ${formatMoney(ride.fare_estimate)} · Request</small></span><button class="driver-accept" data-accept="${ride.id}">Accept</button><button class="driver-decline" data-decline="${ride.id}">Decline</button></article>`),
      ...active.map(ride => { const next = { accepted: ['driver_arriving'], driver_arriving: ['in_progress'], in_progress: ['completed'] }[ride.status] || []; const labels = { driver_arriving: 'Driver arriving', in_progress: 'Start ride', completed: 'Complete ride' }; return `<article class="trip-row"><span class="trip-icon">↗</span><span class="trip-route"><strong>${escapeHTML(ride.pickup)} → ${escapeHTML(ride.destination)}</strong><small>${stopRouteText(ride) ? `Via ${escapeHTML(stopRouteText(ride))} · ` : ''}${escapeHTML(ride.ride_type)} · ${formatMoney(ride.fare_estimate)} · ${escapeHTML(ride.status)}</small></span><button class="driver-track" data-track="${ride.id}">${driverWatchers.has(ride.id) ? 'Stop GPS' : 'Share GPS'}</button><select class="driver-status" data-ride="${ride.id}" aria-label="Update ride status"><option value="">Update status</option>${next.map(status => `<option value="${status}">${labels[status]}</option>`).join('')}</select></article>`; })
    ];
    $('#driverQueue').innerHTML = items.join('') || '<p>No open requests or active trips.</p>';
    $$('#driverQueue [data-accept]').forEach(button => button.onclick = async () => { try { await acceptRide(button.dataset.accept); toast('Ride accepted.'); await render(); } catch (error) { toast(error.message); } });
    $$('#driverQueue [data-decline]').forEach(button => button.onclick = async () => { try { await declineRide(button.dataset.decline); await render(); } catch (error) { toast(error.message); } });
    $$('#driverQueue [data-track]').forEach(button => button.onclick = () => {
      const id = button.dataset.track;
      if (driverWatchers.has(id)) { navigator.geolocation.clearWatch(driverWatchers.get(id)); driverWatchers.delete(id); toast('GPS sharing stopped.'); button.textContent = 'Share GPS'; return; }
      const watcher = watchDriverLocation(id, error => toast(`GPS update failed: ${error.message}`));
      if (watcher != null) { driverWatchers.set(id, watcher); button.textContent = 'Stop GPS'; toast('Sharing your GPS for this ride.'); }
    });
    active.forEach(ride => { if (!driverSosSubscriptions.has(ride.id)) driverSosSubscriptions.set(ride.id, subscribeToSos(ride.id, () => { toast('SOS alert received for your active ride. Contact the rider and emergency services.'); })); });
    $$('#driverQueue [data-ride]').forEach(select => select.onchange = async () => { if (!select.value) return; try { await updateDriverRide(select.dataset.ride, select.value); toast('Ride status updated.'); await render(); } catch (error) { toast(error.message); } });
  };
  try { await render(); } catch (error) { $('#driverQueue').textContent = `Could not load driver rides: ${error.message}`; }
}

function showDemoDriverDashboard() {
  const ride = state.activeRide;
  openModal(`<span class="step-label">DEMO DRIVER CONSOLE</span><h2>Driver dashboard preview</h2><p>This preview is local only. Make a demo ride request first, then accept it here to see the rider status update.</p><div id="driverQueue" class="trip-list-view"></div>`);
  const area = $('#driverQueue');
  if (!ride || ['completed','cancelled'].includes(ride.status)) { area.innerHTML = '<p>No open demo ride. Close this panel, book a ride, then return to Driver preview.</p>'; return; }
  const accepting = ['Finding your driver','requested'].includes(ride.status);
  const enroute = ['Driver on the way','accepted','driver_arriving'].includes(ride.status);
  const underway = ride.status === 'in_progress';
  area.innerHTML = `<article class="trip-row"><span class="trip-icon">🚕</span><span class="trip-route"><strong>${escapeHTML(ride.pickup)} → ${escapeHTML(ride.destination)}</strong><small>${escapeHTML(ride.ride)} · ${formatMoney(ride.fare)} · ${escapeHTML(ride.status)}</small></span></article><p>Demo mode labels GPS as simulated. A live ride uses the driver’s shared device GPS.</p>${accepting ? '<button class="modal-primary" id="demoAccept">Accept ride</button><button class="text-link" id="demoDecline">Decline request</button>' : enroute ? '<button class="modal-primary" id="demoStart">Start ride</button>' : underway ? '<button class="modal-primary" id="demoComplete">Complete ride</button>' : '<button class="modal-primary" id="demoComplete">Complete ride</button>'}`;
  $('#demoAccept')?.addEventListener('click', () => { ride.status = 'driver_arriving'; ride.driver = 'Aarav M.'; save(); setRideButtonVisible(true); startDemoDriverTracking(); notifyRideStatus('driver_arriving'); showDemoDriverDashboard(); showActiveRide(); });
  $('#demoDecline')?.addEventListener('click', () => { state.activeRide = null; save(); setRideButtonVisible(false); showDemoDriverDashboard(); });
  $('#demoStart')?.addEventListener('click', () => { ride.status = 'in_progress'; ride.demoTrackingPhase = 'ride'; save(); startDemoDriverTracking(); showDemoDriverDashboard(); showActiveRide(); notifyRideStatus('in_progress'); });
  $('#demoComplete')?.addEventListener('click', () => { ride.status = 'completed'; save(); showDemoDriverDashboard(); toast('Demo ride complete. Open the rider screen to leave a rating.'); });
}

let demoGpsTimer;
let demoGpsProgress = 0;
function startDemoDriverTracking() {
  clearInterval(demoGpsTimer);
  const ride = state.activeRide;
  if (!ride?.pickupPlace || !ride?.destinationPlace || ride.pickupPlace.lat == null || ride.destinationPlace.lat == null) return;
  const origin = ride.demoTrackingPhase === 'ride' ? ride.pickupPlace : { lat: ride.pickupPlace.lat + 0.012, lng: ride.pickupPlace.lng - 0.009 };
  const destination = ride.demoTrackingPhase === 'ride' ? ride.destinationPlace : ride.pickupPlace;
  demoGpsProgress = 0;
  const tick = async () => {
    if (state.activeRide !== ride || !['driver_arriving','in_progress'].includes(ride.status)) { clearInterval(demoGpsTimer); return; }
    demoGpsProgress = Math.min(1, demoGpsProgress + 0.035);
    const point = { lat: origin.lat + (destination.lat - origin.lat) * demoGpsProgress, lng: origin.lng + (destination.lng - origin.lng) * demoGpsProgress, updated_at: new Date().toISOString() };
    ride.driverPosition = point; updateDriverMarker(point); save();
    if (demoGpsProgress >= 1 && ride.status === 'driver_arriving') { toast('Your driver has arrived at pickup.'); clearInterval(demoGpsTimer); return; }
    updateLiveRideETA();
    if (demoGpsProgress >= 1 && ride.status === 'in_progress') clearInterval(demoGpsTimer);
  };
  tick(); demoGpsTimer = setInterval(tick, 2500);
}

function setRideButtonVisible(visible) { $('#viewRideButton').hidden = !visible; }

function setServiceStatus() {
  const note = document.createElement('div');
  note.className = 'service-note';
  const ready = [configured.auth && 'Clerk', configured.database && 'Supabase', configured.maps && 'Google Maps'].filter(Boolean);
  note.textContent = ready.length ? `Configured: ${ready.join(' · ')}` : 'Demo mode · add Clerk, Supabase and Google Maps keys in config.js to enable live services.';
  $('.page-heading').append(note);
  $('#mapStatus').textContent = configured.maps ? 'GOOGLE MAPS' : 'CITY MAP PREVIEW';
  $('#driverPreviewButton').hidden = configured.auth;
  $('#viewRideButton').hidden = !state.activeRide;
  const week = state.rides.filter(ride => Date.now() - new Date(ride.requestedAt || ride.date || 0).getTime() < 7 * 86400000).length;
  $('#weekRideCount').textContent = String(week).padStart(2, '0');
}

function save() { localStorage.setItem(storageKey, JSON.stringify(state)); }
function stopRouteText(ride) { return (ride?.stops || []).map(stop => typeof stop === 'string' ? stop : stop?.label).filter(Boolean).join(' → '); }
function escapeHTML(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2700); }
function distanceEstimate() {
  if (window.wayfareRouteKm) return Math.max(1, Math.round(window.wayfareRouteKm));
  const destination = $('#destination').value.toLowerCase();
  if (/airport|kempegowda/.test(destination)) return 38;
  if (/cubbon|park/.test(destination)) return 6;
  if (/ub city|mg road|brigade/.test(destination)) return 8;
  if (/koramangala/.test(destination)) return 11;
  if (!destination.trim()) return 0;
  return Math.min(31, Math.max(4, Math.round(destination.length * 0.63)));
}
function scheduledPickupDate() {
  if (state.schedule === 'In 30 minutes') return new Date(Date.now() + 30 * 60000);
  if (state.schedule === 'In 1 hour') return new Date(Date.now() + 60 * 60000);
  if (state.schedule.startsWith('Tomorrow')) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + 1, 3, 30));
  }
  return new Date();
}
function demandFactor() {
  const parts = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(scheduledPickupDate());
  const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
  const weekend = ['Sat', 'Sun'].includes(parts.find(part => part.type === 'weekday')?.value);
  const peak = (hour >= 8 && hour < 11) || (hour >= 17 && hour < 21);
  return (weekend ? 1.1 : 1) * (peak ? 1.2 : 1);
}
function estimate(rideButton) {
  const km = distanceEstimate();
  if (!km) return null;
  const raw = (Number(rideButton.dataset.base) + Number(rideButton.dataset.rate) * km) * demandFactor();
  return Math.round(raw / 10) * 10;
}
function updatePrices() {
  const stops = state.stops || [];
  const stopSummary = $('#stopSummary');
  if (stopSummary) stopSummary.textContent = stops.length ? `${stops.length} stop${stops.length === 1 ? '' : 's'} added · tap to edit` : 'Optional · along your route';
  const factor = demandFactor();
  const note = $('#fareEstimateNote');
  if (note) note.textContent = `${window.wayfareRouteKm ? `Google Maps route · ${window.wayfareRouteKm.toFixed(1)} km` : 'Choose Google Maps address suggestions for a route-based estimate'} · ${factor > 1 ? `peak demand estimate ×${factor.toFixed(2)}` : 'off-peak demand estimate'} · final fare may vary`;
  $$('.ride-option').forEach(button => {
    const price = estimate(button);
    const node = $(`#price-${button.dataset.ride.split(' ').pop().toLowerCase()}`);
    if (node) node.textContent = price ? `₹${price.toLocaleString('en-IN')}` : '₹—';
  });
}
function formatMoney(value) { return `₹${Number(value).toLocaleString('en-IN')}`; }
function fareForRide(ride) { const button = $(`.ride-option[data-ride="${ride}"]`); return estimate(button); }
function renderRecentTrips() {
  const rides = [...(state.rides || [])].slice(0, 3);
  $('#recentTrips').innerHTML = rides.length ? rides.map((trip, index) => `<article class="trip-row"><span class="trip-icon">${index === 0 ? '↗' : '⌖'}</span><span class="trip-route"><strong>${escapeHTML(trip.destination)}</strong><small>${escapeHTML(trip.date)} · ${escapeHTML(trip.ride.replace('Wayfare ', ''))}</small></span><span class="trip-rating">${trip.rating ? `${'★'.repeat(trip.rating)}${'☆'.repeat(5 - trip.rating)}` : '—'}</span><span class="trip-fare">${formatMoney(trip.fare)}</span></article>`).join('') : '<div class="trip-row"><span class="trip-icon">◷</span><span class="trip-route"><strong>Your next ride is around the corner</strong><small>Completed trips will show up here.</small></span></div>';
}
function openModal(content) {
  lastFocus = document.activeElement;
  $('#modalContent').innerHTML = content;
  $('#modalContent h2')?.setAttribute('id', 'modalTitle');
  $('#modalBackdrop').hidden = false;
  $('#modalClose').focus();
}
function closeModal() { $('#modalBackdrop').hidden = true; if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus(); }
function tripConfirmation() {
  const destination = $('#destination').value.trim();
  if (!destination) { $('#destination').focus(); toast('Add your destination to see ride options.'); return; }
  const fare = fareForRide(selectedRide);
  const discount = Math.min(fare, Number(state.promoDiscount) || 0);
  const stopRows = (state.stops || []).filter(Boolean).map(stop => `<div class="confirm-route"><span class="confirm-dot"></span><span>Stop · ${escapeHTML(typeof stop === 'string' ? stop : stop.label)}</span></div>`).join('');
  openModal(`<span class="step-label">READY WHEN YOU ARE</span><h2>Confirm your ride</h2><p>Here's a quick look before we find your driver.</p><div class="ride-confirm"><div class="confirm-route"><span class="confirm-dot pick"></span><span>${escapeHTML($('#pickup').value.trim())}</span></div>${stopRows}<div class="confirm-route"><span class="confirm-dot"></span><span>${escapeHTML(destination)}</span></div><div class="confirm-price"><span>${escapeHTML(selectedRide)} · ${distanceEstimate()} km</span><strong>${formatMoney(fare - discount)}</strong></div><div class="confirm-price"><span>Payment · ${escapeHTML(state.payment)}</span><span>${escapeHTML(state.schedule)}</span></div>${discount ? `<div class="confirm-price"><span>${escapeHTML(state.promo)} discount</span><strong>− ${formatMoney(discount)}</strong></div>` : ''}</div><button class="modal-primary" id="confirmRide">Confirm & find a driver <span>↗</span></button><button class="modal-primary secondary-action" id="editRide">Keep planning</button>`);
  $('#confirmRide').addEventListener('click', () => {
    if (configured.auth && !currentUser()) { closeModal(); toggleAuthentication(); return; }
    const adjustedFare = Math.max(0, fare - discount);
    const scheduledFor = state.schedule === 'Ride now' ? null : scheduledPickupDate();
    state.activeRide = { pickup: $('#pickup').value.trim(), destination, pickupPlace, destinationPlace, stops: state.stops || [], scheduledFor: scheduledFor?.toISOString() || null, distanceKm: distanceEstimate(), promo: state.promo, ride: selectedRide, payment: state.payment, fare: adjustedFare, requestedAt: new Date().toISOString(), status: 'Finding your driver' };
    setRideButtonVisible(true);
    const activeRide = state.activeRide;
    createRide(activeRide).then(result => {
      if (!state.activeRide || state.activeRide !== activeRide) return;
      if (!result.demo) { state.activeRide.id = result.ride.id; state.activeRide.live = true; state.activeRide.fare = result.ride.fare_estimate; state.activeRide.status = result.ride.status; save(); showActiveRide(); liveRideUnsubscribe = subscribeToRide(result.ride.id, update => { if (state.activeRide?.id === update.id) { const changed = state.activeRide.status !== update.status; state.activeRide.status = update.status; state.activeRide.driver = update.driver_name; save(); showActiveRide(); if (changed) notifyRideStatus(update.status); } }, location => { if (state.activeRide?.id === location.ride_id) { state.activeRide.driverPosition = location; updateDriverMarker(location); save(); updateLiveRideETA(); } }); getRideLocation(result.ride.id).then(location => { if (location && state.activeRide?.id === location.ride_id) { state.activeRide.driverPosition = location; updateDriverMarker(location); save(); updateLiveRideETA(); } }).catch(error => console.warn('Could not load latest driver GPS:', error)); }
    }).catch(error => { state.activeRide = null; setRideButtonVisible(false); save(); closeModal(); toast(`Ride was not saved: ${error.message}`); });
    save(); closeModal(); showActiveRide(); toast('Finding a nearby driver…');
    if (!configured.database || !currentUser()) setTimeout(() => { if (state.activeRide?.status === 'Finding your driver') { state.activeRide.status = 'driver_arriving'; state.activeRide.driver = 'Aarav M.'; save(); startDemoDriverTracking(); showActiveRide(); notifyRideStatus('accepted'); } }, 3400);
  });
  $('#editRide').addEventListener('click', closeModal);
}
function showActiveRide() {
  if (!state.activeRide) return;
  const ride = state.activeRide;
  const searching = ['Finding your driver', 'requested'].includes(ride.status);
  const arrived = ['Driver on the way', 'accepted', 'driver_arriving'].includes(ride.status);
  const completed = ride.status === 'completed';
  const statusCopy = searching ? 'Waiting for a driver to accept this request.' : completed ? 'Your driver marked this ride complete.' : `Driver ${escapeHTML(ride.driver || '')} is heading your way.`;
  const stops = (ride.stops || []).map(stop => `<div class="confirm-route"><span class="confirm-dot"></span><span>Stop · ${escapeHTML(typeof stop === 'string' ? stop : stop.label)}</span></div>`).join('');
  const gps = ride.driverPosition ? `${ride.live ? 'Live GPS' : 'Simulated GPS'} updated ${new Date(ride.driverPosition.updated_at || Date.now()).toLocaleTimeString()} · calculating ETA…` : ride.live ? 'Waiting for the driver to share GPS…' : 'Demo tracking starts when a demo driver accepts.';
  const canCancel = ['Finding your driver','requested','accepted','driver_arriving','Driver on the way'].includes(ride.status);
  openModal(`<span class="step-label">YOUR RIDE · ${escapeHTML(ride.ride)}</span><h2>${searching ? 'Finding your ride' : completed ? 'Ride complete' : arrived ? 'Your driver is on the way' : escapeHTML(ride.status)}</h2><p>${statusCopy}</p><div class="ride-confirm"><div class="confirm-route"><span class="confirm-dot pick"></span><span>${escapeHTML(ride.pickup)}</span></div>${stops}<div class="confirm-route"><span class="confirm-dot"></span><span>${escapeHTML(ride.destination)}</span></div><div class="confirm-price"><span>Fare · ${escapeHTML(ride.payment)}</span><strong>${formatMoney(ride.fare)}</strong></div>${ride.paymentStatus ? `<div class="confirm-price"><span>Payment status</span><strong>${escapeHTML(ride.paymentStatus)}</strong></div>` : ''}</div><span class="state-pill" aria-live="polite"><i class="status-dot"></i> ${escapeHTML(ride.status)}</span>${!completed ? `<p class="gps-status" id="liveRideEta" aria-live="polite">${gps}</p>${ride.live || ride.driverPosition ? '<button class="modal-primary secondary-action" id="viewTrackingMap">View live tracking map</button>' : ''}<button class="sos-button" id="sosButton">${ride.live ? 'SOS · alert driver' : 'SOS · emergency options'}</button><a class="emergency-call" href="tel:112">Call emergency services · 112</a>` : ''}${completed ? '<div class="modal-form"><button class="modal-primary" id="rateCompletedRide">Rate this ride</button>' + (ride.live && ride.payment === 'Razorpay Checkout' && ride.paymentStatus !== 'paid' ? '<button class="modal-primary secondary-action" id="payWithRazorpay">Pay securely with Razorpay</button>' : '') + '</div>' : arrived && !ride.live ? '<button class="modal-primary" id="completeRide">Complete demo ride</button>' : ''}${canCancel ? '<button class="text-link" id="cancelRide">Cancel this ride</button>' : ''}`);
  $('#viewTrackingMap')?.addEventListener('click', () => { closeModal(); $('#mapCanvas').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('#completeRide')?.addEventListener('click', rateRide);
  $('#rateCompletedRide')?.addEventListener('click', rateRide);
  $('#sosButton')?.addEventListener('click', async () => {
    if (!ride.live) { showHelp(); toast('Demo mode cannot alert a real driver. Use the emergency call option if needed.'); return; }
    const alert = async coords => { try { await sendSos(ride.id, coords); toast('SOS alert sent to the assigned driver. If you are in danger, call 112.'); } catch (error) { toast(`SOS could not reach the driver: ${error.message}. Call 112 if this is an emergency.`); } };
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(position => alert(position.coords), () => alert(null), { enableHighAccuracy: true, timeout: 8000 }); else alert(null);
  });
  $('#payWithRazorpay')?.addEventListener('click', async () => { try { await openRazorpayCheckout(ride.id); } catch (error) { toast(error.message); } });
  $('#cancelRide')?.addEventListener('click', () => {
    openModal(`<span class="step-label">CANCEL RIDE</span><h2>Cancel this trip?</h2><p>No cancellation fee is configured in this project build. A live rider cancellation is saved to Supabase.</p><button class="modal-primary" id="confirmCancelRide">Confirm cancellation</button><button class="modal-primary secondary-action" id="keepRide">Keep ride</button>`);
    $('#confirmCancelRide').addEventListener('click', async () => { try { if (ride.id && ride.live) await cancelRide(ride.id); liveRideUnsubscribe?.(); liveRideUnsubscribe = null; state.activeRide = null; setRideButtonVisible(false); save(); closeModal(); toast('Your ride was cancelled.'); } catch (error) { toast(`Could not cancel: ${error.message}`); } });
    $('#keepRide').addEventListener('click', showActiveRide);
  });
}
function notifyRideStatus(status) {
  const messages = { accepted: 'A driver accepted your ride.', driver_arriving: 'Your driver is arriving.', in_progress: 'Your ride has started.', completed: 'Your ride is complete.' };
  const message = messages[status];
  if (!message) return;
  toast(message);
  if ('Notification' in window && Notification.permission === 'granted') new Notification('Wayfare ride update', { body: message });
}
let etaRequest = 0;
let lastEtaAt = 0;
async function updateLiveRideETA() {
  const ride = state.activeRide;
  const etaLabel = $('#liveRideEta');
  if (!ride?.driverPosition || !etaLabel) return;
  if (Date.now() - lastEtaAt < 15000) return;
  lastEtaAt = Date.now();
  const request = ++etaRequest;
  etaLabel.textContent = `Driver GPS updated ${new Date(ride.driverPosition.updated_at || Date.now()).toLocaleTimeString()} · recalculating route…`;
  try {
    const destination = ride.destinationPlace || (ride.destination_lat != null ? { lat: ride.destination_lat, lng: ride.destination_lng } : null);
    if (!destination) return;
    const route = await routeBetween({ lat: ride.driverPosition.lat, lng: ride.driverPosition.lng }, destination, ride.stops || []);
    if (request !== etaRequest || !$('#liveRideEta')) return;
    if (route) etaLabel.textContent = `${ride.live ? 'Driver live' : 'Demo driver simulated'} · updated ${new Date(ride.driverPosition.updated_at || Date.now()).toLocaleTimeString()} · ETA ${route.minutes} min · ${route.km.toFixed(1)} km remaining`;
  } catch (error) { console.warn('Could not refresh ride ETA:', error); }
}
function rateRide() {
  const ride = state.activeRide;
  if (!ride) return;
  let rating = 5;
  openModal(`<span class="step-label">TRIP COMPLETE</span><h2>How was your ride?</h2><p>Share a little feedback about ${escapeHTML(ride.driver || 'your driver')}.</p><div class="star-rating" role="radiogroup" aria-label="Rate your driver">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= rating ? 'chosen' : ''}" data-rating="${n}" aria-label="${n} stars">★</button>`).join('')}</div><label class="modal-form"><span class="step-label">ANYTHING ELSE? (OPTIONAL)</span><textarea id="reviewText" rows="3" placeholder="Tell us what went well…"></textarea></label><button class="modal-primary" id="saveRating">Done</button>`);
  $$('.star-rating button').forEach(button => button.addEventListener('click', () => { rating = Number(button.dataset.rating); $$('.star-rating button').forEach(star => star.classList.toggle('chosen', Number(star.dataset.rating) <= rating)); }));
  $('#saveRating').addEventListener('click', async () => { const review = $('#reviewText').value.trim(); try { if (ride.live) await finishRide(ride.id, rating, review); state.rides.unshift({ ...ride, date: 'Today · just now', status: 'Completed', rating, review }); state.activeRide = null; setRideButtonVisible(false); liveRideUnsubscribe?.(); liveRideUnsubscribe = null; save(); renderRecentTrips(); closeModal(); toast('Thanks for riding with wayfare.'); } catch (error) { toast(`Could not save review: ${error.message}`); } });
}
function showTripList() {
  const items = state.rides.map((trip, index) => `<article class="trip-row"><span class="trip-icon">${index % 2 ? '⌖' : '↗'}</span><span class="trip-route"><strong>${escapeHTML(trip.pickup)} → ${escapeHTML(trip.destination)}</strong><small>${escapeHTML(trip.date)} · ${escapeHTML(trip.ride)} · ${escapeHTML(trip.status)}${trip.rating ? ` · ${'★'.repeat(trip.rating)}${'☆'.repeat(5-trip.rating)}` : ''}${trip.paymentStatus ? ` · Payment ${escapeHTML(trip.paymentStatus)}` : ''}</small>${trip.review ? `<small>Review: ${escapeHTML(trip.review)}</small>` : ''}</span><span class="trip-fare">${formatMoney(trip.fare)}</span>${trip.live && trip.status === 'completed' && trip.paymentMethod === 'Razorpay Checkout' && trip.paymentStatus !== 'paid' ? `<button class="driver-track" data-pay-ride="${trip.id}">Pay now</button>` : ''}</article>`).join('') || '<p>No trips yet. Your booked rides, payment status, ratings, and reviews will appear here.</p>';
  openModal(`<span class="step-label">YOUR JOURNEYS</span><h2>Trip history</h2><p>Your recent rides, all in one place.</p><div class="trip-list-view">${items}</div><button class="modal-primary" id="downloadReceipts">Download ride receipts (CSV)</button>`);
  $$('[data-pay-ride]').forEach(button => button.addEventListener('click', async () => { try { await openRazorpayCheckout(button.dataset.payRide); } catch (error) { toast(error.message); } }));
  $('#downloadReceipts').addEventListener('click', () => {
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const csv = [['Date','Pickup','Destination','Ride','Fare (INR)','Ride status','Payment status','Rating','Review'], ...state.rides.map(ride => [ride.date, ride.pickup, ride.destination, ride.ride, ride.fare, ride.status, ride.paymentStatus || 'unpaid', ride.rating || '', ride.review || ''])].map(row => row.map(quote).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'wayfare-trip-receipts.csv'; link.click(); URL.revokeObjectURL(url); toast('Ride receipt summary downloaded.');
  });
}
function showPayments() {
  openModal(`<span class="step-label">PAYMENT PREFERENCES</span><h2>Payment methods</h2><p>Choose cash or pay online after your ride.</p><div class="modal-form"><label for="paymentChoice">PAYMENT METHOD</label><select id="paymentChoice"><option ${state.payment === 'Cash' ? 'selected' : ''}>Cash</option><option value="Razorpay Checkout" ${state.payment === 'Razorpay Checkout' ? 'selected' : ''}>Razorpay · UPI, cards, net banking, wallets</option></select><button class="modal-primary" id="savePayment">Save preference</button></div><p>Razorpay Checkout shows the payment methods enabled for your account. Test keys are required for simulated payments; live payments need account activation.</p>${state.activeRide?.live && state.activeRide.status === 'completed' ? '<button class="modal-primary" id="payNow">Pay for completed ride</button>' : ''}`);
  $('#savePayment').addEventListener('click', () => { state.payment = $('#paymentChoice').value; save(); $('#paymentLabel').textContent = state.payment; closeModal(); toast('Payment preference saved.'); });
  $('#payNow')?.addEventListener('click', async () => { try { await openRazorpayCheckout(state.activeRide.id); } catch (error) { toast(error.message); } });
}
function showProfile() {
  const user = currentUser();
  const email = user?.primaryEmailAddress?.emailAddress || state.email || 'Not added';
  const phone = user?.primaryPhoneNumber?.phoneNumber || state.phone || 'Not added';
  const accountRows = `<div class="profile-grid"><div class="profile-tile"><small>NAME</small><strong>${escapeHTML(state.name)}</strong></div><div class="profile-tile"><small>ACCOUNT</small><strong>${user ? 'Verified Clerk account' : 'Demo rider'}</strong></div><div class="profile-tile"><small>EMAIL</small><strong>${escapeHTML(email)}</strong></div><div class="profile-tile"><small>PHONE</small><strong>${escapeHTML(phone)}</strong></div><div class="profile-tile"><small>TRIPS</small><strong>${state.rides.length}</strong></div><div class="profile-tile"><small>PAYMENT</small><strong>${escapeHTML(state.payment)}</strong></div></div>`;
  openModal(`<span class="step-label">YOUR WAYFARE ACCOUNT</span><h2>Profile & records</h2><p>Manage your name, verified email, phone, and sign-in methods.</p>${accountRows}${user ? '<button class="modal-primary" id="manageClerkProfile">Manage personal details</button>' : '<button class="modal-primary" id="editProfile">Edit demo profile</button>'}<p class="profile-record-note">Your ride history, ratings, and payment records appear under Your trips and Payments.</p>`);
  $('#manageClerkProfile')?.addEventListener('click', async () => { try { await openAccountManagement(); } catch (error) { toast(error.message); } });
  $('#editProfile')?.addEventListener('click', () => { openModal(`<span class="step-label">DEMO PROFILE</span><h2>Edit rider details</h2><form class="modal-form" id="profileForm"><label for="nameInput">FULL NAME</label><input id="nameInput" value="${escapeHTML(state.name)}" maxlength="80" required/><label for="emailInput">EMAIL</label><input id="emailInput" type="email" value="${escapeHTML(state.email || '')}" maxlength="180"/><label for="phoneInput">PHONE</label><input id="phoneInput" type="tel" value="${escapeHTML(state.phone || '')}" maxlength="30"/><button class="modal-primary">Save demo details</button></form><p>Demo details stay in this browser. Create a Clerk account to verify and manage real contact information.</p>`); $('#profileForm').addEventListener('submit', event => { event.preventDefault(); state.name = $('#nameInput').value.trim(); state.email = $('#emailInput').value.trim(); state.phone = $('#phoneInput').value.trim(); save(); $('.account-copy strong').textContent = state.name; $('.top-avatar').textContent = state.name.slice(0,1).toUpperCase(); $('.breadcrumb span:first-child').textContent = `Hello, ${state.name}`; closeModal(); toast('Demo profile saved on this browser.'); }); });
}
function showHelp() {
  openModal(`<span class="step-label">WE'RE HERE FOR YOU</span><h2>Help & safety</h2><p>Share your current ride details with a trusted contact. Emergency alerts require a deployed safety service.</p><div class="trip-list-view"><article class="trip-row"><span class="trip-icon">✚</span><span class="trip-route"><strong>Emergency services</strong><small>Call emergency number 112 (India).</small></span><a class="trip-fare" href="tel:112" aria-label="Call 112">Call ↗</a></article></div><form class="modal-form" id="supportForm"><label for="supportSubject">SUPPORT SUBJECT</label><input id="supportSubject" required maxlength="120" placeholder="What do you need help with?"/><label for="supportMessage">MESSAGE</label><textarea id="supportMessage" required maxlength="5000" rows="3" placeholder="Tell our support team what happened…"></textarea><button class="modal-primary">Send support request</button></form><button class="modal-primary secondary-action" id="shareRideDetails">Share ride details</button>`);
  $('#supportForm').addEventListener('submit', async event => { event.preventDefault(); try { await createSupportTicket($('#supportSubject').value.trim(), $('#supportMessage').value.trim()); closeModal(); toast('Support request sent.'); } catch (error) { toast(error.message); } });
  $('#shareRideDetails').addEventListener('click', async () => { if (!state.activeRide) return toast('There is no active ride to share.'); const text = `Wayfare ride details: ${state.activeRide.pickup} to ${state.activeRide.destination}. Status: ${state.activeRide.status}.`; try { if (navigator.share) await navigator.share({ title: 'My ride details', text }); else await navigator.clipboard.writeText(text); toast('Ride details shared.'); } catch { toast('Ride details could not be shared.'); } });
}

function openStops() {
  const values = [...(state.stops || []), '', ''].slice(0, 3);
  const labels = values.map(value => typeof value === 'string' ? value : value?.label || '');
  const selectedPlaces = [...(state.stops || [])].map(stop => typeof stop === 'string' ? null : stop);
  openModal(`<span class="step-label">YOUR ROUTE</span><h2>Add up to three stops</h2><p>Select addresses from Google suggestions for route pricing, or enter stops manually in demo mode.</p><form class="modal-form" id="stopsForm">${labels.map((value, index) => `<label for="stop${index}">STOP ${index + 1}</label><div class="stop-picker"><input id="stop${index}" maxlength="180" value="${escapeHTML(value)}" placeholder="Optional stop"/><div class="stop-suggestions" id="stopSuggestions${index}"></div></div>`).join('')}<button class="modal-primary">Save stops</button></form>`);
  [0,1,2].forEach(index => {
    const input = $(`#stop${index}`); const suggestionsEl = $(`#stopSuggestions${index}`); let timer;
    input.addEventListener('input', () => { selectedPlaces[index] = null; clearTimeout(timer); timer = setTimeout(async () => {
      if (!configured.maps) return;
      try { const suggestions = await suggestPlaces(input.value); suggestionsEl.replaceChildren(); suggestions.forEach(item => { const button = document.createElement('button'); button.type = 'button'; button.textContent = item.placePrediction.text.toString(); button.onclick = async () => { selectedPlaces[index] = await selectPlace(item.placePrediction); input.value = selectedPlaces[index].label; suggestionsEl.replaceChildren(); }; suggestionsEl.append(button); }); }
      catch (error) { toast(`Stop search unavailable: ${error.message}`); }
    }, 300); });
  });
  $('#stopsForm').addEventListener('submit', async event => { event.preventDefault(); const labels = [0,1,2].map(index => $(`#stop${index}`).value.trim()); if (configured.maps && labels.some((label, index) => label && (selectedPlaces[index]?.lat == null || selectedPlaces[index]?.lng == null))) return toast('Choose each stop from the Google Maps suggestions so distance and fare include it.'); state.stops = labels.map((label, index) => label ? { label, lat: selectedPlaces[index]?.lat ?? null, lng: selectedPlaces[index]?.lng ?? null, placeId: selectedPlaces[index]?.placeId ?? null } : null).filter(Boolean); save(); closeModal(); updatePrices(); updateGoogleRoute(); toast(`${state.stops.length} stop${state.stops.length === 1 ? '' : 's'} added.`); });
}
function openPromo() {
  openModal(`<span class="step-label">OFFERS & DISCOUNTS</span><h2>Apply a promo code</h2><p>Enter a valid code before requesting your ride. Demo code: WAYFARE150 for ₹150 off.</p><form class="modal-form" id="promoForm"><label for="promoInput">PROMO CODE</label><input id="promoInput" placeholder="e.g. WAYFARE150" value="${escapeHTML(state.promo)}" autocomplete="off"/><button class="modal-primary">Apply discount</button></form>${state.promo ? '<button class="text-link" id="removePromo">Remove applied code</button>' : ''}`);
  $('#promoForm').addEventListener('submit', async event => { event.preventDefault(); const code = $('#promoInput').value.trim().toUpperCase(); try { const amount = await validatePromoCode(code); if (amount == null) { toast('This code is invalid, expired, or already used.'); return; } state.promo = code; state.promoDiscount = amount; $('#promoLabel').textContent = `${formatMoney(amount)} off`; save(); closeModal(); updatePrices(); toast(`${formatMoney(amount)} discount applied.`); } catch (error) { toast(`Could not validate promo: ${error.message}`); } });
  $('#removePromo')?.addEventListener('click', () => { state.promo = ''; state.promoDiscount = 0; $('#promoLabel').textContent = 'Add promo'; save(); closeModal(); updatePrices(); toast('Promo code removed.'); });
}
function openSchedule() {
  openModal(`<span class="step-label">TRAVEL ON YOUR TIME</span><h2>When should we pick you up?</h2><form class="modal-form" id="scheduleForm"><label for="timeChoice">PICKUP TIME</label><select id="timeChoice"><option value="Ride now" ${state.schedule === 'Ride now' ? 'selected' : ''}>Ride now</option><option value="In 30 minutes" ${state.schedule === 'In 30 minutes' ? 'selected' : ''}>In 30 minutes</option><option value="In 1 hour" ${state.schedule === 'In 1 hour' ? 'selected' : ''}>In 1 hour</option><option value="Tomorrow · 9:00 AM" ${state.schedule === 'Tomorrow · 9:00 AM' ? 'selected' : ''}>Tomorrow · 9:00 AM</option></select><button class="modal-primary">Save pickup time</button></form>`);
  $('#scheduleForm').addEventListener('submit', event => { event.preventDefault(); state.schedule = $('#timeChoice').value; $('#scheduleLabel').textContent = state.schedule; save(); closeModal(); updatePrices(); toast(`Pickup set: ${state.schedule}.`); });
}
function navigate(view) {
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $$('.mobile-tabs button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'home') { closeModal(); return; }
  ({ activity: showTripList, payments: showPayments, profile: showProfile, help: showHelp })[view]?.();
}
function showShare() {
  openModal(`<span class="step-label">TRAVEL TOGETHER</span><h2>Share the wayfare</h2><p>Invite a friend with this demo code. No message is sent automatically.</p><div class="ride-confirm"><div class="confirm-price"><span>Your invite code</span><strong>WAYFARE150</strong></div><div class="confirm-price"><span>Your friend's welcome offer</span><strong>₹150 off</strong></div></div><button class="modal-primary" id="copyInvite">Copy invite code</button>`);
  $('#copyInvite').addEventListener('click', async () => { try { await navigator.clipboard.writeText('WAYFARE150'); toast('Invite code copied.'); } catch { toast('Your invite code is WAYFARE150.'); } closeModal(); });
}

$('#bookingForm').addEventListener('submit', event => { event.preventDefault(); tripConfirmation(); });
$$('.ride-option').forEach(button => button.addEventListener('click', () => { $$('.ride-option').forEach(item => { item.classList.remove('selected'); item.setAttribute('aria-checked', 'false'); }); button.classList.add('selected'); button.setAttribute('aria-checked', 'true'); selectedRide = button.dataset.ride; updatePrices(); }));
$('#destination').addEventListener('input', updatePrices);
$$('.suggestions button').forEach(button => button.addEventListener('click', () => { $('#destination').value = button.dataset.destination; destinationPlace = null; updatePrices(); $('#destination').focus(); $('#destination').dispatchEvent(new Event('input')); }));
$('#clearDestination').addEventListener('click', () => { $('#destination').value = ''; destinationPlace = null; window.wayfareRouteKm = null; updatePrices(); $('#destination').focus(); });
$('#swapButton').addEventListener('click', () => { const pickup = $('#pickup'); const destination = $('#destination'); [pickup.value, destination.value] = [destination.value, pickup.value]; [pickupPlace, destinationPlace] = [destinationPlace, pickupPlace]; window.wayfareRouteKm = null; updatePrices(); updateGoogleRoute(); });
$('#locateButton').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Location is not available in this browser.');
  navigator.geolocation.getCurrentPosition(position => {
    pickupPlace = { lat: position.coords.latitude, lng: position.coords.longitude, label: 'Current location' };
    $('#pickup').value = 'Current location'; updateGoogleRoute(); toast('Pickup set to your current location.');
  }, () => toast('Could not get your location. Check browser location permission.'), { enableHighAccuracy: true, timeout: 10000 });
});
$('#authButton').addEventListener('click', async () => { try { if (!await toggleAuthentication()) toast('Add your Clerk publishable key in config.js to enable authentication.'); } catch (error) { toast(error.message); } });
$('#driverPreviewButton').addEventListener('click', showDriverDashboard);
$('#viewRideButton').addEventListener('click', showActiveRide);
$('#scheduleButton').addEventListener('click', openSchedule);
$('#moreBookingOptions').addEventListener('click', openStops);
$('#paymentMethodButton').addEventListener('click', showPayments);
$('#promoButton').addEventListener('click', openPromo);
$('#tryPromoButton').addEventListener('click', openPromo);
$('#shareTripButton').addEventListener('click', showHelp);
$('#inviteButton').addEventListener('click', showShare);
$$('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
$('#mapExpand').addEventListener('click', () => toast('Map preview · Bengaluru, Karnataka'));
$$('.map-zoom button').forEach(button => button.addEventListener('click', () => toast('Map preview is for illustration.')));
$('#modalClose').addEventListener('click', closeModal);
$('#modalBackdrop').addEventListener('click', event => { if (event.target === $('#modalBackdrop')) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#modalBackdrop').hidden) closeModal(); });
$('#paymentLabel').textContent = state.payment;
$('#scheduleLabel').textContent = state.schedule;
$('#promoLabel').textContent = state.promo ? '₹150 off' : 'Add promo';
updatePrices();
renderRecentTrips();
$('#currentDate').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
if (state.activeRide) setTimeout(showActiveRide, 350);

const placeList = document.createElement('div');
placeList.className = 'place-suggestions'; placeList.id = 'placeSuggestions'; placeList.setAttribute('role', 'listbox');
$('.location-fields').append(placeList);
let placeTimer;
async function updateGoogleRoute() {
  if (!pickupPlace || !destinationPlace) return;
  try { const route = await routeBetween(pickupPlace, destinationPlace, state.stops || []); if (route) { window.wayfareRouteKm = route.km; updatePrices(); toast(`Google Maps route: ${route.km.toFixed(1)} km · ${route.minutes} min`); } }
  catch (error) { toast(`Route estimate unavailable: ${error.message}`); }
}
function attachPlacePicker(input, field) {
  input.addEventListener('input', () => {
    if (field === 'pickup') pickupPlace = null; else destinationPlace = null;
    window.wayfareRouteKm = null; clearTimeout(placeTimer);
    placeTimer = setTimeout(async () => {
      if (!configured.maps) return;
      try {
        const suggestions = await suggestPlaces(input.value); placeList.replaceChildren();
        suggestions.forEach(prediction => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'place-suggestion'; button.setAttribute('role', 'option');
          button.textContent = prediction.placePrediction.text.toString();
          button.addEventListener('click', async () => {
            const place = await selectPlace(prediction.placePrediction); input.value = place.label;
            if (field === 'pickup') pickupPlace = place; else destinationPlace = place;
            placeList.replaceChildren(); updatePrices(); await updateGoogleRoute();
          });
          placeList.append(button);
        });
      } catch (error) { toast(`Location search unavailable: ${error.message}`); }
    }, 300);
  });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 3) input.dispatchEvent(new Event('input')); });
}
attachPlacePicker($('#pickup'), 'pickup');
attachPlacePicker($('#destination'), 'destination');
const integrationResults = await initializeIntegrations(syncAuth);
if (integrationResults.some(result => result.status === 'rejected')) toast('A service did not connect. Check the keys and browser console.');
setServiceStatus();
if (state.activeRide?.live && state.activeRide.id) {
  liveRideUnsubscribe = subscribeToRide(state.activeRide.id, update => { const changed = state.activeRide.status !== update.status; Object.assign(state.activeRide, { status: update.status, driver: update.driver_name }); save(); showActiveRide(); if (changed) notifyRideStatus(update.status); }, location => { state.activeRide.driverPosition = location; updateDriverMarker(location); save(); updateLiveRideETA(); });
  getRideLocation(state.activeRide.id).then(location => { if (location && state.activeRide?.id === location.ride_id) { state.activeRide.driverPosition = location; updateDriverMarker(location); save(); updateLiveRideETA(); } }).catch(error => console.warn('Could not load latest driver GPS:', error));
}
const paymentResult = new URLSearchParams(location.search).get('payment');
if (paymentResult === 'success') toast('Payment submitted. Your receipt status will update when Razorpay confirms it.');
if (paymentResult === 'cancelled') toast('Payment was cancelled. You can try again from the ride screen.');
