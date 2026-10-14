/**
 * GROUP BUY DEMAND CAPTURE — "Bring It Back" and "Request a New Group Buy".
 *
 * Slice 13. Posts to `/apps/carat/group-buy-interest`
 * (app/app/routes/apps.carat.group-buy-interest.tsx), and reads the
 * disclosure it must show from `/apps/carat/policies?slug=…`.
 *
 * ============================================================================
 * THE DISCLOSURE IS FETCHED, NEVER WRITTEN HERE. THE BUTTON WAITS FOR IT.
 * ============================================================================
 * This is the one rule in this file that is about evidence rather than UX.
 *
 * Owner decision: the submit button IS the affirmative action — there is no
 * tickbox. The server records, against every captured address, the exact
 * disclosure text and the exact button caption. If the theme printed its own
 * copy of that disclosure, the two could drift, and the evidence row would
 * then assert that someone read words that were never on their screen.
 *
 * So the disclosure comes from the same versioned row the server records, and
 * THE SUBMIT BUTTON STAYS DISABLED UNTIL IT IS ON THE PAGE. A form that can
 * be submitted while the terms failed to load is a form that manufactures
 * false consent, which is strictly worse than a form that is temporarily
 * unavailable.
 *
 * THE BUTTON CAPTIONS BELOW ARE SERVER CONSTANTS, mirrored here because the
 * caption must be rendered before any request is made. They are pinned by
 * `app/app/theme/groupBuyDemandCaptureSurface.test.ts`, which reads both this
 * file and `demandCaptureCopy.ts` and fails if they diverge. Do not reword
 * either side alone.
 *
 * ============================================================================
 * FORM DATA, NOT JSON
 * ============================================================================
 * The endpoint reads `request.formData()`. Posting JSON here produces a 400
 * listing every field as missing, which looks like a validation bug rather
 * than a content-type mistake.
 *
 * ============================================================================
 * THE RESPONSE IS DELIBERATELY UNINFORMATIVE, AND SO IS THIS
 * ============================================================================
 * The endpoint returns the same body whether an address was newly recorded or
 * already on file, so that nobody can use it to ask "is this person watching
 * this campaign". This file must not try to be more helpful than that — it
 * prints the server's confirmation message and nothing inferred.
 */
(function () {
  "use strict";

  var SUBMIT_ENDPOINT = "/apps/carat/group-buy-interest";
  var POLICY_ENDPOINT = "/apps/carat/policies";

  /** Mirrors `demandCaptureCopy.ts`. Fenced by a test — see the header. */
  var KINDS = {
    bring_it_back: {
      slug: "group-buy-bring-it-back-notification",
      label: "Email me if this runs again",
      heading: "Want this one back?",
    },
    new_campaign_request: {
      slug: "group-buy-new-campaign-request",
      label: "Send my request",
      heading: "Request a new Group Buy",
    },
  };

  /**
   * The server enumerates problems so a field can be marked rather than the
   * whole form scolded. These are the customer-facing sentences for each.
   */
  var PROBLEM_TEXT = {
    email_missing: "Please enter your email address.",
    email_malformed: "That email address does not look right.",
    email_too_long: "That email address is too long.",
    campaign_required: "We could not tell which Group Buy this is about. Please refresh and try again.",
    campaign_not_allowed: "This form is for a new Group Buy, so it cannot name an existing one.",
    note_required: "Please tell us what you are looking for.",
    note_too_long: "Please shorten your note.",
    unknown_kind: "Something went wrong with this form. Please refresh and try again.",
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fieldId(host, name) {
    return "carat-gbi-" + name + "-" + host.getAttribute("data-field-seq");
  }

  function build(host, kind, config) {
    var form = el("form", "carat-gb-interest__form");
    form.setAttribute("novalidate", "novalidate");

    // The campaign's own name is already the heading of the archive entry
    // this form sits inside, so it is not repeated here.
    form.appendChild(el("h4", "carat-gb-interest__heading", config.heading));

    // ---- email -------------------------------------------------------
    var emailId = fieldId(host, "email");
    var emailLabel = el("label", "carat-gb-interest__label", "Your email");
    emailLabel.setAttribute("for", emailId);
    var email = document.createElement("input");
    email.type = "email";
    email.name = "email";
    email.id = emailId;
    email.className = "carat-gb-interest__input";
    email.setAttribute("autocomplete", "email");
    email.required = true;
    form.appendChild(emailLabel);
    form.appendChild(email);

    // ---- note, for a new-campaign request only -------------------------
    var note = null;
    if (kind === "new_campaign_request") {
      var noteId = fieldId(host, "note");
      var noteLabel = el("label", "carat-gb-interest__label", "What would you like us to run?");
      noteLabel.setAttribute("for", noteId);
      note = document.createElement("textarea");
      note.name = "note";
      note.id = noteId;
      note.rows = 3;
      note.className = "carat-gb-interest__input carat-gb-interest__input--note";
      note.required = true;
      form.appendChild(noteLabel);
      form.appendChild(note);
    }

    // ---- the disclosure, filled in once it loads -----------------------
    var disclosure = el("div", "carat-gb-interest__disclosure");
    disclosure.appendChild(el("p", "carat-gb-interest__disclosure-pending", "Loading the terms…"));
    form.appendChild(disclosure);

    // ---- the affirmative action ----------------------------------------
    var submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "carat-gb-interest__submit";
    submit.textContent = config.label;
    // Disabled until the disclosure is on the page. See the header.
    submit.disabled = true;
    form.appendChild(submit);

    var status = el("p", "carat-gb-interest__status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    form.appendChild(status);

    return { form: form, email: email, note: note, disclosure: disclosure, submit: submit, status: status };
  }

  function loadDisclosure(parts, config) {
    return fetch(POLICY_ENDPOINT + "?slug=" + encodeURIComponent(config.slug), {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    })
      .then(function (response) {
        if (!response.ok) throw new Error("status " + response.status);
        return response.json();
      })
      .then(function (payload) {
        var terms = (payload && payload.terms) || [];
        if (terms.length === 0 || !terms[0].text) throw new Error("no term");

        parts.disclosure.textContent = "";
        // Verbatim, as text — this is the sentence the evidence row will
        // record against whoever presses the button.
        parts.disclosure.appendChild(
          el("p", "carat-gb-interest__disclosure-text", terms[0].text)
        );
        parts.submit.disabled = false;
      })
      .catch(function () {
        parts.disclosure.textContent = "";
        parts.disclosure.appendChild(
          el(
            "p",
            "carat-gb-interest__disclosure-error",
            "We could not load the terms for this form just now, so it is unavailable. Please refresh and try again."
          )
        );
        // Stays disabled. A submission without a shown disclosure is one we
        // could not honestly record.
        parts.submit.disabled = true;
      });
  }

  function showProblems(parts, problems) {
    parts.status.className = "carat-gb-interest__status carat-gb-interest__status--error";
    var sentences = [];
    for (var i = 0; i < problems.length; i += 1) {
      var text = PROBLEM_TEXT[problems[i]];
      if (text && sentences.indexOf(text) === -1) sentences.push(text);
    }
    if (sentences.length === 0) sentences.push("Please check the form and try again.");
    parts.status.textContent = sentences.join(" ");
  }

  function submitForm(host, kind, parts, event) {
    event.preventDefault();
    if (parts.submit.disabled) return;

    parts.submit.disabled = true;
    parts.status.className = "carat-gb-interest__status";
    parts.status.textContent = "Sending…";

    var body = new FormData();
    body.append("kind", kind);
    body.append("email", parts.email.value);
    if (kind === "bring_it_back") {
      body.append("campaignRef", host.getAttribute("data-campaign-ref") || "");
    }
    if (parts.note) body.append("note", parts.note.value);

    fetch(SUBMIT_ENDPOINT, { method: "POST", body: body, credentials: "same-origin" })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { status: response.status, payload: payload };
        });
      })
      .then(function (result) {
        if (result.status === 200 && result.payload && result.payload.ok) {
          // The server's own confirmation, printed as sent. Nothing is
          // inferred about whether this address was already on file.
          parts.form.textContent = "";
          parts.form.appendChild(
            el("p", "carat-gb-interest__confirmation", result.payload.message || "Thanks — we've got it.")
          );
          return;
        }

        if (result.status === 400 && result.payload && result.payload.problems) {
          showProblems(parts, result.payload.problems);
          parts.submit.disabled = false;
          return;
        }

        parts.status.className = "carat-gb-interest__status carat-gb-interest__status--error";
        parts.status.textContent =
          result.status === 503
            ? "This form is not available just yet. Please try again shortly."
            : "We could not send that just now. Please try again.";
        parts.submit.disabled = false;
      })
      .catch(function () {
        parts.status.className = "carat-gb-interest__status carat-gb-interest__status--error";
        parts.status.textContent = "We could not send that just now. Please try again.";
        parts.submit.disabled = false;
      });
  }

  var seq = 0;

  function mount(host) {
    if (host.getAttribute("data-carat-mounted") === "true") return;
    host.setAttribute("data-carat-mounted", "true");
    host.setAttribute("data-field-seq", String((seq += 1)));

    var kind = host.getAttribute("data-carat-group-buy-interest");
    var config = KINDS[kind];
    if (!config) return;

    var parts = build(host, kind, config);
    host.textContent = "";
    host.appendChild(parts.form);

    loadDisclosure(parts, config);

    parts.form.addEventListener("submit", function (event) {
      submitForm(host, kind, parts, event);
    });
  }

  /**
   * Exposed because the archive renders its per-campaign hosts AFTER this
   * script has already run — `past-group-buys.js` calls back into here once
   * the campaigns are in the document.
   */
  function init(root) {
    var scope = root || document;
    var hosts = scope.querySelectorAll("[data-carat-group-buy-interest]");
    for (var i = 0; i < hosts.length; i += 1) mount(hosts[i]);
  }

  window.CaratGroupBuyInterest = { init: init };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      init();
    });
  } else {
    init();
  }
})();
