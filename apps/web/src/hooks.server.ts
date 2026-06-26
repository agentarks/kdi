import { redirect, type Handle } from "@sveltejs/kit";

// KDI-UI-000: the whole SvelteKit UI is gated by FF_SVELTEKIT_FRONTEND (server
// env). When disabled, every route except /disabled bounces to /disabled so the
// app never serves the operator UI with the flag off. ponytail: single hook
// guard rather than per-route checks.
export const handle: Handle = async ({ event, resolve }) => {
  const enabled = process.env.FF_SVELTEKIT_FRONTEND === "true";
  const onDisabled = event.url.pathname.startsWith("/disabled");

  if (!enabled && !onDisabled) {
    throw redirect(307, "/disabled");
  }
  if (enabled && onDisabled) {
    throw redirect(307, "/");
  }
  return resolve(event);
};