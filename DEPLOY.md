# CBSystem - Employee Management: step-by-step setup

Follow the parts in order: **A** prepare, **B** GitHub, **C** Supabase, **D** Cloudflare, **E** first test, **F** after launch.
Screens on GitHub, Supabase and Cloudflare change their wording now and then. If a button has a slightly different name, look for the closest one.

**Time needed:** about 60 to 90 minutes the first time.

---

## Part A. Prepare (10 minutes)

### A1. Decide your addresses
These are the addresses used throughout this guide. Change them only if you want a different one.

| What | Address |
|---|---|
| The website | `https://employee.cbsystem.co.uk` |
| Staff login | `https://employee.cbsystem.co.uk/staff/` |
| Business (owner and HR) login | `https://employee.cbsystem.co.uk/business/` |
| Your private admin page | `https://employee.cbsystem.co.uk/admin/` |
| Supabase function | `https://wpfqxxnqksbkyzmcipft.supabase.co/functions/v1/cbs-hol` |

The Supabase address above is your existing project (the one your Shop and Restaurant systems use). If you want a separate Supabase project for this software, see **F5**.

### A2. Unzip the download
1. Download `cbsystem-employee-management.zip` and unzip it.
2. Open the folder `employee-management`. Inside you will see:
   - `site` (the web pages that customers use)
   - `supabase` (the database file and the function)
   - `DEPLOY.md`, `OPERATIONS.md`, `README.md`, `STATUS.md` (guides)

### A3. Have these ready
- [ ] Your GitHub login
- [ ] Your Supabase login (the project you already use)
- [ ] Your Cloudflare login (the account that holds `cbsystem.co.uk`)
- [ ] Your existing **ADMIN_KEY** (the secret you set for your other systems). You will type it into the admin page later. If you do not remember it, you can set a new one in Part C, step C4.

---

## Part B. GitHub: upload the files (10 minutes)

The files go into a **private** repository. Private means only you can see the code.

### B1. Create the repository
1. Go to https://github.com and sign in.
2. Click the **+** at the top right, then **New repository**.
3. **Repository name:** `cbsystem-employee-management`
4. Choose **Private**.
5. Leave "Add a README", ".gitignore" and "license" **unticked**.
6. Click **Create repository**.

### B2. Upload the files
1. On the empty repository page, click the link **uploading an existing file**.
2. On your computer, open the unzipped folder `employee-management`. Press **Ctrl+A** (select everything inside it: the `site` folder, the `supabase` folder and the four `.md` files).
3. **Drag them all** into the GitHub upload box. Wait until every file has finished uploading (the progress bars disappear).
4. In **Commit changes**, type: `First version`
5. Choose **Commit directly to the main branch**, then click **Commit changes**.

### B3. Check it worked
Open the repository. You should see exactly these at the top level:
`site`, `supabase`, `DEPLOY.md`, `OPERATIONS.md`, `README.md`, `STATUS.md`.
Click `site`: you should see `admin`, `business`, `staff`, `index.html`, `_headers`, `robots.txt`.

**If a folder is missing** (browsers sometimes skip folders): upload that folder again with **Add file, Upload files**, or use **GitHub Desktop** (free) to add the whole folder.

> The code contains no passwords. Your ADMIN_KEY and other secrets live only in Supabase (Part C).

---

## Part C. Supabase: database, function, secrets (20 minutes)

Open https://supabase.com/dashboard and open your project.

### C1. Create the database tables
1. In the left menu click **SQL Editor**, then **New query**.
2. On your computer open `employee-management/supabase/schema.sql` with Notepad (or any text editor). Press **Ctrl+A**, then **Ctrl+C**.
3. Paste into the Supabase editor (**Ctrl+V**) and click **Run**.
4. If a window warns about "potentially destructive operations", click **Run this query**. (The file only adds and replaces its own `hol_` tables and functions. It never touches your Shop or Restaurant tables.)
5. You should see **Success. No rows returned.**

**If you see an error:** copy the exact message and send it to me. The most common cause is a partial paste, so paste again and re-run. It is safe to run the file as many times as you like.

**Check:** open **Table Editor**. You should now see tables whose names start with `hol_` (for example `hol_businesses`, `hol_employees`, `hol_requests`).

### C2. Deploy the function
1. In the left menu click **Edge Functions**.
2. Click **Deploy a new function**, then choose **Via Editor** (or "Create a new function").
3. **Function name:** `cbs-hol` (exactly like this, lower-case, with the dash).
4. Delete anything already in the editor.
5. On your computer open `employee-management/supabase/deploy/cbs-hol.single.ts` with Notepad, press **Ctrl+A**, **Ctrl+C**, and paste into the editor.
6. Click **Deploy function**. Wait for "Deployed".

> Use the file inside the `deploy` folder (`cbs-hol.single.ts`). It is the complete function in one file.

### C3. Turn off "Verify JWT" (important)
1. Click the function **cbs-hol** in the list.
2. Open its **Settings** or **Details** tab.
3. Find **Verify JWT** (also written "Enforce JWT Verification") and switch it **OFF**. Save.

Why: your pages sign in with the staff key and PIN, not with a Supabase login. Your other function `cbs-biz` is set the same way.

### C4. Add the secrets
1. In the left menu click **Edge Functions**, then **Secrets** (sometimes under **Project Settings, Edge Functions**).
2. Add each of these (click **Add new secret**, type the name and value, save):

| Name | Value |
|---|---|
| `ADMIN_KEY` | Already set from your other systems. Only add it if it is missing. Make it long and random. |
| `HOL_STAFF_URL` | `https://employee.cbsystem.co.uk/staff/` |
| `HOL_BUSINESS_URL` | `https://employee.cbsystem.co.uk/business/` |
| `HOL_ALLOWED_ORIGINS` | `https://employee.cbsystem.co.uk` |

For the first test (Part E) you can add the Cloudflare test address as well, separated by a comma, then remove it later:
`https://employee.cbsystem.co.uk,https://cbsystem-employee.pages.dev`

**Optional (email)** — only if you want emails sent:

| Name | Value |
|---|---|
| `EMAIL_API_KEY` | Your key from https://resend.com (create a free account, verify your domain, create an API key) |
| `EMAIL_FROM` | An address on that verified domain, for example `employee@cbsystem.co.uk` |

> Secrets are read when the function starts. If a value does not seem to apply, open the function and click **Deploy** again.

### C5. Turn on the daily jobs (do this now, do not skip)
Without this, approved leave is never marked as taken, carried leave never expires, and no emails go out.

1. Left menu **Database**, then **Extensions**. Search for **pg_cron** and switch it **on**. Search for **pg_net** and switch it **on**.
2. Go to **SQL Editor**, **New query**. Paste this, **replace `YOUR_ADMIN_KEY`** with your real ADMIN_KEY, and click **Run**:

```sql
select cron.schedule('hol-jobs', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://wpfqxxnqksbkyzmcipft.supabase.co/functions/v1/cbs-hol',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-admin-key', 'YOUR_ADMIN_KEY'),
    body := '{"action":"admin.run_jobs"}'::jsonb);
$$);
```

3. To check it later: **Database, Cron Jobs** shows `hol-jobs` and its history.

### C6. Backups
1. **Project Settings, Database, Backups** (wording varies).
2. Free projects have **no automatic backups**. Before your first paying customer, move to a paid plan with daily backups, or ask me for a simple dump routine. See `OPERATIONS.md`, section 6.

---

## Part D. Cloudflare: publish the website (15 minutes)

You already use Cloudflare for `cbsystem.co.uk`. This adds one more site.

### D1. Create the Pages project
1. Go to https://dash.cloudflare.com and sign in.
2. Left menu **Workers & Pages**, then **Create**, then the **Pages** tab, then **Connect to Git**.
3. Choose your GitHub account and select the repository `cbsystem-employee-management`. (If it is not listed, click to adjust GitHub permissions and allow this repository.)
4. Click **Begin setup** and fill in:
   - **Project name:** `cbsystem-employee`
   - **Production branch:** `main`
   - **Framework preset:** `None`
   - **Build command:** leave **empty**
   - **Build output directory:** `site`   <- important
5. Click **Save and Deploy**. After a minute you get an address like `https://cbsystem-employee.pages.dev`.
6. Open `https://cbsystem-employee.pages.dev`. You should see the black page with two buttons: **Staff login** and **Business owner or HR login**.

### D2. Use your own address
1. In the project, open **Custom domains**, then **Set up a custom domain**.
2. Type `employee.cbsystem.co.uk` and continue. Cloudflare adds the record for you (your domain is already in this Cloudflare account). Wait until it says **Active** (usually a few minutes).
3. Open `https://employee.cbsystem.co.uk`. You should see the same two-button page.

### D3. Protect the admin page (important)
The admin page creates businesses. Only you should be able to open it.
1. Left menu **Zero Trust**, then **Access**, then **Applications**, then **Add an application**, then **Self-hosted**.
2. **Application name:** `Employee Management admin`
3. **Session duration:** 24 hours.
4. **Public hostname:** subdomain `employee`, domain `cbsystem.co.uk`, **path** `admin`.
5. Add a second entry with path `admin/*` (so everything under it is covered).
6. Click **Next**. Create a policy: name `Me only`, action **Allow**, **Include**: **Emails**, then type your own email address (add anyone else who may use it).
7. Make sure the login method **One-time PIN** is switched on (the same email-code method you use for your Shop and Restaurant systems). Save the application.
8. **Test it:** open a private/incognito window and go to `https://employee.cbsystem.co.uk/admin/`. It must ask for your email and send a code. Also check that `https://employee.cbsystem.co.uk/staff/` still opens **without** any code (customers need that).

> Even without this step, the admin page cannot do anything without your ADMIN_KEY. Access is a second lock. Keep both.

---

## Part E. Your first test (15 minutes)

### E1. Open the admin page and connect
1. Open `https://employee.cbsystem.co.uk/admin/` (enter the emailed code).
2. **Function URL** should already show `https://wpfqxxnqksbkyzmcipft.supabase.co/functions/v1/cbs-hol`. Type your **ADMIN_KEY** and click **Connect**. You should see "Connected".

### E2. Load the bank holidays
1. Click **Update bank holidays**.
2. You should see a message like "xxx bank holidays saved". (It loads England and Wales, Scotland and Northern Ireland from GOV.UK.) Repeat this once a year.

### E3. Create a test business
1. Under **Create a business** type `Test Company`, choose the region, click **Create business**.
2. A box shows the **ready-to-send message** with the business login link, the owner PIN, the staff link and the staff key. **Copy it now.** It is shown only once.

### E4. Walk through it
1. Open the **business link** from the message. Sign in: employee number `OWNER` (or leave blank), PIN from the message.
2. **People:** add a manager (role Manager) and two employees (give each a manager). Write down the PINs shown (shown once).
3. **Setup:** click **Allocate leave** for the current year.
4. In another window open the **staff link**. Sign in as an employee: staff key from the message, the employee number, the PIN.
5. **Request leave:** pick two future working days, check the live preview, send it.
6. Sign in as the manager on the staff page, open **Approvals**, review and approve.
7. Back as the employee, **Home** should show the days booked.
8. In the admin page, find `Test Company` and click **Close** when you have finished.

If all of that worked, the system is live.

---

## Part F. After launch

### F1. Give a customer their access
Admin page, **Create a business**, then send them the ready-to-send message (it holds both logins). They create their own employees, run the allocation and are ready.

### F2. Updating the software later
1. **Pages (the website):** in GitHub open the file, click the pencil icon, change it, **Commit changes**. Cloudflare publishes it automatically in about a minute. For many files, use **Add file, Upload files** again.
2. **Database:** in Supabase SQL Editor run the new `schema.sql` (safe to re-run).
3. **Function:** paste the new `cbs-hol.single.ts` over the old one and click **Deploy**. Keep a copy of the old file in case you need to go back.

### F3. Weekly and yearly jobs
- **Each year:** Admin page, **Update bank holidays**. HR adds the next leave year in **Setup**, then runs **Allocate leave** and **Carry over unused leave**.
- **Weekly:** check balances agree with the ledger (see `OPERATIONS.md`, section 5).

### F4. Problems? Quick answers

| What you see | What to check |
|---|---|
| "Cannot reach the function" | Part C2 (function deployed with the exact name `cbs-hol`) and the address in the admin page. |
| Browser console says "blocked by CORS" / pages cannot sign in | `HOL_ALLOWED_ORIGINS` (C4) must contain the exact address you opened, with `https://` and no `/` at the end. Then redeploy the function. |
| "Invalid admin key" | The ADMIN_KEY typed in the admin page must match the Supabase secret. Wait 15 minutes if you typed it wrong 20 times. |
| "Bank holidays have not been loaded" | Part E2. |
| Staff page says "Invalid sign-in details" | Staff key, employee number and PIN are all needed. The staff key is in the message from the admin page. |
| Admin page asks for a code | That is the Cloudflare lock working. Use your own email. |
| Website shows the old version | In Cloudflare, Workers & Pages, your project, **Deployments**. Wait for the latest to say Success. Then press Ctrl+F5. |
| Nothing is marked as taken / no email | Part C5 (daily jobs). Email also needs C4 optional secrets and the owner switching email on in **Setup**. |
| Anything else | Send me the exact message and which step. |

### F5. If you want a separate Supabase project for this software
1. Create the new project and do Part C there.
2. In GitHub open `site/staff/index.html`, `site/business/index.html` and `site/admin/index.html`. In each, find the web address that starts `https://wpfqxxnqksbkyzmcipft.supabase.co/functions/v1/cbs-hol` and replace it with your new project's address (`https://YOUR-PROJECT-REF.supabase.co/functions/v1/cbs-hol`). Commit.
3. In step C5 use the new project's address as well.

### F6. Names you may notice
The product name is **CBSystem - Employee Management**. Inside the database and function the older short names `hol_` (tables) and `cbs-hol` (function) are kept on purpose, so nothing has to be rebuilt. Customers never see them.

### F7. Before you sell it
Read `STATUS.md` (what is not built yet) and `OPERATIONS.md` (security checklist, backups, restore drill, personal data). Pilot with one or two real customers first.
