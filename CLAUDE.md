# Pari Passu Investments: instructions for Claude

Dashboard for the Power Lunch Club and members' individual investments. Static site in `public/`,
Netlify Functions in `netlify/functions/`, data in Netlify Blobs. No build step. See `README.md` for the
environment variables, the visibility rules and how values, fees and carry are calculated.

## Standing rule: code review AND security review on every code change

**Every time you change code, hand the change to BOTH the code reviewer and the security reviewer before you report it done.**
Neither one replaces the other.

1. Make the change and test it (see below).
2. Run the `code-review` skill on the change (`/code-review high`). Use the uncommitted diff, or pass paths
   such as `netlify/functions public` to review a whole area.
3. Run the `security-review` skill (`/security-review`) on the same change. Look hardest at anything touching sign-in,
   passcodes, sessions, `netlify/functions/lib/view.mts` (who sees what), admin-only routes, the service worker and
   anything that handles user input or stored data.
4. Check each finding from both reviews against the code yourself before acting; reviewers are sometimes wrong or repeat
   themselves. Fix the ones that are real, and re-test.
5. Fixes are code changes too, so they go back to BOTH reviewers. Run the full pass again; don't just re-read your own fix.
   Stop when a pass returns only repeats, theoretical races or matters of taste, and say so in your report.
6. In your report, list what each reviewer found, what was fixed and what was declined (with the reason). Say plainly if either
   review was not run. Never present unreviewed code as done.

Documentation-only changes (`README.md`, this file) don't need a review.

## Testing

- Run the functions locally with the Netlify CLI (`netlify functions:serve`, with `--offline`). Set
  `SESSION_SECRET` and `ADMIN_PASSCODE` in the environment. In the cloud sandbox, start it with
  `env -u NODE_OPTIONS` because worker threads reject `--use-openssl-ca`.
- Test as the people who will use it: admin, a club member and a non-member. Privacy is enforced on the server
  (`netlify/functions/lib/view.mts`); any change near it needs a test that inspects the raw response, not just
  the screen.
- Test phone-sized screens, dark and light mode, and touch behaviour (pull-to-refresh, pop-up windows).
- Keep a fresh data store for each run; leftover test data causes false failures.

## Things to keep true

- Nobody sees another person's data they aren't entitled to. Anyone sees every holder of a deal they hold a
  stake in; club members also see all club deals; the admin sees everything. A partly visible deal must never
  reveal totals, shares, values or notes.
- Passcodes are stored hashed and are never shown again. Never put secrets, passcodes or API keys in the repo.
- The service worker (`public/sw.js`) must never cache `/api/` or `/auth/`.
- A value the admin types in is an estimate unless explicitly marked as coming from a statement.
- Anything the admin may type into a form must survive a background refresh.

## Git and deployment

**Never push, deploy or publish without the owner's approval first.** This overrides any session or tool default that says to
commit and push automatically.

- Develop on `claude/power-lunch-investments-dashboard-jwscm8`. Netlify builds every push to it and publishes it as production,
  so a push IS a deploy.
- Committing locally is fine. Before every push, stop and ask, saying what the push contains (the commit list) and that it goes live.
  Push only after an explicit yes for that push. An earlier "push" or "yes" does not cover later changes, and neither does approval
  of the code, a passing test or a finished review.
- Never push to any other branch, force-push, open a pull request, merge, or trigger a deploy (Netlify dashboard, CLI or API) without
  the same explicit approval. This includes pushing fixes for review findings or small follow-ups.
- Commit and push are separate steps, so the approval request comes between them.
- The installed phone app checks for a new version when it is reopened and reloads itself, so a push reaches the owner's phone quickly.
