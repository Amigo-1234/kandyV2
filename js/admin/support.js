/* ==========================================================================
   Kandy's Treats — Support Center
   --------------------------------------------------------------------------
   One workspace over three existing systems. Nothing here is a second
   implementation:

     Live Chat        embeds KT.admin.chatPanel from js/admin/chat.js
     Tickets          support_tickets + support_ticket_replies
     Contact messages contact_messages

   Statuses are the ones already in the schema (open|answered|closed and
   new|read|answered), not a new vocabulary.

   Role behaviour is not decided here. Staff genuinely receive zero contact
   messages because RLS restricts that table to is_manager() — the tab shows
   an explanatory empty state rather than pretending the data is hidden by
   the interface.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = KT.admin.views || {};

  var TABS = [
    { id: "chat",     label: "Live chat" },
    { id: "tickets",  label: "Tickets" },
    { id: "contacts", label: "Contact messages" }
  ];

  var svc = null, searchTimer = null;
  var state = {
    tab: "chat",
    role: "staff",
    tickets: [], ticketStatus: "all", ticketSearch: "",
    activeTicket: null, replies: [],
    contacts: [], contactStatus: "all", contactSearch: "",
    loading: false, error: null
  };

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function when(d) {
    if (!d) return "";
    return new Date(d).toLocaleString("en-NG",
      { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function badge(status) {
    return '<span class="sbadge sbadge--' + status + '">' + status + "</span>";
  }

  /* ---- Shell ------------------------------------------------------------ */

  function chrome(inner) {
    return (
      '<header class="apage__head"><div><h1>Support</h1>' +
        '<p class="apage__lede">Live chat, tickets and contact messages in one place.</p></div></header>' +
      '<div class="stabs" role="tablist">' +
        TABS.map(function (t) {
          return '<button class="stab' + (t.id === state.tab ? " is-active" : "") +
            '" type="button" role="tab" aria-selected="' + (t.id === state.tab) +
            '" data-stab="' + t.id + '">' + t.label +
            (t.id === "contacts" && state.contacts.length
              ? ' <span class="stab__count">' + state.contacts.filter(function (c) {
                  return c.status === "new"; }).length + "</span>" : "") +
            "</button>";
        }).join("") +
      "</div>" +
      '<div class="spanel" data-support-body>' + inner + "</div>"
    );
  }

  function paint(inner) {
    var el = KT.qs("[data-admin-page]");
    if (el) KT.mount(el, chrome(inner));
  }

  function paintBody(inner) {
    var el = KT.qs("[data-support-body]");
    if (el) el.innerHTML = inner;
    else paint(inner);
  }

  /* ---- Tickets ---------------------------------------------------------- */

  function ticketListHTML() {
    var filters =
      '<div class="sfilters">' +
        '<input class="input sfilters__search" type="search" data-ticket-search ' +
          'placeholder="Search subject, message or order…" value="' + esc(state.ticketSearch) + '">' +
        '<div class="chips">' +
          ["all"].concat(svc ? svc.TICKET_STATUSES : []).map(function (s) {
            return '<button class="chip' + (state.ticketStatus === s ? " is-active" : "") +
              '" type="button" data-ticket-status="' + s + '">' + s + "</button>";
          }).join("") +
        "</div>" +
      "</div>";

    if (state.loading) return filters + KT.skeleton.lines(4);
    if (state.error) {
      return filters + '<div class="empty"><div class="empty__art">' + KT.icon("close", 30) +
        "</div><h3>Could not load tickets</h3><p>" + esc(state.error) +
        '</p><button class="btn btn--soft" type="button" data-support-reload>Try again</button></div>';
    }
    if (!state.tickets.length) {
      return filters + '<div class="empty"><div class="empty__art">' + KT.icon("mail", 30) +
        "</div><h3>No tickets" + (state.ticketStatus !== "all" || state.ticketSearch ? " match that filter" : " yet") +
        "</h3><p>Support requests raised from a customer's account page appear here.</p></div>";
    }

    return filters + '<div class="slist">' + state.tickets.map(function (t) {
      return '<button class="scard" type="button" data-ticket="' + t.id + '">' +
        '<div class="scard__top"><strong>' + esc(t.subject) + "</strong>" + badge(t.status) + "</div>" +
        '<p class="scard__body">' + esc(t.message).slice(0, 120) + "</p>" +
        '<div class="scard__meta"><span>#' + t.ref + "</span>" +
          (t.orderRef ? "<span>" + esc(t.orderRef) + "</span>" : "") +
          "<span>Updated " + when(t.updatedAt) + "</span></div>" +
      "</button>";
    }).join("") + "</div>";
  }

  function ticketDetailHTML() {
    var t = state.activeTicket;
    if (!t) return "";
    var canManage = KT.admin.rank(state.role) >= KT.admin.rank("staff");
    return (
      '<div class="sdetail">' +
        '<button class="btn btn--ghost btn--sm sdetail__back" type="button" data-ticket-back>' +
          KT.icon("arrowLeft", 16) + "Back to tickets</button>" +
        '<div class="sdetail__head"><div><h2>' + esc(t.subject) + "</h2>" +
          '<p class="sdetail__meta">#' + t.ref + " · raised " + when(t.createdAt) +
          (t.orderRef ? " · order " + esc(t.orderRef) : "") + "</p></div>" + badge(t.status) + "</div>" +

        '<div class="sdetail__msg">' + esc(t.message) + "</div>" +

        (state.replies.length
          ? '<div class="sthread">' + state.replies.map(function (r) {
              return '<div class="chat__row ' + (r.fromStaff ? "is-mine" : "is-them") + '">' +
                '<div class="chat__bubble">' +
                  '<span class="chat__who">' + esc(r.authorRole) + "</span>" +
                  '<span class="chat__body">' + esc(r.body) + "</span>" +
                  '<time class="chat__time">' + when(r.createdAt) + "</time>" +
                "</div></div>";
            }).join("") + "</div>"
          : '<p class="sdetail__none">No replies yet.</p>') +

        (canManage
          ? '<form class="chat__compose sdetail__reply" data-ticket-reply>' +
              '<input class="chat__input" name="body" autocomplete="off" ' +
                'placeholder="Reply to the customer…" aria-label="Reply">' +
              '<button class="chat__send btn btn--primary" type="submit" aria-label="Send">' +
                KT.icon("arrowRight", 18) + "</button></form>" +
            '<div class="sdetail__actions">' +
              (svc ? svc.TICKET_STATUSES : []).map(function (s) {
                return '<button class="btn btn--soft btn--sm" type="button" data-ticket-set="' + s +
                  '"' + (t.status === s ? " disabled" : "") + ">Mark " + s + "</button>";
              }).join("") +
            "</div>"
          : "") +
      "</div>"
    );
  }

  /* ---- Contact messages -------------------------------------------------- */

  function contactsHTML() {
    if (KT.admin.rank(state.role) < KT.admin.rank("admin")) {
      return '<div class="empty"><div class="empty__art">' + KT.icon("lock", 30) + "</div>" +
        "<h3>Contact messages are manager-only</h3>" +
        "<p>Enquiries from the public contact form include a phone number, so the database " +
        "restricts them to admin and owner. Your role is <strong>" + esc(state.role) +
        "</strong>.</p></div>";
    }

    var filters =
      '<div class="sfilters">' +
        '<input class="input sfilters__search" type="search" data-contact-search ' +
          'placeholder="Search name, message or phone…" value="' + esc(state.contactSearch) + '">' +
        '<div class="chips">' +
          ["all"].concat(svc ? svc.CONTACT_STATUSES : []).map(function (s) {
            return '<button class="chip' + (state.contactStatus === s ? " is-active" : "") +
              '" type="button" data-contact-status="' + s + '">' + s + "</button>";
          }).join("") +
        "</div>" +
      "</div>";

    if (state.loading) return filters + KT.skeleton.lines(4);
    if (!state.contacts.length) {
      return filters + '<div class="empty"><div class="empty__art">' + KT.icon("mail", 30) +
        "</div><h3>No contact messages" +
        (state.contactStatus !== "all" || state.contactSearch ? " match that filter" : " yet") +
        "</h3><p>Messages from the storefront contact form appear here.</p></div>";
    }

    return filters + '<div class="slist">' + state.contacts.map(function (c) {
      return '<article class="scard scard--static' + (c.status === "new" ? " is-unread" : "") + '">' +
        '<div class="scard__top"><strong>' + esc(c.name) + "</strong>" + badge(c.status) + "</div>" +
        '<p class="scard__body">' + esc(c.message) + "</p>" +
        '<div class="scard__meta"><span>' + esc(KT.rules.displayPhone(c.phone)) + "</span>" +
          "<span>" + when(c.createdAt) + "</span>" +
          "<span>" + esc(c.source) + "</span></div>" +
        '<div class="scard__actions">' +
          (svc ? svc.CONTACT_STATUSES : []).map(function (s) {
            return '<button class="btn btn--soft btn--sm" type="button" data-contact-set="' + c.id +
              '|' + s + '"' + (c.status === s ? " disabled" : "") + ">Mark " + s + "</button>";
          }).join("") +
        "</div>" +
      "</article>";
    }).join("") + "</div>";
  }

  /* ---- Loading ----------------------------------------------------------- */

  async function ensureSvc() {
    if (!svc) svc = (await import("../services/admin-support.js")).adminSupportService;
    return svc;
  }

  async function loadTickets() {
    await ensureSvc();
    /* Remember which tab asked. A slow response must not repaint over a tab
       the user has since switched to — that silently replaced the Contacts
       view with the ticket list. */
    var forTab = state.tab;
    state.loading = true; state.error = null;
    if (state.tab === forTab) paintBody(ticketListHTML());
    try {
      state.tickets = await svc.tickets({ status: state.ticketStatus, search: state.ticketSearch });
      state.loading = false;
    } catch (error) {
      state.loading = false;
      state.error = KT.services.errorMessage(error);
    }
    if (state.tab !== forTab) return;
    paintBody(ticketListHTML());
  }

  async function loadContacts() {
    await ensureSvc();
    var forTab = state.tab;
    state.loading = true;
    if (state.tab === forTab) paintBody(contactsHTML());
    try {
      state.contacts = await svc.contacts({ status: state.contactStatus, search: state.contactSearch });
    } catch (error) {
      state.contacts = [];         /* RLS returns nothing for staff — not an error */
    }
    state.loading = false;
    if (state.tab !== forTab) return;
    paint(contactsHTML());          /* full repaint keeps the tab count in step */
  }

  async function openTicket(id) {
    await ensureSvc();
    try {
      state.activeTicket = await svc.ticket(id);
      state.replies = await svc.replies(id);
      paintBody(ticketDetailHTML());
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error");
    }
  }

  function showTab(tab) {
    state.tab = tab;
    if (tab !== "chat" && KT.admin.chatPanel) KT.admin.chatPanel.teardown();
    paint("");
    var body = KT.qs("[data-support-body]");
    if (tab === "chat") {
      if (KT.admin.chatPanel) KT.admin.chatPanel.mount(body);
    } else if (tab === "tickets") {
      state.activeTicket = null;
      loadTickets();
    } else {
      loadContacts();
    }
  }

  /* ---- Events ------------------------------------------------------------ */

  document.addEventListener("click", async function (e) {
    var tab = e.target.closest("[data-stab]");
    if (tab) { e.preventDefault(); showTab(tab.getAttribute("data-stab")); return; }

    var t = e.target.closest("[data-ticket]");
    if (t) { e.preventDefault(); openTicket(t.getAttribute("data-ticket")); return; }

    if (e.target.closest("[data-ticket-back]")) {
      e.preventDefault(); state.activeTicket = null; paintBody(ticketListHTML()); return;
    }
    if (e.target.closest("[data-support-reload]")) { e.preventDefault(); loadTickets(); return; }

    var fs = e.target.closest("[data-ticket-status]");
    if (fs) { e.preventDefault(); state.ticketStatus = fs.getAttribute("data-ticket-status"); loadTickets(); return; }

    var cs = e.target.closest("[data-contact-status]");
    if (cs) { e.preventDefault(); state.contactStatus = cs.getAttribute("data-contact-status"); loadContacts(); return; }

    var setT = e.target.closest("[data-ticket-set]");
    if (setT && state.activeTicket) {
      e.preventDefault();
      var done = KT.busy(setT, "Saving…");
      if (!done) return;
      try {
        await svc.setTicketStatus(state.activeTicket.id, setT.getAttribute("data-ticket-set"));
        await openTicket(state.activeTicket.id);
        KT.toast("Ticket updated.", "success");
      } catch (error) {
        KT.toast(KT.services.errorMessage(error), "error");
      } finally { done(); }
      return;
    }

    var setC = e.target.closest("[data-contact-set]");
    if (setC) {
      e.preventDefault();
      var parts = setC.getAttribute("data-contact-set").split("|");
      var done2 = KT.busy(setC, "Saving…");
      if (!done2) return;
      try {
        await svc.setContactStatus(parts[0], parts[1]);
        await loadContacts();
        KT.toast("Message updated.", "success");
      } catch (error) {
        KT.toast(KT.services.errorMessage(error), "error");
      } finally { done2(); }
    }
  });

  document.addEventListener("input", function (e) {
    var ts = e.target.closest("[data-ticket-search]");
    if (ts) {
      state.ticketSearch = ts.value;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(loadTickets, 280);   /* debounced */
      return;
    }
    var cs = e.target.closest("[data-contact-search]");
    if (cs) {
      state.contactSearch = cs.value;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(loadContacts, 280);
    }
  });

  document.addEventListener("submit", async function (e) {
    var form = e.target.closest("[data-ticket-reply]");
    if (!form || !state.activeTicket) return;
    e.preventDefault();
    var input = KT.qs(".chat__input", form);
    var text = input.value.trim();
    if (!text) return;
    var done = KT.busy(KT.qs(".chat__send", form), "");
    input.value = "";
    try {
      await svc.reply(state.activeTicket.id, text);
      await openTicket(state.activeTicket.id);
    } catch (error) {
      input.value = text;
      KT.toast(KT.services.errorMessage(error), "error", { duration: 5000 });
    } finally { if (done) done(); }
  });

  /* ---- View ------------------------------------------------------------- */

  KT.admin.views.support = function (ctx) {
    state.role = ctx.role;
    state.tab = "chat";
    state.activeTicket = null;
    window.setTimeout(function () { showTab("chat"); }, 0);
    return chrome(KT.loadingLabel("Loading support…") + KT.skeleton.lines(4));
  };

  /* Called by the shell on navigation away — the chat channel must not leak. */
  KT.admin.views.supportTeardown = function () {
    if (KT.admin.chatPanel) KT.admin.chatPanel.teardown();
    window.clearTimeout(searchTimer);
  };
})(window.KT || (window.KT = {}));
