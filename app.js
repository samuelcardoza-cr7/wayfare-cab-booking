const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const storageKey = 'wayfare-demo-v1';
const defaultState = { rides: [
  { pickup: 'Indiranagar, Bengaluru', destination: 'The Oberoi, Bengaluru', ride: 'Wayfare Go', fare: 286, date: 'Today · 10:24 AM', status: 'Completed', rating: 5 },
  { pickup: 'Indiranagar, Bengaluru', destination: 'Bengaluru International Airport', ride: 'Wayfare Comfort', fare: 1_248, date: 'Yesterday · 7:16 PM', status: 'Completed', rating: 5 },
  { pickup: 'Cubbon Park, Bengaluru', destination: 'Indiranagar, Bengaluru', ride: 'Wayfare Go', fare: 214, date: '5 Nov · 4:42 PM', status: 'Completed', rating: 4 }
], activeRide: null, promo: '', payment: 'Cash', schedule: 'Ride now', name: 'Sam Taylor' };
let state;
try { state = { ...defaultState, ...JSON.parse(localStorage.getItem(storageKey) || '{}') }; } catch { state = structuredClone(defaultState); }
let selectedRide = 'Wayfare Go';
let toastTimer;
let lastFocus;

function save() { localStorage.setItem(storageKey, JSON.stringify(state)); }
function escapeHTML(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2700); }
function distanceEstimate() {
  const destination = $('#destination').value.toLowerCase();
  if (/airport|kempegowda/.test(destination)) return 38;
  if (/cubbon|park/.test(destination)) return 6;
  if (/ub city|mg road|brigade/.test(destination)) return 8;
  if (/koramangala/.test(destination)) return 11;
  if (!destination.trim()) return 0;
  return Math.min(31, Math.max(4, Math.round(destination.length * 0.63)));
}
function estimate(rideButton) {
  const km = distanceEstimate();
  if (!km) return null;
  const raw = Number(rideButton.dataset.base) + Number(rideButton.dataset.rate) * km;
  return Math.round(raw / 10) * 10;
}
function updatePrices() {
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
  openModal(`<span class="step-label">READY WHEN YOU ARE</span><h2>Confirm your ride</h2><p>Here's a quick look before we find your driver.</p><div class="ride-confirm"><div class="confirm-route"><span class="confirm-dot pick"></span><span>${escapeHTML($('#pickup').value.trim())}</span></div><div class="confirm-route"><span class="confirm-dot"></span><span>${escapeHTML(destination)}</span></div><div class="confirm-price"><span>${escapeHTML(selectedRide)} · ${distanceEstimate()} km</span><strong>${formatMoney(fare)}</strong></div><div class="confirm-price"><span>Payment · ${escapeHTML(state.payment)}</span><span>${escapeHTML(state.schedule)}</span></div>${state.promo === 'WAYFARE150' ? '<div class="confirm-price"><span>Welcome offer</span><strong>− ₹150</strong></div>' : ''}</div><button class="modal-primary" id="confirmRide">Confirm & find a driver <span>↗</span></button><button class="modal-primary secondary-action" id="editRide">Keep planning</button>`);
  $('#confirmRide').addEventListener('click', () => {
    const adjustedFare = Math.max(0, fare - (state.promo === 'WAYFARE150' ? 150 : 0));
    state.activeRide = { pickup: $('#pickup').value.trim(), destination, ride: selectedRide, fare: adjustedFare, requestedAt: new Date().toISOString(), status: 'Finding your driver' };
    save(); closeModal(); showActiveRide(); toast('Finding a nearby driver…');
    setTimeout(() => { if (state.activeRide?.status === 'Finding your driver') { state.activeRide.status = 'Driver on the way'; state.activeRide.driver = 'Aarav M.'; save(); showActiveRide(); toast('Aarav accepted your ride.'); } }, 3400);
  });
  $('#editRide').addEventListener('click', closeModal);
}
function showActiveRide() {
  if (!state.activeRide) return;
  const ride = state.activeRide;
  openModal(`<span class="step-label">YOUR RIDE · ${escapeHTML(ride.ride)}</span><h2>${ride.status === 'Finding your driver' ? 'Finding your ride' : 'Your driver is on the way'}</h2><p>${ride.status === 'Finding your driver' ? 'Checking nearby drivers around Bengaluru…' : `${escapeHTML(ride.driver || 'Aarav M.')} is heading your way. Estimated pickup in 4 min.`}</p><div class="ride-confirm"><div class="confirm-route"><span class="confirm-dot pick"></span><span>${escapeHTML(ride.pickup)}</span></div><div class="confirm-route"><span class="confirm-dot"></span><span>${escapeHTML(ride.destination)}</span></div><div class="confirm-price"><span>Estimated fare · ${escapeHTML(state.payment)}</span><strong>${formatMoney(ride.fare)}</strong></div></div><span class="state-pill"><i class="status-dot"></i> ${escapeHTML(ride.status)}</span>${ride.status === 'Driver on the way' ? '<div class="modal-form"><button class="modal-primary" id="completeRide">Complete demo ride</button><button class="text-link" id="cancelRide">Cancel this ride</button></div>' : ''}`);
  $('#completeRide')?.addEventListener('click', rateRide);
  $('#cancelRide')?.addEventListener('click', () => { state.activeRide = null; save(); closeModal(); toast('Your ride was cancelled.'); });
}
function rateRide() {
  const ride = state.activeRide;
  if (!ride) return;
  let rating = 5;
  openModal(`<span class="step-label">TRIP COMPLETE</span><h2>How was your ride?</h2><p>Share a little feedback about ${escapeHTML(ride.driver || 'your driver')}.</p><div class="star-rating" role="radiogroup" aria-label="Rate your driver">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= rating ? 'chosen' : ''}" data-rating="${n}" aria-label="${n} stars">★</button>`).join('')}</div><label class="modal-form"><span class="step-label">ANYTHING ELSE? (OPTIONAL)</span><textarea id="reviewText" rows="3" placeholder="Tell us what went well…"></textarea></label><button class="modal-primary" id="saveRating">Done</button>`);
  $$('.star-rating button').forEach(button => button.addEventListener('click', () => { rating = Number(button.dataset.rating); $$('.star-rating button').forEach(star => star.classList.toggle('chosen', Number(star.dataset.rating) <= rating)); }));
  $('#saveRating').addEventListener('click', () => { state.rides.unshift({ ...ride, date: 'Today · just now', status: 'Completed', rating, review: $('#reviewText').value.trim() }); state.activeRide = null; save(); renderRecentTrips(); closeModal(); toast('Thanks for riding with wayfare.'); });
}
function showTripList() {
  const items = state.rides.map((trip, index) => `<article class="trip-row"><span class="trip-icon">${index % 2 ? '⌖' : '↗'}</span><span class="trip-route"><strong>${escapeHTML(trip.pickup)} → ${escapeHTML(trip.destination)}</strong><small>${escapeHTML(trip.date)} · ${escapeHTML(trip.ride)} · ${escapeHTML(trip.status)}</small></span><span class="trip-fare">${formatMoney(trip.fare)}</span></article>`).join('') || '<p>No trips yet. Your first ride is waiting.</p>';
  openModal(`<span class="step-label">YOUR JOURNEYS</span><h2>Trip history</h2><p>Your recent rides, all in one place.</p><div class="trip-list-view">${items}</div>`);
}
function showPayments() {
  openModal(`<span class="step-label">PAYMENT PREFERENCES</span><h2>Payment methods</h2><p>Choose how you’d like to pay. This demo never charges a card.</p><div class="modal-form"><label for="paymentChoice">DEFAULT METHOD</label><select id="paymentChoice"><option ${state.payment === 'Cash' ? 'selected' : ''}>Cash</option><option ${state.payment === 'UPI' ? 'selected' : ''}>UPI</option><option ${state.payment === 'Card ending 4242' ? 'selected' : ''}>Card ending 4242</option></select><button class="modal-primary" id="savePayment">Save preference</button></div><p>Secure payments are represented as a prototype. A real app needs a server-side payment provider.</p>`);
  $('#savePayment').addEventListener('click', () => { state.payment = $('#paymentChoice').value; save(); $('#paymentLabel').textContent = state.payment; closeModal(); toast('Payment preference saved.'); });
}
function showProfile() {
  openModal(`<span class="step-label">YOUR WAYFARE ACCOUNT</span><h2>Your profile</h2><p>Keep your details up to date for smoother pickups.</p><div class="profile-grid"><div class="profile-tile"><small>NAME</small><strong>${escapeHTML(state.name)}</strong></div><div class="profile-tile"><small>ACCOUNT</small><strong>Rider</strong></div><div class="profile-tile"><small>PHONE</small><strong>+91 ••••• ••108</strong></div><div class="profile-tile"><small>MEMBER SINCE</small><strong>October 2026</strong></div><div class="profile-tile"><small>TRIPS COMPLETED</small><strong>${state.rides.length}</strong></div><div class="profile-tile"><small>DEFAULT PAYMENT</small><strong>${escapeHTML(state.payment)}</strong></div></div><button class="modal-primary" id="editProfile" style="margin-top:16px">Edit display name</button>`);
  $('#editProfile').addEventListener('click', () => { openModal(`<span class="step-label">YOUR PROFILE</span><h2>Update your name</h2><form class="modal-form" id="profileForm"><label for="nameInput">DISPLAY NAME</label><input id="nameInput" value="${escapeHTML(state.name)}" maxlength="40" required /><button class="modal-primary">Save changes</button></form>`); $('#profileForm').addEventListener('submit', event => { event.preventDefault(); state.name = $('#nameInput').value.trim() || 'Sam Taylor'; save(); closeModal(); toast('Profile updated.'); }); });
}
function showHelp() {
  openModal(`<span class="step-label">WE'RE HERE FOR YOU</span><h2>Help & safety</h2><p>Quick access to the essentials, whenever you need them.</p><div class="trip-list-view"><article class="trip-row"><span class="trip-icon">♧</span><span class="trip-route"><strong>Share your ride</strong><small>Let a trusted contact follow your trip.</small></span><span class="trip-fare">↗</span></article><article class="trip-row"><span class="trip-icon">✚</span><span class="trip-route"><strong>Emergency support</strong><small>In a real ride, contact local emergency services.</small></span><span class="trip-fare">↗</span></article><article class="trip-row"><span class="trip-icon">?</span><span class="trip-route"><strong>Contact wayfare support</strong><small>We’re happy to help with any trip.</small></span><span class="trip-fare">↗</span></article></div><button class="modal-primary" id="safetyDone">Got it</button>`);
  $('#safetyDone').addEventListener('click', closeModal);
}
function openPromo() {
  openModal(`<span class="step-label">A LITTLE SOMETHING FOR THE ROAD</span><h2>Have a promo code?</h2><p>Enter a code to apply it to this ride. Try WAYFARE150 for ₹150 off.</p><form class="modal-form" id="promoForm"><label for="promoInput">PROMO CODE</label><input id="promoInput" placeholder="e.g. WAYFARE150" value="${escapeHTML(state.promo)}" autocomplete="off"/><button class="modal-primary">Apply code</button></form>`);
  $('#promoForm').addEventListener('submit', event => { event.preventDefault(); const code = $('#promoInput').value.trim().toUpperCase(); if (code === 'WAYFARE150') { state.promo = code; $('#promoLabel').textContent = '₹150 off'; save(); closeModal(); updatePrices(); toast('₹150 offer applied to your ride.'); } else { toast('That code isn’t active. Try WAYFARE150.'); } });
}
function openSchedule() {
  openModal(`<span class="step-label">TRAVEL ON YOUR TIME</span><h2>When should we pick you up?</h2><form class="modal-form" id="scheduleForm"><label for="timeChoice">PICKUP TIME</label><select id="timeChoice"><option value="Ride now" ${state.schedule === 'Ride now' ? 'selected' : ''}>Ride now</option><option value="In 30 minutes" ${state.schedule === 'In 30 minutes' ? 'selected' : ''}>In 30 minutes</option><option value="In 1 hour" ${state.schedule === 'In 1 hour' ? 'selected' : ''}>In 1 hour</option><option value="Tomorrow · 9:00 AM" ${state.schedule === 'Tomorrow · 9:00 AM' ? 'selected' : ''}>Tomorrow · 9:00 AM</option></select><button class="modal-primary">Save pickup time</button></form>`);
  $('#scheduleForm').addEventListener('submit', event => { event.preventDefault(); state.schedule = $('#timeChoice').value; $('#scheduleLabel').textContent = state.schedule; save(); closeModal(); toast(`Pickup set: ${state.schedule}.`); });
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
$$('.suggestions button').forEach(button => button.addEventListener('click', () => { $('#destination').value = button.dataset.destination; updatePrices(); $('#destination').focus(); }));
$('#clearDestination').addEventListener('click', () => { $('#destination').value = ''; updatePrices(); $('#destination').focus(); });
$('#swapButton').addEventListener('click', () => { const pickup = $('#pickup'); const destination = $('#destination'); [pickup.value, destination.value] = [destination.value || 'Indiranagar, Bengaluru', pickup.value]; updatePrices(); });
$('#locateButton').addEventListener('click', () => toast('Pickup set to Indiranagar, Bengaluru.'));
$('#scheduleButton').addEventListener('click', openSchedule);
$('#paymentMethodButton').addEventListener('click', showPayments);
$('#promoButton').addEventListener('click', openPromo);
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
if (state.activeRide) setTimeout(showActiveRide, 350);
