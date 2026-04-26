# Deploy to Render + MongoDB Atlas (FREE)

## STEP 1 — MongoDB Atlas (database)

1. Go to https://mongodb.com/atlas → Sign up free
2. Create a FREE cluster (M0 Sandbox — 512MB free forever)
3. Under Security → Database Access → Add user:
   - Username: `reclub`
   - Password: (generate a strong one, save it!)
   - Role: Read and write to any database
4. Under Security → Network Access → Add IP: `0.0.0.0/0` (allow all)
5. Click your cluster → Connect → Drivers → copy the connection string:
   `mongodb+srv://reclub:<password>@cluster0.xxxxx.mongodb.net/reclub`
   Replace `<password>` with your actual password.

## STEP 2 — GitHub (code hosting)

1. Go to https://github.com → Sign up free
2. New Repository → name: `bangi-picklers` → Public → Create
3. On your computer, open terminal in your reclub-local folder:

```
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/bangi-picklers.git
git push -u origin main
```

## STEP 3 — Render (hosting)

1. Go to https://render.com → Sign up with GitHub (free)
2. New → Web Service → Connect your `bangi-picklers` repo
3. Settings:
   - Name: `bangi-picklers`
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Under Environment Variables → Add:
   - Key: `MONGO_URI`
   - Value: (paste your MongoDB connection string from Step 1)
5. Click Deploy!
6. After deploy → copy your URL: `https://bangi-picklers.onrender.com`

## STEP 4 — First login

- Open your URL
- Login: username `admin`, password `admin123`
- Go to Settings → User Management → change admin password!
- Add viewer accounts for your players

## Notes

- Free Render plan sleeps after 15 mins inactivity (takes ~30s to wake up)
- Upgrade to Render Starter ($7/mo) for always-on
- MongoDB Atlas free tier is 512MB — plenty for this app
- Your data is safe in MongoDB even if Render restarts

## Local development

```
node server.js
```
Uses local JSON files in data/ folder (no MongoDB needed locally)
