// The rows npm run push-sales sends to the usage server's sales page (scripts/sales-push.mjs,
// server/sales.mjs): read from the warehouse's v_quote_sales, never worked out again here.

/**
 * Every quote since `since` (test runs left out), with each deal holding its intake PDF, or one
 * row without a deal when there is none.
 * @param {string} since  YYYY-MM-DD, checked by the caller
 */
export const salesRowsSql = (since) => `
SELECT q.session, q.started_at, q.agent, s.deal_id, s.stage_name, s.stage_semantics, s.client_before, s.sold_at, s.days_to_sale, s.sold_within_60_days
FROM v_quotes q LEFT JOIN v_quote_sales s USING (session)
WHERE q.started_at >= TIMESTAMPTZ '${since}'
ORDER BY q.started_at, s.deal_id`;

const iso = (/** @type {unknown} */ v) => {
  if (v === null || v === undefined) return null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const bool = (/** @type {unknown} */ v) => (typeof v === 'boolean' ? v : null);
const int = (/** @type {unknown} */ v) => (v === null || v === undefined || !Number.isSafeInteger(Number(v)) ? null : Number(v));

/**
 * The push, in the server's shapes (salesPushFrom in server/sales.mjs).
 * @param {Record<string, unknown>[]} rows  salesRowsSql's rows, as getRowObjectsJson gives them
 * @param {{builtAt: string, pulledAt: string, since: string}} info
 */
export function toSalesPush(rows, { builtAt, pulledAt, since }) {
  return {
    builtAt: /** @type {string} */ (iso(builtAt)), pulledAt: /** @type {string} */ (iso(pulledAt)), since: /** @type {string} */ (iso(`${since}T00:00:00Z`)),
    rows: rows.map((r) => {
      const deal = int(r.deal_id);
      const days = int(r.days_to_sale);
      return {
        quote: String(r.session),
        startedAt: /** @type {string} */ (iso(r.started_at)),
        agent: typeof r.agent === 'string' && r.agent ? r.agent : null,
        deal,
        stage: deal !== null && typeof r.stage_name === 'string' ? r.stage_name.slice(0, 80) : null,
        open: deal !== null && typeof r.stage_semantics === 'string' ? r.stage_semantics === 'process' : null,
        clientBefore: r.client_before === true,
        soldAt: iso(r.sold_at),
        daysToSale: days !== null && days >= 0 ? days : null,
        sold60: bool(r.sold_within_60_days),
      };
    }),
  };
}
