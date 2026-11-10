// "Today" in the club's own time zone (not UTC: at 8pm Eastern the UTC date is already tomorrow).
export const appTimeZone = () => Netlify.env.get("APP_TIMEZONE") || "America/New_York";
export const todayStr = (now: Date = new Date()) => now.toLocaleDateString("en-CA", { timeZone: appTimeZone() });
