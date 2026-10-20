# Diiwaan frontend storyboard

Reference sources (19 October 2026):
- https://www.awwwards.com/sites/stonehaven — product storytelling and a clear product demonstration beside the opening statement.
- https://www.awwwards.com/inspiration/navigation-micro-animation-eduard-bodak-portfolio — short, staggered arrivals and deliberate navigation feedback.

Desktop: keep the Somali-first brand lockup and primary actions on the left; give the ticket a distinct framed stage on the right. Follow with three numbered steps: scan, receive a number, wait comfortably. The product demonstration uses existing SVG artwork and text, with no new external imagery.

Mobile: one column, actions before the example, then the three steps as a vertical sequence. Large readable ticket, no horizontal scrolling. Onboarding states its current step before the form.

Customer: show connection status consistently; explain reconnection beside the preserved ticket. Keep the identifier stationary and animate only incidental state feedback. Honor both supported languages and reduced motion. Existing server state, joins, ticket persistence and authentication remain authoritative.

Acceptance: six viewport widths, bilingual copy, keyboard focus, reduced-motion overrides, queue-rendering regressions, existing web regression tests. Field performance and authenticated Firebase workflows require configured test accounts and are not implied by view tests.

## Technology design study: Giga

Awwwards technology source: https://www.awwwards.com/sites/giga
Specific composition and motion: https://www.awwwards.com/inspiration/how-it-works-build-observe-improve-giga
Rail: https://www.awwwards.com/inspiration/the-rail-and-its-page-index-giga

Desktop: oversized masked two-line product heading; a framed machine with a numbered rail and three selectable stages. Adapt Giga's staged product explanation to scan, ticket and wait. Each stage enters with opacity, translation and a brief blur; ticket numbers remain stationary. The QR scan beam describes scanning rather than suggesting a real code. It is decorative and explicitly illustrative.

Mobile: narrative precedes the full-width machine; all three controls remain visible. Story cards become a single column. The same content, language switch and theme controls remain available. Reduced motion disables the beam, heading and stage animations entirely.

`/design-preview.html` renders the real landing component with a visible frontend-preview label and illustrative queue. It makes no API or identity initialization calls. Signup and sign-in still lead to the real application. The authenticated application and its boot/recovery contracts are unchanged.
