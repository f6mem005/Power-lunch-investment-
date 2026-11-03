# Power Lunch Investments

Dashboard for the Power Lunch Club's investments: every deal, what each member holds, what non-members
hold, and current values (manual marks, or live prices for public tickers).

**Stack:** static site in `public/`, Netlify Functions in `netlify/functions/`, data in Netlify Blobs.
No build step.

## Environment variables (Netlify > Project configuration > Environment variables)

| Name | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes | Random string (16+ chars) that signs login cookies |
| `VIEWER_PASSCODE` | yes | Shared passcode for read-only access |
| `ADMIN_PASSCODE` | yes | Passcode that can add investments and update values |
| `FINNHUB_API_KEY` | no | Live prices via Finnhub. Without it, Stooq's free daily quotes are used |

Mark the three secrets as secret and scope them to **Functions**. If any of the three required values is
missing, nobody can sign in (fails closed).

## How values work

- A deal's **current value** is for the whole position the group holds. Each holder's value is that total
  split by their share of the money invested in the deal.
- If a deal has a **ticker and a share count** and a price is available, value = shares x live price.
  Otherwise the manual value is used, labelled Estimate or Statement. With neither, it shows at cost.
- The first load imports `netlify/functions/lib/seed.json` (from the original Google Sheet). The sheet's
  "Current Value" column was a flat 90% of cost, so imported values are flagged **Estimate**.

## Local development

`npm install`, then `netlify dev` with the three env vars set in a git-ignored `.env`.
