/* ==========================================================================
   Kandy's Treats — transactional email templates
   --------------------------------------------------------------------------
   Table-based HTML with inline styles, because that is what mail clients
   actually render. Outlook ignores flexbox and grid entirely, Gmail strips
   <style> blocks in some contexts, and dark-mode clients recolour
   backgrounds they do not understand. So: tables, inline styles, and a plain
   text alternative that carries the whole message on its own.

   WORDING FOLLOWS THE ORDER, NOT A FIXED SCRIPT

   The status names are the database's — New, Preparing, Out, Completed,
   Cancelled — and are never invented here. What changes is how a customer
   hears them, which depends on fulfilment: a pickup order that reaches `Out`
   is ready to collect, and telling that customer their food is "on the way"
   would send them to the door instead of the counter. Same row, same status,
   two sentences.

   NOTHING INTERNAL LEAVES THIS FILE. The payload it renders comes from
   email_payload(), which returns only the customer's own name, order code,
   status, fulfilment, total and paid flag.
   ========================================================================== */

const PINK = "#d4177e";
const PLUM = "#2b0e20";
const INK = "#2c2029";
const MUTED = "#6d5d6a";
const LINE = "#efe6ec";
const SITE = "https://kandystreats.com.ng";

export interface EmailOrder {
  code: string;
  status: string;
  fulfilment: string;
  total: number;
  paid: boolean;
}

export interface EmailPayload {
  notification_id: string;
  type: string;
  title: string;
  message: string;
  to_email: string;
  to_name: string | null;
  order: EmailOrder | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function naira(n: number): string {
  return "₦" + Number(n || 0).toLocaleString("en-NG");
}

/**
 * What to say for a status, given how the order is being fulfilled.
 *
 * Only statuses that exist in the database appear here. Anything else falls
 * back to the notification's own message rather than guessing.
 */
function lineFor(order: EmailOrder | null, fallback: string):
  { headline: string; detail: string } | null {
  if (!order) return null;
  const pickup = order.fulfilment === "pickup";

  switch (order.status) {
    case "New":
      return {
        headline: "We have your order",
        detail: pickup
          ? "It is in the queue. We will let you know the moment it is ready to collect."
          : "It is in the queue. We will let you know when the kitchen starts on it."
      };
    case "Preparing":
      return {
        headline: "Your order is being prepared",
        detail: "It is on the stove now. This is usually the longest part of the wait."
      };
    case "Out":
      return pickup
        ? {
            headline: "Ready for collection",
            detail: "Your order is packed and waiting at the counter. Come whenever suits you."
          }
        : {
            headline: "Your order is on the way",
            detail: "It has left the kitchen with our rider and is heading to you now."
          };
    case "Completed":
      return pickup
        ? { headline: "Collected — enjoy", detail: "Thank you for coming to us. We hope it was worth the trip." }
        : { headline: "Delivered — enjoy", detail: "Thank you for ordering from Kandy's Treats." };
    case "Cancelled":
      return {
        headline: "Your order was cancelled",
        detail: "If you were charged, the payment is handled separately and nothing further " +
                "is needed from you. Reply to this email if anything looks wrong."
      };
    default:
      return { headline: fallback, detail: "" };
  }
}

/** The deep link. Carries the order code only — the page still requires the
 *  customer's own session, so the URL grants nothing on its own. */
function orderUrl(order: EmailOrder | null): string {
  return order
    ? `${SITE}/pages/order-detail.html?id=${encodeURIComponent(order.code)}`
    : `${SITE}/pages/orders.html`;
}

export function render(p: EmailPayload): RenderedEmail {
  const order = p.order;
  const line = lineFor(order, p.title);
  const headline = line ? line.headline : p.title;
  const detail = line && line.detail ? line.detail : p.message;
  const name = p.to_name ? p.to_name.split(/\s+/)[0] : null;
  const url = orderUrl(order);

  const subject = order
    ? `${headline} — ${order.code}`
    : headline;

  const text = [
    name ? `Hi ${name},` : "Hi,",
    "",
    headline + ".",
    detail,
    "",
    order ? `Order: ${order.code}` : "",
    order ? `Total: ${naira(order.total)}${order.paid ? " (paid)" : ""}` : "",
    "",
    `See your order: ${url}`,
    "",
    "Kandy's Treats",
    "Ado-Ekiti / Iworoko",
    SITE
  ].filter((l) => l !== null).join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#faf5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#faf5f7;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;
                  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

      <tr><td style="background:${PLUM};padding:20px 24px;">
        <span style="color:#ffffff;font-size:17px;font-weight:800;letter-spacing:0.2px;">
          Kandy&#39;s Treats</span>
      </td></tr>

      <tr><td style="padding:28px 24px 8px;">
        <p style="margin:0 0 6px;color:${MUTED};font-size:14px;">
          ${name ? "Hi " + esc(name) + "," : "Hi,"}</p>
        <h1 style="margin:0;color:${INK};font-size:22px;line-height:1.25;font-weight:800;">
          ${esc(headline)}</h1>
        ${detail ? `<p style="margin:12px 0 0;color:${MUTED};font-size:15px;line-height:1.55;">${esc(detail)}</p>` : ""}
      </td></tr>

      ${order ? `
      <tr><td style="padding:20px 24px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="border:1px solid ${LINE};border-radius:12px;">
          <tr>
            <td style="padding:14px 16px;color:${MUTED};font-size:13px;">Order</td>
            <td style="padding:14px 16px;color:${INK};font-size:14px;font-weight:700;" align="right">
              ${esc(order.code)}</td>
          </tr>
          <tr>
            <td style="padding:0 16px 14px;color:${MUTED};font-size:13px;">
              ${order.fulfilment === "pickup" ? "Collection" : "Delivery"}</td>
            <td style="padding:0 16px 14px;color:${INK};font-size:14px;font-weight:700;" align="right">
              ${esc(naira(order.total))}${order.paid ? "" : " &middot; unpaid"}</td>
          </tr>
        </table>
      </td></tr>` : ""}

      <tr><td style="padding:22px 24px 4px;" align="center">
        <a href="${esc(url)}"
           style="display:inline-block;background:${PINK};color:#ffffff;text-decoration:none;
                  font-size:15px;font-weight:700;padding:13px 26px;border-radius:999px;">
          See your order</a>
      </td></tr>

      <tr><td style="padding:22px 24px 26px;">
        <p style="margin:0;color:${MUTED};font-size:12px;line-height:1.6;border-top:1px solid ${LINE};padding-top:16px;">
          Kandy&#39;s Treats &middot; Ado-Ekiti / Iworoko<br>
          You are receiving this because you placed an order with us.
          Order updates can be turned off in your account settings.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;

  return { subject, html, text };
}
