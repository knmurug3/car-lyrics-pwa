// Exposes any-ascii to the classic scripts (kept out of index.html so the
// Content-Security-Policy can forbid inline scripts)
import anyAscii from './any-ascii.mjs?v=17';
window.anyAscii = anyAscii;
