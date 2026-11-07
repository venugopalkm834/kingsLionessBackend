# Kings Lioness — Service Marketplace & Digital Wallet (MEAN)

Angular 18 (standalone) · Node/Express · MongoDB/Mongoose · JWT · black & gold responsive design with a mobile bottom-nav.

## Run it (local)
Requirements: Node 18+ (20 recommended) and MongoDB (local, Docker, or Atlas).

```bash
# 1. API
cd server
npm install
cp .env.example .env        # Windows PowerShell: copy .env.example .env
npm run seed                # creates the admin user and the 6 default services
npm start                   # http://localhost:4000

# 2. Website (new terminal)
cd client
npm install
npm start                   # http://localhost:4200  (proxies /api and /uploads to :4000)
```
`.env` values: `ENC_KEY` and `JWT_SECRET` can be any long random text (16+ chars). Keep `ENC_KEY` constant — it encrypts bank account numbers.
Default admin (from `.env`): `admin@kingandlioness.local` / `ChangeMe@123` → log in at `/admin/login` and **change it**.

MongoDB options: plain local `mongod` works (the API prints a warning and runs without transactions — testing only). For real money use a replica set: `docker compose up -d` (then uncomment the `?replicaSet=rs0` URI) or MongoDB Atlas.

## What changed in this version (your 9 requests)
| # | Request | Where |
|---|---|---|
| 1 | Name + logo → Kings Lioness | `client/src/assets/brand`, header/footer/auth/admin sidebar, favicon |
| 2 | Admin add / deduct wallet funds | Admin → Users or Wallet Management → *Add funds / Deduct funds* (wallet lookup, principal/earned bucket, mandatory reason, audit-logged, user notified) |
| 3 | Voice note on booking | Booking form: record in the browser (mic) or attach an audio file; admin sees an audio player in the booking details; CSV shows a voice-note column |
| 4 | Contact icon → WhatsApp | Header phone button + mobile drawer + footer open `wa.me/<number>`; number/message set in Admin → Settings → Contact |
| 5 | Withdraw fees | Admin → Settings → Withdrawal fees: two fees (default "TDS" 2% and "Service charges" 2%), each with its own text, percent and on/off. User sees the breakdown before confirming |
| 6 | Monthly % → daily commission | Admin → Settings → Monthly return. Enter monthly %, daily % is calculated (actual days in month, or fixed 30) and credited every day at 00:10 server time; "Run credit now" button; one credit per user per day |
| 7 | Bank detail add error | Fixed (encryption-key handling, validation messages, server error shown in the form) |
| 8 | Principal can't be withdrawn | Wallet = Principal + Earned. Only earned income is withdrawable while principal is locked. Lock = N days after the user's latest deposit, or until a fixed date (Admin → Settings → Principal lock) |
| 9 | Workflow review | Every button wired to an endpoint; see test checklist below |

## Update 2 — logo, transfers, earnings, referrals
| Change | Where / how it works |
|---|---|
| New logo | `client/src/assets/brand` (header, footer, login, admin sidebar, favicon, app icons). Brand text is now "Kings Lioness". |
| Transfer by mobile number **or** Wallet ID | Wallet → Transfer funds → dropdown "Find recipient by". The recipient's name is shown to confirm before sending. |
| Transfer principal or earned | Dropdown "Transfer from". **Principal**: if the sender's principal is locked, the recipient's received principal stays locked until the same unlock date (`lockUntil`); if unlocked, it arrives unlocked. **Earned income** arrives in the recipient's *earned* section and stays withdrawable. |
| Month-end principal return (separate setting) | Admin → Settings → "Month-end principal return": on/off, % of principal, minimum principal. Credited once on the last day of the month (23:55 server time) to earned income; Admin → Earnings → "Run month-end now" also works. One credit per user per month (unique index). |
| Daily earning setting | Admin → Settings → "Daily earning": type the **daily %** directly (or switch to "monthly % split into days"). Credited every day at 00:10 to earned income; "Run daily credit now" button; one credit per user per day. |
| Referral commissions: booking / deposit / holding | Admin → Settings → "Referral commissions": each has its own on/off and %. Deposit: % of the referred user's first (or every) approved deposit, with a minimum. Holding: % of each referred user's principal at month end. Manual or auto approval; paid to the referrer's earned income. Commission type shows in Admin → Referral Management and on the user's Referrals page. |

Notes: the month-end return uses the principal held on the last day (no per-day proration). Enabling any earning/commission switch asks for the legal-review confirmation tick.

## Update 3 — theme, user IDs, user editing, earning commission
- **Theme:** light black (charcoal), white and gold; gold buttons. Colours live in `client/src/styles.scss` (`:root`).
- **User ID:** new accounts get `KL<year>####` (e.g. `KL20264821`). The wallet ID is still stored in the database for reference but is no longer shown anywhere. **Existing databases:** run `cd server && npm run migrate:userids` once to give old users KL IDs.
- **Transfer:** choose *User ID* or *Mobile number*; the recipient's name appears as soon as a valid value is typed. Mobile numbers must be unique (registration and edits now enforce it).
- **Admin → Users → Edit:** change name, mobile, email, username, address, status, or set a new password. Duplicate email/mobile/username are rejected; every change is audit-logged.
- **Admin → Add/Deduct funds:** look up by User ID or mobile number.
- **Earning commission (Settings → Referral commissions → 4. Earning):** % of what each referred user earns (daily earning + month-end principal return), paid **daily** or at **month end**. The Holding commission also has a Daily / Month-end choice.

## Update 4
- Deposit: Transaction ID/UTR required, receipt optional.
- New user **History** page (`/history`): transactions, deposits, withdrawals, transfers, daily earning, month-end returns (the missing page was the cause of the 404/blank history). Admin lists (deposits, withdrawals, transfers, transactions...) unchanged and routed under `/admin/<name>`.
- Login button is now a gold button in the header and in the home hero; extra mobile polish.

## Money rules
- Amounts are stored as integer paise; the ledger is append-only; balances are changed only on the server.
- Deposits (approved) and admin credits → **principal**. Daily returns and referral commissions → **earned**.
- Withdrawal takes from earned first, then principal only if the lock is off. Reject refunds exactly the original split.
- TDS / service charge are deducted from the requested amount; the user receives the net.
- Transfers between wallets move principal.

## Test checklist
1. Register a user → Wallet only appears after login.
2. Home → Book now on any card → record/attach a voice note → submit → Admin → Bookings → View → play audio.
3. Profile → Bank accounts → Add (account number 9–18 digits, IFSC like `HDFC0001234`) → Admin → Bank Accounts → Verify.
4. Deposit → Admin → Deposit Requests → Approve → user principal increases.
5. Withdraw → see the lock banner; with principal only you are blocked until the lock ends. Admin → Settings → turn off lock or add earned funds (Wallet Management → Add → *Earned*) → withdraw → see TDS/service breakdown → Admin → Withdrawal Requests → Approve → Mark paid (use *Show account no.* to pay).
6. Admin → Settings: set monthly % (e.g. 9), enable returns (tick legal confirmation) → Daily Returns → Run credit now → user earned income increases.

## Production notes
- Set `CLIENT_URL`, strong `JWT_SECRET`/`ENC_KEY`, use HTTPS and a replica set/Atlas. If the API is on another domain edit `client/src/environments/environment.prod.ts` (`api`, `fileBase`).
- Uploaded files are served from `/uploads` under random names; use object storage for scale.
- **Legal:** daily returns, referral rewards, TDS handling and holding user funds are regulated activities in many places. They ship switched **off**; get legal/regulatory review before enabling. Returns are admin-configurable program benefits and are never guaranteed.
- Verified here: server syntax, wallet/fee/lock/return logic via unit tests, icon registry and template references. The Angular build itself could not be run in the authoring sandbox (no npm registry access) — if `npm start` shows a compile error, send it and it will be fixed.
