import { redirect, type Handle } from "@sveltejs/kit";
import { isEnabled, FF_SVELTEKIT_FRONTEND } from "~/flags";

// KDI-UI-000: the whole SvelteKit UI is gated by FF_SVELTEKIT_FRONTEND. When
// disabled, every route except /disabled bounces to /disabled so the app never
// serves the operator UI with the flag off. ponytail: single hook guard rather
// than per-route checks.
export const handle: Handle = async ({ event, resolve }) => {
  const enabled = isEnabled(FF_SVELTEKIT_FRONTEND);
  const onDisabled = event.url.pathname === "/disabled";
  // KDI-UI-001: exempt /api/* so the bridge routes can return their own
  // spec-defined 503 { enabled:false } when the flag is off (feature-detect for
  // machine clients) instead of a 307 redirect to the HTML /disabled page.
  // ponytail: one pathname guard; human pages still get the /disabled redirect.
  const isApi = event.url.pathname.startsWith("/api/");

  if (!enabled && !onDisabled && !isApi) {
    throw redirect(307, "/disabled");
  }
  if (enabled && onDisabled) {
    throw redirect(307, "/");
  }
  return resolve(event);
};