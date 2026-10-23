# ForkScore: live shared reviews

Reviews are now saved on a small server, so **every visitor sees the same reviews, and new ones appear on everyone's screen instantly** (no refresh needed).

## Files

| File | What it is |
| --- | --- |
| `server.js` | The server. Saves reviews and pushes new ones to every open browser. |
| `package.json` | Lets you start it with `npm start`. |
| `index.html`, `style.css`, `script.js` | The website. |
| `restaurants-by-country.js`, `restaurant-photos.js` | The restaurant list and the photos. |

Keep all of them in **one folder**. Nothing needs installing except [Node.js](https://nodejs.org) 18 or newer (the server uses no extra packages).

## Run it on your computer

```
cd your-forkscore-folder
npm start
```

Open **http://localhost:3000**. The terminal also prints a "Wi-Fi" address. Open that on your phone (same Wi-Fi) to see two devices updating each other live.

Reviews are stored in `data/reviews.json`, created automatically.

> Don't open `index.html` by double-clicking it. The site then runs in an **offline demo** (reviews stay in that one browser). The status badge in the "Latest reviews" section tells you which mode you are in: green **Live** is the real thing.

## Put it online so other people can use it

You need a host that runs Node.js (Render, Railway, Fly.io, a VPS...). On Render, for example:

1. Put the folder in a GitHub repository.
2. New **Web Service** → pick the repository.
3. Build command: leave empty. Start command: `npm start`.
4. Add environment variables:
   - `TRUST_PROXY` = `1`  (so the spam limit sees each visitor's real address)
   - `ADMIN_KEY` = a long secret only you know (turns on review removal)
5. **Keep reviews permanently:** many free plans wipe the disk whenever the app restarts, which would delete all reviews. Add a persistent disk (on Render: *Disks*, mounted at `/data`) and set `DATA_DIR` = `/data`. If your host can't do that, ask me to switch storage to a hosted database.

Plain static hosts (GitHub Pages, Netlify drop, etc.) **cannot** do live reviews because they can't run `server.js`.

## Removing a bad review

Find the review's `id` (open `https://your-site/api/reviews`), then:

```
curl -X DELETE https://your-site/api/reviews/THE-ID -H "x-admin-key: YOUR_ADMIN_KEY"
```

It disappears from everyone's screen straight away and ratings update.

## Built-in protection

- Reviews are checked on the server (rating 1 to 5, length limits), and shown as plain text, so nobody can inject code.
- Each visitor can post 5 reviews a minute; exact duplicates are blocked.
- Only the website files are served. `server.js` and `data/` stay private.
- There are no accounts: anyone can post under any name. If you get spam, ask me to add sign-in or a "report review" button.
