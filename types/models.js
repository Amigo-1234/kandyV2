/* ==========================================================================
   Kandy's Treats — shared shapes
   JSDoc typedefs so `npm run typecheck` can check the front end without
   converting a working vanilla-JS codebase to TypeScript.
   ========================================================================== */

/**
 * @typedef {Object} MenuItem
 * @property {string} id            Firestore doc id — what the server prices against
 * @property {string} name
 * @property {number} price         whole Naira
 * @property {string} category      foods|proteins|sides|specials|soups|shawarma|drinks
 * @property {string} section       the Firestore `section` value
 * @property {'available'|'sold-out'} status
 * @property {string|null} image    key into js/data/images.js
 * @property {string} [imageUrl]    admin-uploaded Storage URL, wins over `image`
 * @property {string[]} [gallery]
 * @property {string} blurb
 * @property {string} description
 * @property {string[]} tags
 * @property {number} [rating]
 */

/**
 * @typedef {Object} CartLine
 * @property {string} menuId
 * @property {number} qty
 */

/**
 * @typedef {Object} Totals
 * @property {number} count
 * @property {number} subtotal
 * @property {number} takeawayFee
 * @property {number} deliveryFee
 * @property {number} discount
 * @property {number} netAmount
 * @property {number} processingFee
 * @property {number} total
 * @property {'delivery'|'pickup'} fulfilment
 * @property {'gateway'|'wallet'} paymentMode
 * @property {number} eta
 */

/**
 * @typedef {Object} Address
 * @property {string} id
 * @property {string} userId
 * @property {string} label
 * @property {string} recipientName
 * @property {string} phone         normalised to 234XXXXXXXXXX
 * @property {string} address       typed by the customer — Lagos State only
 * @property {string} notes
 * @property {boolean} isDefault
 */

/**
 * @typedef {Object} Order
 * @property {string} id            KD-{ms}-{nnn}
 * @property {string} userId
 * @property {'New'|'Preparing'|'Out'|'Completed'} status
 * @property {Array<{status:string,label:string,atMs:number}>} statusHistory
 * @property {'delivery'|'pickup'|'mixed'} fulfilment
 * @property {boolean} paid
 * @property {string} paymentStatus
 * @property {number} subtotal
 * @property {number} deliveryFee
 * @property {number} takeawayFee
 * @property {number} discount
 * @property {number} processingFee
 * @property {number} total
 */

export {};
