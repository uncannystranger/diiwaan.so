/* When may the setup wizard take the screen away from the dashboard?
 *
 * This lives on its own because getting it wrong is invisible from the inside
 * and total from the outside. `onboarded` records one thing: that somebody
 * pressed the button at the end of the four-step wizard. It was being read as
 * permission to use the application at all, so any owner who closed the tab on
 * step three — or whose business was created by any route other than the wizard
 * — was returned to "create your queue" on every visit and every refresh, at
 * the root URL, for good. There is no way out of that from the inside, because
 * the only way out is the button on the screen you cannot reach.
 *
 * A named business already has a queue and a working QR code; customers can
 * already join it. Its owner has a desk, and the desk is the product. So:
 *
 *   nothing yet          the wizard, wherever you asked to go
 *   named, unfinished    the desk, unless you asked for /setup
 *   finished             the desk
 */
export function setupClaimsTheScreen(business, routeName) {
  if (!business) return true;                 // nothing to show a desk for
  if (business.onboarded) return false;
  if (!business.name) return true;            // genuinely brand new
  return routeName === 'setup';               // only when actually asked for
}
