# Roster Sync — setup

Roster Sync is a static web app. It runs entirely in your browser, reads WebCIS exports from a Google Drive folder, and syncs a dedicated Google Calendar. There is no server, no billing account and no running cost.

You do two one-time setups, about 15 minutes in total:

1. Host the app on GitHub Pages (free).
2. Create a Google Cloud project that gives the app permission to read Drive and write Calendar (free, no card).

---

## 1. Host the app on GitHub Pages

1. Create a free account at https://github.com if you don't have one.
2. Click **New repository**. Name it `roster-sync`, set it to **Public**, and tick **Add a README file**. Click **Create repository**.
   Free GitHub Pages needs a public repository. Only the app code goes here. Your roster files never do: they stay in your Drive and your browser.
3. In the repository, click **Add file → Upload files**. Drag in every file from this folder:
   `index.html`, `app.js`, `core.js`, `app.css`, `sw.js`, `manifest.webmanifest`, `icon.svg`.
   Click **Commit changes**.
4. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, the branch to **main** and the folder to **/ (root)**. Click **Save**.
5. After a minute the page shows your address, e.g. `https://YOURNAME.github.io/roster-sync/`. Keep it handy.

## 2. Create the Google Cloud project

1. Go to https://console.cloud.google.com and sign in with the Google account whose Calendar and Drive you'll use.
2. Use the project picker at the top to create a **New project** called `Roster Sync`. Don't add a billing account; none is needed.
3. Open **APIs & Services → Library**. Search for and **Enable** both:
   - **Google Calendar API**
   - **Google Drive API**
4. Open **Google Auth Platform** (also listed as **OAuth consent screen**) and click **Get started**:
   - App name: `Roster Sync`. Support email: your address.
   - Audience: **External**.
   - Contact email: your address. Agree to the policy and click **Create**.
5. In **Audience**, under **Test users**, click **Add users** and add your own Gmail address. Leave the app in **Testing**; don't publish it.
6. In **Clients**, click **Create client**:
   - Application type: **Web application**. Name: `Roster Sync web`.
   - **Authorized JavaScript origins**: add `https://YOURNAME.github.io` (no path, no trailing slash).
   - Leave redirect URIs empty. Click **Create**.
7. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). It isn't a secret.

## 3. Tell the app your client ID

Pick one:

- **Every device at once (recommended):** on GitHub, open `index.html`, click the pencil icon, and paste the ID between the quotes in `clientId: ''`. Commit. Pages updates within a minute.
- **Per device:** open the app, go to **Settings**, and paste it into **Google OAuth client ID**.

## 4. Set up the WebCIS folder

1. In Google Drive, create a folder, e.g. `WebCIS Rosters`.
2. Open it and copy its link from the address bar (`https://drive.google.com/drive/folders/…`).
3. In the app, go to **Settings** and paste the link into **WebCIS folder in Google Drive**. Do this once per device.

## 5. First run

1. Open the app and tap **Sync → Connect Google**.
2. Google shows **"Google hasn't verified this app"**. This is expected for a personal app in testing. Tap **Continue**.
3. Tick **both** permissions (Drive read-only and Calendar) and continue.
4. Tap **Check Drive now**. The app downloads exports from the past 12 months of bid periods.
5. On **Sync**, pick a bid period and tap **Check what will change**, then **Apply**. The app creates a calendar called **Qantas Roster** and fills it.

**Install it:** on iPhone or iPad, open the address in Safari, tap **Share → Add to Home Screen**. On a laptop in Chrome or Edge, use the install icon in the address bar.

---

## Day to day

- **Save each WebCIS export into the Drive folder.** On iPhone/iPad, use **Share → Save to Files → Google Drive → WebCIS Rosters** (the Drive app must be installed). On a laptop, save it to the folder in Google Drive for desktop, or upload it at drive.google.com.
- **Open the app and tap Check Drive.** Google sign-in sessions last about an hour, so expect a quick sign-in popup each time you open the app.
- **Review the changes,** then **Sync → Check what will change → Apply.**
- **No Drive or connection?** You can drop or pick export files directly on the **Sync** tab. Rosters already loaded stay viewable offline.

## How the calendar is kept tidy

- Everything goes into the separate **Qantas Roster** calendar. Your other calendars are never read or changed.
- Every event carries hidden tags: staff number, bid period and a duty key.
- A sync compares the latest export with what's already in the calendar. It then adds, updates or removes only what differs, so events keep their identity and you don't get a flood of notifications.
- Only current and future bid periods can be synced. Past periods stay as they are.
- Each flight is a timed event from its **report time to its sign-off** (sign-off = arrival + 30 min), built from the export's UTC times, so it shows correctly in any time zone, including daylight saving in Australia and New Zealand. Departure and arrival times are in the description.
- Standby duties (SR, S/, /S, SS and upline ESxx) are timed events too.
- The reminder is set before each flight's report time and each standby's start.
- Each day also gets one all-day entry, with colours matching the app:

| Day | Calendar colour |
|---|---|
| Trip day, e.g. "CEI04 · Day 2/3 · MEL layover" | Peacock (light blue) |
| Flight duty, e.g. "✈ QF36 SIN–MEL · CEI04" | Blueberry (dark blue) |
| Available day (A) | Tangerine |
| Standby (SR, S/, /S, SS, ESxx) | Banana |
| Day off (X, RX) | Sage |
| Reserve block start (R-) | Graphite |
| Leave (AL, SL, US, UL, CHL, SPL, DL, LWOP) | Lavender |
| Failed obligation (UN) | Tomato |

To start over, delete the **Qantas Roster** calendar in Google Calendar settings. The app creates a fresh one on the next sync.

## Cost and limits

- **Cost:** GitHub Pages, Google Cloud (Calendar and Drive APIs at personal volume) and the OAuth client are all free. No billing account is attached, so nothing can be charged.
- **Testing mode:** you can keep the app in Testing forever. It works only for the Google accounts listed as test users (up to 100).
- **Drive access** is read-only.

## Assumptions to keep in mind

- **Bid period year:** taken from the export date. A December export of a January bid period rolls to the next year, and so do dates that cross 31 December.
- **"P" sector flag:** shown as positioning. Confirm this matches WebCIS.
- **Unknown duty codes:** anything other than A, X, R- or a pattern code is shown in purple and flagged on screen. Send a sample so it can be named properly.
- **Unnotified duties:** if an export lists any, the app warns you. They aren't interpreted yet because no sample has shown one.
