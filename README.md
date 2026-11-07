# wayfare — Cab Booking App

A responsive ride-booking MVP inspired by the attached cab-booking project brief. The interface is designed as a polished, self-contained web prototype so it can be opened locally or published as a static GitHub Pages site.

## Run it

Open `index.html` in a current browser. There is no build step, package install, API key, or server required.

For local development, an optional static server can be used:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000` from this folder.

## What is included

- Responsive rider booking screen with pickup, destination suggestions, ride categories, and estimated fares in INR
- Ride now and scheduled pickup choices, payment preference, and a working sample promo code (`WAYFARE150`)
- Booking confirmation, simulated driver matching, trip status, cancel flow, and demo ride completion
- Ride history, a driver rating prompt, profile editing, help and safety information, and an invite code
- A custom illustrated Bengaluru map preview and mobile navigation
- Local browser storage for demo trip and preference state

## Demo behavior and production work

This is a front-end MVP. Booking state and trip data live in the current browser only. Map art, nearby drivers, pickup times, fares, payments, authentication, driver matching, and trip status are illustrative demo behavior. The app does not charge money, collect credentials, contact drivers, or send emergency alerts.

The project brief calls for a production backend, rider and driver accounts, persistent rides and payments, Google Maps routing and tracking, real-time updates, receipts, and reviews. Those integrations need service accounts, secure server endpoints, a database, and deployment configuration. No secrets or live service credentials are included in this repository.

## Publish on GitHub Pages

1. Create a new GitHub repository, for example `wayfare-cab-booking`.
2. Add the files from this folder to the repository root and commit them.
3. In the repository, open **Settings → Pages**, select **Deploy from a branch**, choose `main` and `/(root)`, then save.
4. After GitHub Pages finishes publishing, paste the repository URL (`https://github.com/your-name/wayfare-cab-booking`) into the Sclaria submission field shown in the screenshot. Use the Pages URL as a demo link if the form asks for one.

If your GitHub account is not configured in Git locally, you can upload these files through GitHub's web interface instead.
