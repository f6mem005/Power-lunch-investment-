import type { Config } from "@netlify/functions";
import { checkSplits } from "./lib/splits.mts";

// Runs once a day on the published site, and adjusts share counts for any stock split dated after the count was set.
export default async () => {
  const s = await checkSplits();
  console.log("split check:", s.ok ? "ok" : "problem", "-", s.message);
};

export const config: Config = { schedule: "0 13 * * *" }; // 13:00 UTC = 8am Eastern (9am in summer)
