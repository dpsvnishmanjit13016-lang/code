# SwingPulse — intraday swing signals (phone + desktop)

The app gets live prices for the stocks on your watchlist, checks the signal rules on every 5-minute candle,
and pops up **BUY / SELL** with **Entry, Stop-loss, Target 1, Target 2**, then **Target 1** and **EXIT** alerts.
No TradingView account, webhook or broker needed.

Prices come from Yahoo Finance and may be a few minutes delayed. Always check the live price in your broker app before you trade.

## Run it on your computer (Windows)
1. Install Node.js from **nodejs.org** (green "Windows Installer (.msi)" button).
2. Double-click **Start SwingPulse.bat** in this folder.
3. Chrome opens **http://localhost:3000**. Keep the black window open while you use the app.

Mac: open Terminal in this folder and run `node server.js`, then open http://localhost:3000.

## What you see
- **Watchlist** — price, % change, and 5 dots showing how many signal rules are met right now (green = buy side, red = sell side).
  Add any NSE stock by name (e.g. `TATAPOWER`), BSE with `BSE:` in front. `NIFTY`, `BANKNIFTY` and `SENSEX` also work.
- **Scanner → Momentum now** — every 5 minutes all stocks in the scan list (about 70) are ranked by current strength:
  today's move, the last 30 minutes, volume vs normal and distance from VWAP, among stocks where Supertrend, EMA 9/21 and VWAP
  all agree. Shows the top 10 **up** and top 10 **down** with Buy/Sell, Stop-loss, Target 1, Target 2 and the time.
  Switch on **Auto-add top momentum to watchlist** to have the top 5 up + top 5 down added automatically (marked **AUTO**) so you
  get their BUY / SELL popups; they are removed again when they lose momentum, unless a trade is open.
  This is a live ranking, not a tested edge — paper trade first.
- **Scanner (Intraday picks)** — at **9:30 AM and every 30 minutes until 2:30 PM** it scans about 70 liquid NSE stocks
  (NIFTY 50 + popular F&O) and shows **up to 10 high-quality picks per round** (buy and sell together). A pick is only shown if it passes
  all three checks:
  1. **Win chance 60%+** from the learning model,
  2. **Past success 60%+** for the same setup on that stock (about the last month),
  3. **Positive expected profit after charges** (estimated at 0.06% of the price per round trip).
  Each pick shows Entry / Stop-loss / Target 1 / Target 2 and its live result. The top card shows **today's success rate**, and each round
  shows its own rate. Rounds with fewer good setups show fewer picks, or none.
- **Learning model** — learns from about a month of trades on every scanned stock **and from every one of its own finished
  recommendations**: Scanner picks, the Momentum top 10 and Watchlist signals. Each finished trade becomes a lesson (what it saw at
  entry, what it predicted, what really happened); its own lessons count double. It learns to predict **profit after your charges**
  (Setup → Money per trade), so "success" means the same as Profit success in History; if you change the charges, past lessons are
  re-judged. It retrains daily and after every 5 new lessons, checks itself on the 5 newest days it did not learn from, and raises
  its own bar when its picks under-deliver. **Scanner → Tested picks → Model report** shows predictions vs reality by win-chance
  level and week by week, plus each self-check, so you can see whether it is really improving.
- **Machine learning + probability (for Tested picks)** — three algorithms compete every time the model retrains: logistic
  regression, **gradient-boosted decision trees** (learns combinations like "works in the morning but not after lunch") and an
  **ensemble** of both. Each learns from older days and is judged on the newest days it never saw; the one with the lowest
  **Brier score** (prediction error) is used, and **isotonic regression** calibrates it so "70%" really means about 70%.
  Past success per stock uses **Bayesian shrinkage** (small records like 4 of 5 are pulled toward the setup's overall record) and
  shows a **certainty** (probability the edge is real, from a Beta distribution). The Learning model card shows which algorithm
  won, its error vs simply guessing the average, and the biggest influences.
- **ML Lab** (double-click **ML Lab**) — tests on your last 60 days of real data, walk-forward (always learning only from earlier
  days): all setups vs the old model vs the new ML vs new ML top 5 per day, win rate after charges with a 95%-sure lower bound,
  ₹ per trade and profit factor, plus a calibration table showing whether its win chances are honest.
- **Trade cards above the chart** — each recommendation for the stock shows the **time it was recommended**, **Buy**, **Sell**, **Stop-loss**, **Target 1** and **Target 2** (with ✓ reached / ✗ not reached) and the result. The chart stays clear: a gold dot marks each entry, and ✓ / ✗ marks at the Target 1 and Target 2 levels show whether each target was reached.
- **Chart** — candles with EMA 9, EMA 21, VWAP, Supertrend, BUY/SELL/T1/EXIT markers, and Entry/SL/T1/T2 lines for an open trade.
- **Popups** — appear the moment a 5-minute candle closes with a signal, with a beep and vibration.
- **History** — every recommended trade (Scanner picks, Momentum top 10, Watchlist signals) is saved automatically when it finishes,
  in `journal.json`. Pick a date (or All days) to see each trade's entry time, Buy/Sell, Stop-loss, Target 1, Target 2, exit and result.
  Each trade is marked **✓✓ Success at Target 2**, **✓ Success at Target 1** (Target 1 reached, half booked) or **✗ Failed**, and the
  success rate counts both kinds of success. Each trade also shows **Gain before charges**, **Charges**, **Net gain** and
  **Profit success** (✓ if the net gain after charges is above ₹0), using the amount and charges per trade set in
  **Setup → Money per trade** (default ₹1,00,000 and ₹65; the button there fills in Zerodha's current rates for your amount). Tap **Mark as taken**
  on trades you actually placed, then choose **Only trades I took** to see your own results. The **Signals** tab (bell) keeps the full list of every alert, as before.

## Strategies (chosen by testing, not by guess)
Every day the app tests each strategy on about the last month of 5-minute data for every scanned stock, after estimated charges,
and uses only the best ones (at least 30 test trades, 55%+ won, positive average result; best 5). See **Setup → Strategies**.

| Strategy | Built from your list |
|---|---|
| Core 5 rules | Supertrend, 9/21 EMA, VWAP, RSI, Volume |
| 10/20 SMA cross with 200 trend | 10 SMA crossing 20 SMA, 200 EMA |
| MACD momentum | MACD above zero and rising, VWAP |
| Supertrend colour reversal | Supertrend colour change, 200 EMA |
| Swing breakout + volume burst | Swing / trend-line breakout (20-candle high/low), Volume burst, RVOL |
| RSI 70 momentum | RSI above 70 for buying (below 30 for selling) |
| 44 MA pullback | 44 moving average + CM Stochastic turn |
| Donchian trend ribbon | Donchian trend + 9/21 EMA + VWAP |
| Pivot point breakout | Classic pivot points (R1 / S1) with volume |
| Gap & go (episodic pivot) | Gap 1%+ with RVOL 2+, before 11:30 |
| Supertrend confirmed reversal (ADX) | Supertrend flip (10, 3), candle closes beyond Supertrend, next candle confirms, VWAP, 50 EMA, 200 EMA, ADX 14 above 20, RSI 14 above/below 50, 9/21 EMA |

**Your trend rules apply to every pick:** no buys when the 10 and 20 SMA are both below the 200 EMA or price is below the 50-day SMA (opposite for sells).
**Exit:** after Target 1 the stop trails with the **Chandelier Exit**.

**Rules to avoid false trades (Setup, both on by default):**
- **Skip sideways markets:** no new trade while **ADX (14)** is below 20.
- **Wait for a confirmation candle:** a signal is taken only after the next 5-minute candle also closes in the trade direction
  (beyond the previous close, green for buys / red for sells). Fewer false signals, slightly later entries.
They apply to Watchlist popups, Scanner picks and Momentum. The learning model also gets ADX as an input.
To check whether they help on real data, double-click **Compare ADX filter** (Model A vs A + ADX vs A + ADX + confirmation
vs the new Supertrend confirmed reversal vs combined, money after your charges).

**Not added:** PCR and OI analysis (need option-chain data the free price feed does not have), ZigZag (redraws the past, so it cannot be
traded or tested honestly), VuManChu Swing Free / Imbalance Algo / USE Algo / Purple dot (closed TradingView scripts; their ideas are
covered by Supertrend reversal, Donchian trend and MACD momentum). Breakout probability = the learning model's win chance.

## Signal rules (5-minute candles)
| | BUY (up trade) | SELL (down trade) |
|---|---|---|
| Supertrend (10, 3) | Up | Down |
| EMA 9 vs EMA 21 | 9 above 21 | 9 below 21 |
| VWAP | Close above | Close below |
| RSI (14) | Above 55 | Below 45 |
| Volume | Spike over 1.5× its 20-candle average in the last 3 candles (skipped for indices) | same |

Entry = signal candle close · Stop-loss = Supertrend line · Target 1 = 1× risk (book 50%, stop moves to entry) ·
Target 2 = 2× risk · Early exit if Supertrend flips · New signals only 09:30–14:45 · Square-off 15:15 IST.
You can choose 3, 4 or 5 rules needed in **Setup**.

## Run it online (works with your laptop OFF)
The app runs on a cloud server, your phone installs it from a fixed address, and push notifications arrive even when the app is closed.
1. **GitHub** (free): create an account → **New repository** named `swingpulse` → **uploading an existing file** →
   drag in everything from the **SwingPulse_Cloud** folder (including the `public` folder) → **Commit changes**.
2. **Render** (render.com): sign up with GitHub → **New → Blueprint** → choose the `swingpulse` repository.
   It reads `render.yaml`: always-on server in Singapore ($7/month) + 1 GB disk ($0.25/month) for your history.
   When asked, type an **APP_PASSWORD** (your login password) → **Apply**. Wait until it shows **Live** (3–5 minutes).
3. Open the address Render shows (like `https://swingpulse-xxxx.onrender.com`) on your phone, sign in with your password.
4. Install: Android Chrome → **Install**; iPhone Safari → Share → **Add to Home Screen**, then open it from the icon.
5. In the app: **Setup → Allow notifications**, then **Send a test notification**.
   iPhone needs iOS 16.4+ and must use the installed Home Screen app for notifications.
Updating later: upload the changed files to the same GitHub repository; Render redeploys automatically and keeps your history on the disk.

## Use it on your phone (iPhone or Android)
1. Start SwingPulse on your computer as usual and keep the black window open.
2. After 10–30 seconds the black window shows a **PHONE LINK** (…trycloudflare.com), and **Setup → Open on your phone** shows a **QR code**.
3. Scan the QR code with your phone camera (or send yourself the link) and open it.
4. Tap **Install** in the blue bar at the top (Android), or in Safari tap **Share → Add to Home Screen** (iPhone).

The link works on any Wi-Fi or mobile data while your computer is on. It changes each time you restart SwingPulse, so scan again after a restart.
The link is made by `cloudflared.exe` (Cloudflare's free tunnel tool, included in this folder).
If Windows asks about the firewall or "Windows protected your PC", choose **Allow** / **More info → Run anyway**.

## Optional: TradingView alerts
If you also want alerts from the included `SwingPulse_Intraday_Signals.pine` indicator, set its alert format to JSON (webhook)
and send alerts to `https://<your-online-address>/tv-alert`. Set the same `SECRET_KEY` on the server. Needs a paid TradingView plan.

## Good to know
- No pick has a confirmed profit. Win chance and expected profit are estimates from past data; markets can behave differently.
- Charges depend on your broker and quantity; 0.06% is an estimate.
- The app shows signals; it does **not** place orders.
- Rule-based tool for study, **not investment advice**. Paper-trade it first.
