# Diiwaan frontend storyboard

Reference sources (19 October 2026):
- https://www.awwwards.com/sites/stonehaven — product storytelling and a clear product demonstration beside the opening statement.
- https://www.awwwards.com/inspiration/navigation-micro-animation-eduard-bodak-portfolio — short, staggered arrivals and deliberate navigation feedback.

Desktop: keep the Somali-first brand lockup and primary actions on the left; give the ticket a distinct framed stage on the right. Follow with three numbered steps: scan, receive a number, wait comfortably. The product demonstration uses existing SVG artwork and text, with no new external imagery.

Mobile: one column, actions before the example, then the three steps as a vertical sequence. Large readable ticket, no horizontal scrolling. Onboarding states its current step before the form.

Customer: show connection status consistently; explain reconnection beside the preserved ticket. Keep the identifier stationary and animate only incidental state feedback. Honor both supported languages and reduced motion. Existing server state, joins, ticket persistence and authentication remain authoritative.

Acceptance: six viewport widths, bilingual copy, keyboard focus, reduced-motion overrides, queue-rendering regressions, existing web regression tests. Field performance and authenticated Firebase workflows require configured test accounts and are not implied by view tests.
