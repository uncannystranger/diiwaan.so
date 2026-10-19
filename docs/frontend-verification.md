# Frontend review verification — 19 October 2026

- `node --test web/test/*.mjs`: 11 top-level tests passed (existing regression files plus two bilingual view scenarios).
- JavaScript syntax checks and `git diff --check`: passed.
- Browser inspected at 320, 390, 768, 1024, 1440, 1920px: three journey steps visible in the document, no document overflow after containing the decorative glow.
- Real disposable local queue: customer joined Hodan Clinic, received A-6 and saw live status. This used local MongoDB fixtures; it did not modify a hosted queue.
- Ticket view scenarios cover waiting/called, live/offline/reconnecting, preserved identifier, HTML escaping, bilingual copy and current onboarding step.
- No server/API/data/authentication files changed. Fixed a frontend idle timer that dereferenced an unresolved route during slow startup.
- Reduced-motion CSS is retained and extended. Physical-device behavior, field Core Web Vitals, browser media-preference emulation, real Firebase sign-in and hosted owner workflows have not been verified in this pass.
- Existing dependency audit reports five findings; broad dependency upgrades are outside this presentation change.

The local review capture includes a development-only Google configuration explanation because Firebase test credentials are intentionally placeholders. No production credentials were used.
