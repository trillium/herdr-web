import posthog from "posthog-js";

const POSTHOG_KEY = "phc_rdES87g7CTNjAqWdvCwkxDQSVCJHVpqgYsw6fKPCrA65";
const POSTHOG_HOST = "https://us.i.posthog.com";

export function initAnalytics() {
  if (typeof window === "undefined") {
    return;
  }
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    person_profiles: "always",
    capture_pageview: true,
  });
}
