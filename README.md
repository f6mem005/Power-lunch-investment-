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

## Signing in

Each person signs in with their name and their personal passcode (the admin leaves the name blank and uses the admin passcode).
The name isn't case-sensitive. A passcode pasted from a message often gains a trailing space or a capital first letter, so the
sign-in forgives stray spaces around any passcode, and also accepts a lowercase version of a personal passcode (generated passcodes
are all lowercase). A passcode set with capitals must still be typed with them, and the admin passcode stays case-sensitive.
The sign-in screen has a **Show passcode** tick so a typo is visible.

## Who sees what

Enforced on the server (the browser is only sent what the person may see):

| Signed in as | Sees |
|---|---|
| Admin | Everything, and can edit. "Preview as <person>" shows exactly what that person sees. |
| Anyone | Every holder of any deal they hold a stake in, club or individual (you see who invested alongside you). Nothing from deals they aren't in. |
| Club member | Additionally, every holding in every Power Lunch Club deal (all members' contributions) and the Club tab (Year-end totals and capital accounts, K-1s and deal values). |
| Non-member | Only the deals they hold. No other club deals, no Club tab. |

### My deals (private deals a person adds for themselves)

Anyone who signs in (members and non-members) can add their own deals under the **My deals** tab and edit or delete everything on
them: the deal's details and terms, their own amount, date and distributions, and stock splits. Rules, all enforced on the server:

- A deal added this way is visible **only to the person who added it and to the admin**. It is never sent to anyone else, whatever else is true
  (no club membership, no stake, no preview of someone else), and it is kept out of the shared lists, people, totals, quotes and Year-end.
- It can't have other investors. Nobody, the admin included, can add another person's holding to it.
- A person can change **only deals they added**, not deals the admin manages. The admin can edit any of them: **Manage > Members' own deals**.
  Someone else's deal id answers "Not found", so no one can probe for it.
- Deal names only have to be unique among a person's own deals, so a name never reveals that someone else has a private deal of that name.
- Each person can have up to 25 of these deals.

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

## Stock splits (recorded by hand)

Nothing checks for splits automatically. When a company splits its shares, the admin opens the Deals tab, presses **Edit deal** on that deal
and presses **Record a split…** next to the Shares held box in the window that opens. It asks for the ratio (2 new shares for every 1 old one; for a reverse split, 1 new for every 10 old) and the date, shows
the new share count, multiplies the count and logs the split. The same window shows the split history, and the deal card shows a notice for 30 days.

- The deal needs a share (or unit) count already entered.
- Dollars invested and the value you typed in are never changed.
- For a public deal the live price changes on the split date, so record the split then; until you do, shares x price is wrong.
- An exact repeat of a split already recorded is refused, so a double tap can't apply it twice.

## Dated distributions

Each holding keeps one running total of distributions (used for value, carry and gain). In **Edit holding** the admin can also add each distribution with the date it was received. Adding one raises the total by its amount, removing one lowers it, and the total can never be set below the dated entries. Anything already in the total without a date is shown as "received before dates were tracked".

## The Club tab (club members and the admin only)

Everything that applies only to the Power Lunch Club lives in one tab, **Club**, with three sections: **Year-end** (everything per member), **K-1** and **Deal values**.
Non-members never see the tab or any of its data (the server doesn't send it). The old `#yearend` link still opens it.

### K-1 income and expenses

The admin enters the club's K-1 for each club deal and tax year as income and expense lines (a loss is negative income); there is one K-1 per deal per year.
The app splits it across the deal's holders by their share of the money in that deal at 12/31 of that year, and shows each year on its own and the
running total of that year plus all prior years. The split is an estimate (the real one follows the partnership agreement), and nothing per member
is stored, so correcting a K-1 or an investment updates everything.

### Deal values

The admin records what a club deal's statement shows at 12/31; the **Deal values** section shows each year and the change from the previous year recorded.

### Member capital accounts (in Year-end)

Each year's Year-end card ends with the K-1 net income and the member's **capital account**: end of the previous year + money put in (including any upfront fee) +
K-1 net income - distributions received that year = end of the year. Built from what is entered, so it is an estimate to compare with your K-1s and statements.
Distributions without a date are counted only in the current year (so the balance now matches "distributions to date") and called out.

## Year-end totals

The Year-end section shows, for Power Lunch Club deals only (Individual deals are excluded), what each club member
had invested in total at each 12/31 (and "to date" for the current year), and what went in
during the year. Amounts are cost by investment date, including upfront fees. Each year's card also shows the distributions
received during that year and the running total through it (this year plus all prior years), built from the dated distributions
above; an amount with no date is counted only in the current year's "to date" figure and is called out. Each card also ends with the K-1 net income, the capital account (see above) and the member's **% of club**: their share of the members' total capital account at the end of that year (or now, for the current year); a zero or negative balance counts as 0%, so the shares add up to 100%. Non-members are listed but not counted in the percentages. Download CSV exports all years, with the same
columns: invested, distributions during/through the year, distributions with no date, K-1 net income, capital account and % of club.
Non-member holders in club deals are listed separately and are not counted in the totals or percentages.

## Install as an app (Home Screen)

The site is an installable web app: `manifest.webmanifest`, icons in `public/icons/`, and `sw.js`. The service
worker keeps only the page shell (HTML, CSS, JS, icons) for offline use and never stores `/api/` or `/auth/`
responses, so no investment data or sign-in is cached on the device.

- **iPhone / iPad:** open the site in Safari, tap Share, then Add to Home Screen.
- **Android / desktop Chrome or Edge:** use the Install app button in the header (or the browser menu).
- The installed app has its own storage on iOS, so each person signs in once inside it.
