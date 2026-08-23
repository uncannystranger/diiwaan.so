/* Tenant defaults.

   These are the Diiwaan palette tokens: #FF9F1C primary action, #2EC4B6 emphasis,
   #011627 ink, #FDFFFC canvas. A business tints those tokens; it never replaces
   the design system. */

/* A brand is five colours with defined jobs, plus how they are laid down.
   primary   — the action colour
   emphasis  — the deep structural colour that ink and dark grounds derive from
   accent    — the supporting colour for live states, links and highlights
   base      — the light ground the surfaces are mixed from
   tint      — the soft highlight used for washes and badges */
export const DEFAULT_BRANDING = {
  preset: 'diiwaan',
  primary: '#FF9F1C',
  emphasis: '#011627',
  accent: '#2EC4B6',
  base: '#FDFFFC',
  tint: '#FFE6C2',
  surface: 'aurora',      // aurora | gradient | calm | bold
  theme: 'system',        // what customers see: system | light | dark
  typography: 'diiwaan',  // diiwaan | serif-forward | plain
  logo: '',
  favicon: ''
};

export const DEFAULT_CUSTOMER_EXPERIENCE = {
  headline: 'Join the queue',
  subheading: 'No account, no app. We will keep your place.',
  ticketNote: 'You can leave the waiting area. We will keep your place.',
  calledMessage: 'Your number is being served — come to the desk.',
  closedMessage: 'The queue is closed right now. Please come back during opening hours.',
  pausedMessage: 'The queue is paused for a moment. Please wait before joining.',
  instructions: '',
  requirePhone: false,
  askService: true,
  showPeopleAhead: true,
  showEstimate: true,
  showProgress: true
};

export const DEFAULT_QR = {
  shape: 'square',        // square | rounded | dot
  foreground: '#011627',
  background: '#FDFFFC',
  eyeColor: '',
  eyeStyle: 'square',
  logoOnCode: true,
  logoScale: 0.22,
  quietZone: 4,
  errorCorrection: 'M',   // forced to H when a logo sits on the code
  signHeadline: 'Scan to join the queue',
  signInstruction: 'Ku biir safka — no app needed',
  signFootnote: '',

  /* The customer-facing display: a second screen in the room, showing the code
     and who is being served. Its own settings, because a wall screen is read
     from four metres away and a printed sign from arm's length. */
  displayLayout: 'split',   // split | code | board
  displayShowServing: true,
  displayShowWaiting: true,
  displayShowNext: true,
  displayScale: 1
};

export const DEFAULT_QUEUE_SETTINGS = {
  name: 'Main queue',
  prefix: 'A',
  avgServiceMin: 5,
  opensAt: '08:30',
  closesAt: '17:00'
};
