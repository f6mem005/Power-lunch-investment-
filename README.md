# Pari Passu Investments

Dashboard for the Power Lunch Club's investments and members' individual investments: every deal, who holds
what, and current values (manual marks, or live prices for public tickers). A switch at the top separates
Power Lunch Club deals from Individual deals.

**Stack:** static site in `public/`, Netlify Functions in `netlify/functions/`, data in Netlify Blobs.
No build step.

## Environment variables (Netlify > Project configuration > Environment variables)

| Name | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes | Random string (16+ chars) that signs login cookies |
| `ADMIN_PASSCODE` | yes | The admin's passcode (sign in with the name left blank) |
| `FINNHUB_API_KEY` | recommended | Live prices via Finnhub. Without it the app falls back to Stooq's free quotes, which returned HTTP 404 for SPCX, so set this for any public deal |

Mark the secrets as secret and scope them to **Functions**. If either required value is missing, nobody can
sign in (fails closed). There is no shared viewer passcode: everyone else signs in with their own name and a
personal passcode that the admin sets in People > Edit (stored hashed; changing or removing it signs that
person out).

## Who sees what

Enforced on the server (the browser is only sent what the person may see):

| Signed in as | Sees |
|---|---|
| Admin | Everything, and can edit. "Preview as <person>" shows exactly what that person sees. |
| Anyone | Every holder of any deal they hold a stake in, club or individual (you see who invested alongside you). Nothing from deals they aren't in. |
| Club member | Additionally, every holding in every Power Lunch Club deal (all members' contributions) and the Year-end tab. |
| Non-member | Only the deals they hold. No other club deals, no Year-end tab. |

A safety net remains in the code: for any deal someone could only partly see, the server would withhold the deal
total, share-of-deal %, deal value, share count, value history and notes. The current rule never needs it.

## How values work

- A deal's **current value** is for the whole position the group holds. Each holder's value is that total
  split by their share of the money invested in the deal.
- **Upfront management fee** is taken out of the amount invested (so "invested" is cash paid in, and
  fee x invested is shown as fees paid). **Carry** is a % of profit with no hurdle:
  `carry = carry% x max(0, value + distributions - invested)`, deducted from the value. Headline numbers are
  net of carry, with gross shown beside them. Deals with no terms entered are shown before carry.
- If a deal has a **ticker and a share count** and a price is available, value = shares x live price.
  Otherwise the manual value is used, labelled Estimate or Statement. With neither, it shows at cost.
- The first load imports `netlify/functions/lib/seed.json` (from the original Google Sheet). The sheet's
  "Current Value" column was a flat 90% of cost, so imported values are flagged **Estimate**.

## Local development

`npm install`, then `netlify dev` with the three env vars set in a git-ignored `.env`.

## Guided setup (admin only)

- After an admin sign-in, a welcome prompt offers to add an investment or fill in missing deal details.
- **+ Add investment** (header) and Manage > Guided setup ask one question at a time: new or existing deal,
  name, Power Lunch Club or Individual, date, who invested and how much (new people can be added inline),
  fee and carry, notes, public ticker and shares, current value, then a review screen.
- **Fill in missing deal details** walks through the deals that lack fee/carry terms, a real value or a
  share count, saving each deal as it goes. A deal can be skipped.
- `POST /api/investments` validates everything before it writes anything.

## Editing (admin only)

Everyone else is read-only. As the admin, People, Deals and Manage show Edit buttons for
every person, deal and holding (rename, change member status, reassign, correct amounts, change terms and
values). People can only be deleted once they have no holdings; deleting a deal asks before also deleting its
holdings. Manage > Backup downloads everything as JSON, since there is no undo. Passcodes are changed in
Netlify's environment variables, not in the app.

## Year-end totals

The Year-end tab shows, for Power Lunch Club deals only (Individual deals are excluded), what each club member
had invested in total at each 12/31 (and "to date" for the current year), their % of the club, and what went in
during the year. Amounts are cost by investment date, including upfront fees. Download CSV exports all years.
Non-member holders in club deals are listed separately and are not counted in the totals or percentages.

## Install as an app (Home Screen)

The site is an installable web app: `manifest.webmanifest`, icons in `public/icons/`, and `sw.js`. The service
worker keeps only the page shell (HTML, CSS, JS, icons) for offline use and never stores `/api/` or `/auth/`
responses, so no investment data or sign-in is cached on the device.

- **iPhone / iPad:** open the site in Safari, tap Share, then Add to Home Screen.
- **Android / desktop Chrome or Edge:** use the Install app button in the header (or the browser menu).
- The installed app has its own storage on iOS, so each person signs in once inside it.
