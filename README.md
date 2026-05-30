# Bar Picker 🍺

Real-time bar elimination game. Create a room, share the link, and eliminate bars together until one remains.

## Run locally

```bash
npm install
npm start
```
Open http://localhost:3000

## Deploy free (Railway)

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Railway auto-detects Node.js and runs `npm start`
4. Your app gets a public URL — share it with friends!

## Deploy free (Render)

1. Push to GitHub
2. Go to render.com → New Web Service → connect repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Done!

## How it works

- One person creates a room, gets a 5-letter code
- Share the URL (it includes the room code) with friends
- Everyone adds bars to the list
- Tap ✕ to eliminate a bar — everyone sees it instantly
- Last bar standing wins
