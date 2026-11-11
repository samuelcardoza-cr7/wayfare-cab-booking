# Wayfare — Cab Booking App

Responsive cab-booking project based on the supplied **Cab Booking App Project Overview**. It keeps the Wayfare interface and supports a local demo mode; optional Clerk, Supabase, and Google Maps integrations enable authenticated riders/drivers, persistent ride requests/history/reviews/support requests, driver accept/decline and trip status, live rider status, location search, route distance, and map display.

## Run and inspect the site

The browser modules need an HTTP origin. From this folder run:

```bash
python -m http.server 8000
```

Open `http://localhost:8000`. With no `config.js`, the app stays in demo mode. Demo bookings and matching are illustrative and stored in the current browser only; trip history starts empty.

The demo lets you try booking with up to three stops, apply `WAYFARE150`, accept the current request from **Driver preview**, complete the trip, leave a rating/review, edit demo profile fields, and download a trip summary. Demo credentials, driver assignment, GPS, and payment are not real.

## Configure the requested services

1. Copy `config.example.js` to `config.js` and add the **publishable/browser** keys only. `config.js` is ignored by Git.
2. Create a Clerk application. Set the allowed development origin to `http://localhost:8000`, enable email/password sign-up and the contact verification methods you plan to use, optionally enable Google/social login, and copy its publishable key into `clerkPublishableKey`. The app's **Sign in / sign up** button opens Clerk's account flow.
3. Create a Supabase project. Connect Clerk in Supabase **Authentication → Third-Party Auth**, then run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL Editor for a new database. If you already ran the older Wayfare schema, run [`supabase/razorpay-migration.sql`](supabase/razorpay-migration.sql) instead; it retains existing ride and payment records while adding Razorpay order fields. Add the project URL and publishable key to `config.js`. In Supabase Database → Publications, enable `rides`, `ride_locations`, and `sos_events` for Postgres Changes.
4. If you use driver accounts, set the Clerk user's public metadata role to `driver` and configure Clerk's session token to include a `user_role` claim copied from that metadata. The SQL policies check this claim before exposing open requests or allowing driver status updates. Only provision trusted driver accounts.
5. In Google Cloud, enable Maps JavaScript API, Places API, Places API (New), and Routes API; create a browser key restricted to the local/deployed website origins and those APIs. Set it as `googleMapsApiKey`.
6. Serve the app over HTTPS in production and add the production origin in Clerk, Google Cloud key restrictions, and any CORS allow-list.

Clerk JWT third-party auth must be configured in Supabase for the browser database calls to pass row-level security. Configure Clerk sign-up for the email/password and phone/social sign-in methods you want to offer; the Clerk screen provides registration and verification. The SQL scopes rider reads/writes to the Clerk `sub` claim. It creates rides, promo codes, reviews, support tickets, live GPS records, SOS alerts, and payment records. Never put a Supabase service-role key, Clerk secret key, or Razorpay key secret in `config.js` or any browser file.

### Razorpay test checkout API

The Express API in `api/` creates a Razorpay order only for the signed-in rider's completed trip. Razorpay Checkout opens over the app; the API verifies the checkout signature and fetches the payment status from Razorpay before updating Supabase. The signed webhook endpoint provides an additional status update path.

1. In Razorpay Dashboard, switch to **Test Mode** and create test API credentials. In the `api` folder, copy `.env.example` to `.env`, then set `CLERK_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_ID`, and `RAZORPAY_KEY_SECRET`. Keep `.env` private. The webhook secret is optional for local checkout verification but recommended for deployed payment status updates.
2. Run `npm install` and `npm run dev` inside `api/`. The API listens on `http://localhost:4242` by default.
3. Set `apiBaseUrl: "http://localhost:4242"` in the ignored frontend `config.js`. For webhooks, expose the API through an HTTPS tunnel for development or deploy it, then add `<your-https-api-origin>/api/razorpay/webhook` in Razorpay Dashboard and set its webhook secret as `RAZORPAY_WEBHOOK_SECRET`. Subscribe to `payment.captured`, `payment.failed`, and `order.paid`.
4. Use only Razorpay test credentials while developing. Test payments are simulated and do not move real money. Razorpay's Checkout methods depend on the methods enabled for the merchant account. Live collections require the applicable merchant activation. See [Razorpay test integration](https://razorpay.com/docs/server-integration/python/test-app/) and [webhook setup](https://razorpay.com/docs/webhooks/).

### Payment gateway limitation for this submission

Stripe could not be used for this India-based project because Stripe payment processing is not available for the intended setup in India. Razorpay Checkout has been integrated in the project code, but I could not activate a Razorpay merchant account because I do not have a business PAN. As a result, online payments are not available for a live demonstration; Razorpay checkout requires an eligible, activated merchant account and configured credentials. The payment flow can be reviewed in the source, while ride booking and fare estimates can be demonstrated without processing a real payment.

## Requirements map

| Brief requirement | Project status |
| --- | --- |
| Rider sign-up/sign-in and profile | Clerk account creation, credential/social sign-in, and verified contact settings are enabled when configured. The profile screen opens Clerk's account manager. Enable email/password, phone, and any social providers in the Clerk dashboard. |
| Pickup/drop-off and fare estimate | Google Places suggestions and Google Routes distance drive the pre-booking fare. The displayed peak-hour/weekend demand factor is a transparent time-based course-project estimate, not a live supply/demand feed. Without selected Google place suggestions, the shown distance is illustrative. |
| Driver dashboard, accept/decline, assignment | Dashboard, atomic ride acceptance, decline, status changes, completed fare total, and rider rating summary are wired to Supabase for provisioned Clerk driver accounts. Driver onboarding and live dispatch operations need production hardening. |
| Live ride location, ETA, notifications | Driver browser GPS publishes live coordinates while the driver dashboard is open; Supabase Realtime updates the rider's Google map marker, route, and Google Routes ETA. In-app status notices appear for acceptance, arrival, ride start, and completion. GPS requires an HTTPS deployment (localhost works for development); background tracking and push notifications need deployment work. |
| Razorpay payments and driver earnings | Razorpay Checkout integration is present: the backend creates INR orders, verifies signatures, checks payment status, and processes signed webhooks. Live checkout is not activated for this submission because Razorpay merchant activation requires business details including a business PAN, which I do not have. Stripe was not used because it is unavailable for the intended India-based setup. Driver dashboard displays completed fare totals; it does not calculate platform commission or payouts. |
| Ride history, payment records, cancellation, reviews | Ride history, ratings/reviews, and payment status use Supabase when configured; a CSV trip/payment summary is downloadable. Cancellation is persisted with a zero fee until a real fee rule is configured. |
| Multi-stop, promos, SOS, support tickets | A visible booking control adds up to three Google Places stops; Google Routes includes them in the distance, fare, and route line. `WAYFARE150` is seeded as a one-time ₹150 database offer. Live SOS records the rider's coordinates for the assigned driver's open dashboard, with a direct 112 call link; it does not dispatch emergency services or contact a trusted person automatically. Support requests save to Supabase, but need an operator workflow. |
| Responsive UI, security, deploy, testing | Responsive interface and rider row policies are included. Production security review, end-to-end tests, and deployment remain setup work. |

This is a course-project implementation starter, not a staffed transportation service. Real rider sign-up, database persistence, maps, driver location, and SOS-to-driver alerts are available only after service setup. Razorpay code is included, but merchant activation is unavailable to me without a business PAN; Stripe was not an option for the intended India-based setup. Do not treat an in-app SOS as emergency dispatch. The brief lists possible stack choices; this project currently uses HTML/CSS/JavaScript plus a separate Node/Express payment API rather than claiming it is a Next.js + Tailwind application.

## Submission

The latest code is in this local project folder. Publish the latest commit to GitHub before using the repository URL as a submission link. The screenshot shows a “Responsive Website Project” field while the supplied brief is for a cab-booking app; confirm the assignment accepts this brief before submitting. No submission has been made.
