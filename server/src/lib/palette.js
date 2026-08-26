/* The Diiwaan house palette, as the server knows it.

   Five seeds, and every colour the product shows is derived from them. The
   browser derives its own from the same five in CSS custom properties; this is
   the copy the parts that never touch a browser need — the branding a new
   business is created with, the default QR, and the PDF report, which is drawn
   in a process with no stylesheet to read.

   Keeping it here rather than inline at each of those three sites is the point.
   They had drifted: every one of them still carried the previous generation of
   the palette (#FF9F1C amber over #011627 navy) long after the interface moved
   to #E0912F over #04121D, so a business created through the API was born in
   one brand while the app it opened in painted another, and its printed report
   disagreed with both.

   If these five ever change, they change here and in the --p-* block of
   web/css/diiwaan.css, which is the browser's copy of this same decision. The
   two are checked against each other by test:palette. */

export const HOUSE_PALETTE = {
  primary: '#E0912F',   // lamp amber — the action colour
  emphasis: '#04121D',  // harbour navy — ink and dark grounds derive from it
  accent: '#3AA69B',    // still water — live states, links, highlights
  base: '#FBFCFA',      // the off-white surfaces are mixed from
  tint: '#25506E'       // harbour blue at depth — washes, glass, badges
};

/* Ink on paper, for surfaces the browser never renders: the PDF report and a
   QR code saved to a file. Both are read on white, so neither follows the
   viewer's theme. */
export const PRINT = {
  ink: HOUSE_PALETTE.emphasis,
  paper: HOUSE_PALETTE.base,
  accent: HOUSE_PALETTE.primary
};
