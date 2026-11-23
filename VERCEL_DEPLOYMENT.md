# Deploy to Vercel (Free) - Complete Guide

This guide shows you how to deploy both **frontend** and **backend** on Vercel's free tier.

## 📋 Prerequisites

- GitHub account (or GitLab/Bitbucket)
- Vercel account (sign up free at [vercel.com](https://vercel.com))
- Your code pushed to a Git repository

## 🚀 Deployment Steps

### Step 1: Push Code to GitHub

If you haven't already:

```bash
# Initialize git (if not done)
git init
git add .
git commit -m "Initial commit"

# Create a new repository on GitHub, then:
git remote add origin https://github.com/yourusername/your-repo.git
git branch -M main
git push -u origin main
```

---

## 🎨 Part 1: Deploy Frontend

### 1. Go to Vercel Dashboard
- Visit [vercel.com](https://vercel.com)
- Sign in with GitHub
- Click **"Add New Project"**

### 2. Import Repository
- Select your repository from the list
- Click **"Import"**

### 3. Configure Project Settings
Set these values:

- **Project Name**: `companyuser-frontend` (or any name you like)
- **Framework Preset**: Next.js (auto-detected)
- **Root Directory**: `frontend` ⚠️ **IMPORTANT**
- **Build Command**: `npm run build` (default)
- **Output Directory**: `.next` (default)
- **Install Command**: `npm install` (default)

### 4. Add Environment Variables
Click **"Environment Variables"** and add:

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_API_URL` | Leave blank for now, we'll update this after backend deployment |

### 5. Deploy
- Click **"Deploy"**
- Wait 2-3 minutes for build to complete
- You'll get a URL like: `https://companyuser-frontend.vercel.app`

✅ **Frontend deployed!** But it won't work yet because the API isn't deployed.

---

## ⚙️ Part 2: Deploy Backend

### 1. Create New Project
- Go back to Vercel dashboard
- Click **"Add New Project"** again
- Select the **same repository**

### 2. Configure Backend Project
Set these values:

- **Project Name**: `companyuser-backend` (or any name you like)
- **Framework Preset**: Other
- **Root Directory**: `backend` ⚠️ **IMPORTANT**
- **Build Command**: Leave empty
- **Output Directory**: Leave empty
- **Install Command**: Leave empty

### 3. Add Environment Variables
Click **"Environment Variables"** and add these:

| Name | Value | Where to find it |
|------|-------|------------------|
| `PORT` | `8080` | Default |
| `JWT_SECRET` | Your secure secret (32+ chars) | Same value as `backend/.env` |
| `DATABASE_URL` | Your PostgreSQL connection string | From your database host |

Example: `postgresql://user:password@db.example.com:5432/dbname?sslmode=require`

Serverless functions open many short-lived connections; if your Postgres host offers a connection pooler, use its URL here and keep `DB_MAX_CONNS` unset (1).

### 4. Deploy Backend
- Click **"Deploy"**
- Wait 2-3 minutes
- You'll get a URL like: `https://companyuser-backend.vercel.app`

✅ **Backend deployed!**

---

## 🔗 Part 3: Connect Frontend to Backend

### 1. Update Frontend Environment Variable
- Go to your **frontend project** in Vercel
- Click **Settings** → **Environment Variables**
- Find `NEXT_PUBLIC_API_URL`
- Set value to your backend URL: `https://companyuser-backend.vercel.app`
- Click **Save**

### 2. Redeploy Frontend
- Go to **Deployments** tab
- Click the **three dots** on the latest deployment
- Click **"Redeploy"**
- Wait for redeployment to complete

---

## ✅ Part 4: Test Your Deployment

### 1. Test Backend Health
Visit: `https://companyuser-backend.vercel.app/health`

You should see:
```json
{"status": "ok"}
```

### 2. Test Frontend
Visit: `https://companyuser-frontend.vercel.app`

You should see your login page!

### 3. Test Login
Try logging in with an existing user's email and password.

---

## 🎯 Important Notes

### CORS Configuration
Your backend is already configured to accept requests from any origin (`AllowOrigins: "*"`). For production, you should update this in `main.go` and `api/index.go`:

```go
app.Use(cors.New(cors.Config{
    AllowOrigins: "https://companyuser-frontend.vercel.app",
    AllowHeaders: "Origin, Content-Type, Accept, Authorization",
    AllowMethods: "GET,POST,PUT,DELETE,OPTIONS",
}))
```

Then redeploy the backend.

### Free Tier Limits
Vercel free tier includes:
- ✅ Unlimited deployments
- ✅ 100GB bandwidth/month
- ✅ Automatic HTTPS
- ✅ Serverless functions (10 second timeout)
- ✅ Custom domains

### Cold Starts
Serverless functions may have a 1-2 second delay on first request (cold start). This is normal for free tier.

---

## 🔄 Continuous Deployment

Both projects are now set up for automatic deployment:
1. Push changes to your GitHub repository
2. Vercel automatically detects changes
3. Builds and deploys new version
4. Zero downtime!

---

## 🌐 Custom Domain (Optional)

### For Frontend:
1. Go to frontend project → **Settings** → **Domains**
2. Add your domain (e.g., `app.yourdomain.com`)
3. Update DNS records as instructed by Vercel

### For Backend:
1. Go to backend project → **Settings** → **Domains**
2. Add your domain (e.g., `api.yourdomain.com`)
3. Update DNS records
4. Update `NEXT_PUBLIC_API_URL` in frontend to use new domain

---

## 🐛 Troubleshooting

### Frontend build fails
- Check that Root Directory is set to `frontend`
- Verify all environment variables are set
- Check build logs for specific errors

### Backend deployment fails
- Verify Root Directory is set to `backend`
- Check that `api/index.go` exists
- Verify all environment variables are set correctly

### API calls return 404
- Verify `NEXT_PUBLIC_API_URL` is set correctly in frontend
- Make sure backend URL doesn't have trailing slash
- Check backend deployment logs

### Authentication fails
- Check `JWT_SECRET` is set (at least 32 characters) and identical on every backend instance
- Verify DATABASE_URL is correct

### Database connection fails
- Verify DATABASE_URL format is correct
- Check the database password and that the host accepts connections from Vercel

---

## 📊 Monitoring

### View Logs
- Go to project → **Deployments** → Click deployment → **Function Logs**
- Real-time logs show all requests and errors

### Performance
- Go to project → **Analytics** (available on free tier)
- Monitor response times and errors

---

## 🔐 Security Checklist

Before going to production:

- [ ] Change `JWT_SECRET` to a strong random value (32+ characters)
- [ ] Update CORS to allow only your frontend domain
- [ ] Use a different `JWT_SECRET` and database for dev and prod
- [ ] Set up database backups
- [ ] Review and restrict API permissions

---

## 💰 Cost

**Total Cost: $0/month** (on free tier)

- Vercel Frontend: Free
- Vercel Backend: Free
- PostgreSQL: depends on your host

---

## 🆘 Need Help?

- Vercel Docs: [vercel.com/docs](https://vercel.com/docs)
- Vercel Community: [github.com/vercel/vercel/discussions](https://github.com/vercel/vercel/discussions)

---

## 🎉 You're Done!

Your full-stack application is now live on Vercel for free! 

**Frontend URL**: `https://companyuser-frontend.vercel.app`  
**Backend URL**: `https://companyuser-backend.vercel.app`

Share your app with the world! 🚀
