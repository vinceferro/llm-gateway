/**
 * Dated, sourced LIST-PRICE table for counterfactual reporting.
 *
 * Honesty rules enforced here (the math lives in src/report.ts):
 *  - every entry carries provenance: source + asOf + verified flag
 *  - unverified entries are ZERO-priced placeholders: they are NEVER used in
 *    counterfactual math — workload rows priced against them are EXCLUDED from
 *    savings with an "unverified pricing" warning instead of inventing numbers
 *  - the operator can verify a placeholder via `report.prices` in
 *    llm-gateway.json (an operator-supplied price IS the attestation, marked
 *    verified: true), or override the counterfactual baseline entirely via
 *    `report.baseline` (table id or inline rates)
 *
 * NOTE: list prices are the counterfactual DENOMINATOR ONLY — the gateway's
 * own metering (ledger usd) always uses provider `pricing` from the config,
 * never this table.
 */

import type { ReportConfig } from "./config.ts";

export interface ListPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  /** where this number came from (docs host, or the operator's attestation) */
  source: string;
  /** "YYYY-MM-DD" the rate was checked, "unverified", or "operator-configured" */
  asOf: string;
  verified: boolean;
}

export const LIST_PRICES: Record<string, ListPrice> = {
  "deepseek-v4-flash": {
    input_per_mtok: 0.22,
    output_per_mtok: 0.66,
    source: "api-docs.deepseek.com",
    asOf: "2026-08-28",
    verified: true,
  },
  "glm-4.6": {
    input_per_mtok: 0,
    output_per_mtok: 0,
    source: "PLACEHOLDER — Z.ai list price not yet verified by the operator (set report.prices in llm-gateway.json)",
    asOf: "unverified",
    verified: false,
  },
};

export const DEFAULT_BASELINE_ID = "deepseek-v4-flash";

export class PriceError extends Error {}

export const OPERATOR_ASOF = "operator-configured";
const OPERATOR_PRICE_SOURCE = "operator: llm-gateway.json report.prices";
const OPERATOR_BASELINE_SOURCE = "operator: llm-gateway.json report.baseline";

export interface ResolvedPricing {
  /** the effective table: defaults merged with operator overrides */
  prices: Record<string, ListPrice>;
  /** counterfactual B reference (always verified by construction) */
  baseline: ListPrice & { id: string };
}

function validRates(input: unknown, output: unknown): boolean {
  return (
    typeof input === "number" && Number.isFinite(input) && input >= 0 &&
    typeof output === "number" && Number.isFinite(output) && output >= 0
  );
}

/**
 * Merge the table with operator overrides and resolve the counterfactual
 * baseline. Pure (the module table is cloned, never mutated). Throws
 * PriceError on any semantic violation: unknown/unverified baseline id, bad
 * override rates, all-zero inline baseline. Shape validation (unknown config
 * fields etc.) lives in src/config.ts; this is the semantic pass both the
 * config loader and the report command share.
 */
export function resolveReportPricing(report: ReportConfig | undefined): ResolvedPricing {
  const prices: Record<string, ListPrice> = structuredClone(LIST_PRICES);
  const overrides = report?.prices;
  if (overrides) {
    for (const [id, o] of Object.entries(overrides)) {
      if (!validRates(o.input_per_mtok, o.output_per_mtok)) {
        throw new PriceError(
          `report.prices.${id}: expected finite non-negative input_per_mtok/output_per_mtok numbers`,
        );
      }
      prices[id] = {
        input_per_mtok: o.input_per_mtok,
        output_per_mtok: o.output_per_mtok,
        source: o.source && o.source.length > 0 ? o.source : OPERATOR_PRICE_SOURCE,
        asOf: o.as_of && o.as_of.length > 0 ? o.as_of : OPERATOR_ASOF,
        verified: true, // an operator-supplied price IS the attestation
      };
    }
  }

  const b = report?.baseline;
  if (b === undefined || typeof b === "string") {
    const id = b ?? DEFAULT_BASELINE_ID;
    const entry = prices[id];
    if (!entry) {
      throw new PriceError(
        `report.baseline: "${id}" is not a known price entry (known: ${Object.keys(prices).join(", ")})`,
      );
    }
    if (!entry.verified) {
      throw new PriceError(
        `report.baseline: "${id}" is an UNVERIFIED placeholder (asOf ${entry.asOf}) — ` +
          `verify its list price under report.prices first, or use an inline baseline`,
      );
    }
    return { prices, baseline: { ...entry, id } };
  }

  // inline baseline: { model?, input_per_mtok, output_per_mtok }
  if (!validRates(b.input_per_mtok, b.output_per_mtok)) {
    throw new PriceError(
      "report.baseline: expected finite non-negative input_per_mtok/output_per_mtok numbers",
    );
  }
  if (b.input_per_mtok === 0 && b.output_per_mtok === 0) {
    throw new PriceError(
      "report.baseline: an all-zero baseline makes counterfactual savings meaningless — price it at a real list rate",
    );
  }
  return {
    prices,
    baseline: {
      input_per_mtok: b.input_per_mtok,
      output_per_mtok: b.output_per_mtok,
      source: OPERATOR_BASELINE_SOURCE,
      asOf: OPERATOR_ASOF,
      verified: true,
      id: b.model && b.model.length > 0 ? b.model : "inline baseline",
    },
  };
}
