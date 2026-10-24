// Preloaded into the production server (see Dockerfile CMD) so the request
// log never records a query string.
//
// WHY THIS FILE EXISTS. The production server is `react-router-serve`, which
// always installs `morgan("tiny")` — ":method :url :status ..." — and offers
// no option to change or disable it. morgan's `:url` token is the full
// originalUrl, so every embedded-admin page load was logging Shopify's
// `id_token` (a signed session JWT), `hmac` and `session` values, and every
// App Proxy request was logging its `signature` and `logged_in_customer_id`.
// Session tokens and customer identifiers must never reach logs (CLAUDE.md,
// Security and privacy).
//
// HOW IT WORKS. morgan resolves tokens at request time (`tokens[name](...)` in
// its compiled format), so redefining the `url` token on the one shared morgan
// instance changes what "tiny" prints without touching react-router-serve.
// The method, path, status and timing remain, which is all the log needs.
//
// It is plain CommonJS outside app/ on purpose: it is loaded with
// `node --require` before the server starts, not bundled into the build.

const morgan = require("morgan");

function pathOnly(req) {
  const url = req.originalUrl || req.url || "";
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

morgan.token("url", pathOnly);

module.exports = { pathOnly };
