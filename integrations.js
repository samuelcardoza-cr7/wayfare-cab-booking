const settings = window.WAYFARE_CONFIG || {};
let clerk;
let clerkInitializationError;
let supabase;
let maps;
let placesSession;
let places;
let directions;
let driverMarker;
let routeLine;

export const configured = {
  auth: Boolean(settings.clerkPublishableKey),
  database: Boolean(settings.supabaseUrl && settings.supabasePublishableKey),
  maps: Boolean(settings.googleMapsApiKey),
  payments: Boolean(settings.apiBaseUrl)
};

async function loadClerkScript(src, attributes = {}) {
  const existing = document.querySelector(`script[data-wayfare-clerk-src="${src}"]`);
  if (existing?.dataset.loaded === 'true') return;
  await new Promise((resolve, reject) => {
    const script = existing || document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.wayfareClerkSrc = src;
    Object.entries(attributes).forEach(([name, value]) => script.setAttribute(name, value));
    script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
    script.onerror = () => reject(new Error('Failed to load Clerk authentication components.'));
    if (!existing) document.head.appendChild(script);
  });
}

async function loadClerk(publishableKey) {
  const encodedFrontendApi = publishableKey.split('_')[2];
  if (!encodedFrontendApi) throw new Error('Clerk publishable key is invalid.');
  const frontendApi = atob(encodedFrontendApi).slice(0, -1);
  await loadClerkScript(`https://${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await loadClerkScript(`https://${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
    'data-clerk-publishable-key': publishableKey
  });
  if (!window.__internal_ClerkUICtor) throw new Error('Clerk UI components did not initialize.');
  if (!window.Clerk) throw new Error('Clerk JavaScript SDK did not initialize.');
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  return window.Clerk;
}

export async function initializeIntegrations(onAuthChange = () => {}) {
  const tasks = [];
  if (configured.auth) {
    try {
    clerk = await loadClerk(settings.clerkPublishableKey);
    clerk.addListener(() => onAuthChange(clerk.user));
    onAuthChange(clerk.user);
    } catch (error) { clerkInitializationError = error; tasks.push(Promise.reject(error)); }
  }
  if (configured.database) tasks.push((async () => {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(settings.supabaseUrl, settings.supabasePublishableKey, {
      accessToken: async () => clerk?.session ? await clerk.session.getToken() : null
    });
  })());
  if (configured.maps) tasks.push(loadMaps());
  const results = await Promise.allSettled(tasks);
  results.filter(result => result.status === 'rejected').forEach(result => console.error('Wayfare integration failed:', result.reason));
  return results;
}

export function currentUser() { return clerk?.user || null; }
export async function toggleAuthentication() {
  if (!configured.auth) return false;
  if (!clerk) throw clerkInitializationError || new Error('Clerk is still initializing. Refresh the page and try again.');
  if (clerk.user) await clerk.signOut();
  else await clerk.openSignIn();
  return true;
}
export async function openAccountManagement() {
  if (!configured.auth) return;
  if (!clerk) throw clerkInitializationError || new Error('Clerk is still initializing. Refresh the page and try again.');
  if (!clerk.user) { await clerk.openSignIn(); return; }
  await clerk.openUserProfile();
}

export function watchDriverLocation(rideId, onError = () => {}) {
  if (!navigator.geolocation) { onError(new Error('This browser does not support GPS location.')); return null; }
  let lastSent = 0;
  return navigator.geolocation.watchPosition(position => {
    if (Date.now() - lastSent < 5000) return;
    lastSent = Date.now();
    publishDriverLocation(rideId, position.coords).catch(onError);
  }, onError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
}

export function subscribeToSos(rideId, onSos) {
  if (!supabase || !rideId) return () => {};
  const channel = supabase.channel(`sos-${rideId}`).on('postgres_changes', {
    event: 'INSERT', schema: 'public', table: 'sos_events', filter: `ride_id=eq.${rideId}`
  }, payload => onSos(payload.new)).subscribe();
  return () => supabase.removeChannel(channel);
}

async function loadMaps() {
  await new Promise((resolve, reject) => {
    if (window.google?.maps?.importLibrary) return resolve();
    const callback = `wayfareMapsReady_${Date.now()}`;
    window[callback] = resolve;
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(settings.googleMapsApiKey)}&v=weekly&loading=async&callback=${callback}`;
    script.async = true;
    script.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.append(script);
  });
  const [mapsLib, placesLib, routesLib] = await Promise.all([
    google.maps.importLibrary('maps'), google.maps.importLibrary('places'), google.maps.importLibrary('routes')
  ]);
  maps = new mapsLib.Map(document.getElementById('googleMap'), {
    center: { lat: 12.9716, lng: 77.5946 }, zoom: 12, mapId: 'DEMO_MAP_ID',
    mapTypeControl: false, streetViewControl: false, fullscreenControl: false
  });
  places = placesLib;
  directions = routesLib;
  document.getElementById('mapCanvas').classList.add('has-google-map');
}

export async function suggestPlaces(input) {
  if (!places || input.trim().length < 3) return [];
  placesSession ||= new places.AutocompleteSessionToken();
  const { suggestions = [] } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
    input, sessionToken: placesSession,
    locationBias: { center: { lat: 12.9716, lng: 77.5946 }, radius: 50000 }
  });
  return suggestions.filter(item => item.placePrediction).slice(0, 5);
}

export async function selectPlace(prediction) {
  const place = prediction.toPlace();
  await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
  placesSession = null;
  return { label: place.formattedAddress || place.displayName, name: place.displayName, lat: place.location?.lat(), lng: place.location?.lng(), placeId: place.id };
}

export async function routeBetween(origin, destination, stops = []) {
  if (!directions || !origin || !destination || origin.lat == null || destination.lat == null) return null;
  const { routes } = await directions.Route.computeRoutes({
    origin: { lat: origin.lat, lng: origin.lng },
    destination: { lat: destination.lat, lng: destination.lng },
    intermediates: stops.filter(stop => stop?.lat != null && stop?.lng != null).map(stop => ({ location: { lat: stop.lat, lng: stop.lng } })),
    travelMode: 'DRIVING', fields: ['distanceMeters', 'durationMillis', 'path']
  });
  const route = routes?.[0];
  if (!route) return null;
  if (routeLine) routeLine.setMap(null);
  routeLine = new google.maps.Polyline({ path: route.path, strokeColor: '#5944ee', strokeWeight: 5, map: maps });
  const bounds = new google.maps.LatLngBounds();
  route.path.forEach(point => bounds.extend(point));
  maps.fitBounds(bounds, 52);
  return { km: route.distanceMeters / 1000, minutes: Math.round(route.durationMillis / 60000) };
}

export function updateDriverMarker(position) {
  if (!maps || !window.google?.maps?.Marker) return;
  const point = { lat: position.lat, lng: position.lng };
  if (!driverMarker) driverMarker = new google.maps.Marker({ map: maps, position: point, title: 'Your driver', label: '🚕' });
  else driverMarker.setPosition(point);
  maps.panTo(point);
}

export async function publishDriverLocation(rideId, coords) {
  if (!supabase || !clerk?.user) throw new Error('Sign in and connect Supabase to share live location.');
  const { error } = await supabase.from('ride_locations').upsert({
    ride_id: rideId, driver_id: clerk.user.id, lat: coords.latitude, lng: coords.longitude,
    heading: coords.heading, speed: coords.speed, updated_at: new Date().toISOString()
  }, { onConflict: 'ride_id' });
  if (error) throw error;
}

export async function sendSos(rideId, coords) {
  if (!supabase || !clerk?.user) throw new Error('Sign in and connect Supabase to alert your driver.');
  const { error } = await supabase.from('sos_events').insert({
    rider_id: clerk.user.id, ride_id: rideId || null,
    lat: coords?.latitude ?? null, lng: coords?.longitude ?? null
  });
  if (error) throw error;
}

export async function createRide(ride) {
  if (!supabase || !clerk?.user) return { demo: true };
  const { data, error } = await supabase.rpc('request_ride', {
    p_pickup: ride.pickup, p_destination: ride.destination,
    p_pickup_lat: ride.pickupPlace?.lat ?? null, p_pickup_lng: ride.pickupPlace?.lng ?? null,
    p_destination_lat: ride.destinationPlace?.lat ?? null, p_destination_lng: ride.destinationPlace?.lng ?? null,
    p_stops: ride.stops || [], p_ride_type: ride.ride, p_distance_km: ride.distanceKm,
    p_scheduled_for: ride.scheduledFor || null, p_payment_method: ride.payment || 'Cash', p_promo_code: ride.promo || null
  });
  if (error) throw error;
  return { demo: false, ride: Array.isArray(data) ? data[0] : data };
}

export async function validatePromoCode(code) {
  const normalized = code.trim().toUpperCase();
  if (supabase) {
    const { data, error } = await supabase.from('promo_codes').select('discount_amount').eq('code', normalized).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (clerk?.user) {
      const { data: used, error: usedError } = await supabase.from('promo_redemptions').select('ride_id').eq('code', normalized).eq('rider_id', clerk.user.id).maybeSingle();
      if (usedError) throw usedError;
      if (used) return null;
    }
    return Number(data.discount_amount);
  }
  return normalized === 'WAYFARE150' ? 150 : null;
}

export async function saveReview(rideId, rating, review) {
  if (!supabase || !rideId) return;
  const { error } = await supabase.from('ride_reviews').insert({ ride_id: rideId, rating, review: review || null });
  if (error) throw error;
}

export async function getRideHistory() {
  if (!supabase || !clerk?.user) return null;
  const { data, error } = await supabase.from('rides').select('*, ride_reviews(rating,review), payments(status,amount,currency)').order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return data;
}

export async function getDriverQueue() {
  if (!supabase || !clerk?.user) return [];
  const [{ data, error }, { data: declined, error: declineError }] = await Promise.all([
    supabase.from('rides').select('*').eq('status', 'requested').order('created_at').limit(30),
    supabase.from('ride_declines').select('ride_id').eq('driver_id', clerk.user.id)
  ]);
  if (error) throw error;
  if (declineError) throw declineError;
  const ignored = new Set((declined || []).map(row => row.ride_id));
  return data.filter(row => !ignored.has(row.id));
}

export async function acceptRide(id) {
  if (!supabase || !clerk?.user) throw new Error('Driver sign-in is required.');
  const { data, error } = await supabase.rpc('accept_ride', { p_ride_id: id, p_driver_name: clerk.user.fullName || 'Wayfare driver' });
  if (error) throw error;
  const ride = Array.isArray(data) ? data[0] : data;
  if (!ride) throw new Error('Another driver accepted that ride first.');
  return ride;
}

export async function getAssignedRides() {
  if (!supabase || !clerk?.user) return [];
  const { data, error } = await supabase.from('rides').select('*').eq('driver_id', clerk.user.id).in('status', ['accepted','driver_arriving','in_progress']).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getDriverStats() {
  if (!supabase || !clerk?.user) return { trips: 0, fareTotal: 0, averageRating: null };
  const { data, error } = await supabase.from('rides').select('fare_estimate,ride_reviews(rating)').eq('driver_id', clerk.user.id).eq('status', 'completed');
  if (error) throw error;
  const ratings = data.flatMap(ride => Array.isArray(ride.ride_reviews) ? ride.ride_reviews : ride.ride_reviews ? [ride.ride_reviews] : []).map(review => review.rating);
  return { trips: data.length, fareTotal: data.reduce((total, ride) => total + Number(ride.fare_estimate || 0), 0), averageRating: ratings.length ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length : null };
}

export async function updateDriverRide(id, status) {
  if (!supabase || !['driver_arriving','in_progress','completed'].includes(status)) throw new Error('Invalid ride status.');
  const { data, error } = await supabase.rpc('update_assigned_ride_status', { p_ride_id: id, p_status: status });
  if (error) throw error;
  if (!data?.length) throw new Error('That status change is not allowed for this trip.');
}

export async function createSupportTicket(subject, message) {
  if (!supabase || !clerk?.user) throw new Error('Sign in and connect the database to send a support request.');
  const { error } = await supabase.from('support_tickets').insert({ rider_id: clerk.user.id, subject, message });
  if (error) throw error;
}

export async function declineRide(id) {
  if (!supabase) throw new Error('Database is not configured.');
  const { error } = await supabase.from('ride_declines').insert({ ride_id: id, driver_id: clerk.user.id });
  if (error) throw error;
}

export async function cancelRide(id) {
  if (!supabase || !id) return;
  const { data, error } = await supabase.rpc('cancel_ride', { p_ride_id: id });
  if (error) throw error;
  if (!data?.length) throw new Error('This trip can no longer be cancelled from the rider account.');
}

export async function finishRide(id, rating, review) {
  if (!supabase || !id) return;
  await saveReview(id, rating, review);
}

export async function makePaymentSession(rideId) {
  if (!settings.apiBaseUrl || !clerk?.session) throw new Error('Secure payment backend is not configured.');
  const token = await clerk.session.getToken();
  const response = await fetch(`${settings.apiBaseUrl.replace(/\/$/, '')}/api/payments/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ rideId })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not start secure checkout.');
  return data;
}

export async function verifyRazorpayPayment(rideId, paymentResponse) {
  if (!settings.apiBaseUrl || !clerk?.session) throw new Error('Secure payment backend is not configured.');
  const token = await clerk.session.getToken();
  const response = await fetch(`${settings.apiBaseUrl.replace(/\/$/, '')}/api/payments/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ rideId, ...paymentResponse })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not verify the Razorpay payment.');
  return data;
}

export function subscribeToRide(id, onChange, onLocation = () => {}) {
  if (!supabase || !id) return () => {};
  const channel = supabase.channel(`ride-${id}`).on('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'rides', filter: `id=eq.${id}`
  }, payload => onChange(payload.new)).on('postgres_changes', {
    event: '*', schema: 'public', table: 'ride_locations', filter: `ride_id=eq.${id}`
  }, payload => onLocation(payload.new)).subscribe();
  return () => supabase.removeChannel(channel);
}

export async function getRideLocation(id) {
  if (!supabase || !id) return null;
  const { data, error } = await supabase.from('ride_locations').select('*').eq('ride_id', id).maybeSingle();
  if (error) throw error;
  return data;
}
