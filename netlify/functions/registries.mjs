/**
 * ComplyFactor Registries API — Netlify Function
 *
 * Endpoint:
 * GET /.netlify/functions/registries
 *
 * Custom route:
 * GET /registries
 *
 * Pulls:
 * - Bank of Canada PSP registry
 * - FINTRAC MSB registry
 *
 * Caching:
 * - BoC: 24 hours
 * - FINTRAC: 7 days
 *
 * Persistent fallback:
 * - Netlify Blobs
 */

import { getStore } from "@netlify/blobs";

const SRC = {
  boc: "https://www.bankofcanada.ca/rps-api/cif2/accounts/list",
  fintracJson: "https://fintrac-canafe.canada.ca/msb-esm/list.json",
  fintracCsv: "https://fintrac-canafe.canada.ca/msb-esm/reg-eng.csv"
};

const TTL = {
  boc: 24 * 60 * 60,
  fintrac: 7 * 24 * 60 * 60
};

const ALLOW = [
  "https://complyfactor.com",
  "https://www.complyfactor.com",
  "https://complyfactor.webflow.io"
];

const UA =
  "ComplyFactor-RegistryMirror/1.0 (+https://complyfactor.com/registry-search; compliance@complyfactor.com)";

const STORE_NAME = "complyfactor-registries";

/**
 * Main Netlify Function
 */
export default async function handler(req) {
  const origin = req.headers.get("Origin") || "";

  const cors = {
    "Access-Control-Allow-Origin": ALLOW.includes(origin)
      ? origin
      : ALLOW[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: cors
    });
  }

  // Only GET is allowed
  if (req.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: cors
    });
  }

  try {
    const [boc, fintrac] = await Promise.all([
      cached("boc", TTL.boc, fetchBoc),
      cached("fintrac", TTL.fintrac, fetchFintrac)
    ]);

    const body = JSON.stringify({
      synced: new Date().toISOString(),
      boc,
      fintrac
    });

    return new Response(body, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",

        // Browser/CDN cache for 1 hour.
        "Cache-Control": "public, max-age=3600"
      }
    });
  } catch (error) {
    console.error("Registry API error:", error);

    return new Response(
      JSON.stringify({
        error: "Unable to load registry data",
        synced: null
      }),
      {
        status: 500,
        headers: {
          ...cors,
          "Content-Type": "application/json; charset=utf-8"
        }
      }
    );
  }
}

/**
 * Persistent cache + last-good fallback
 */
async function cached(key, ttl, fetcher) {
  const store = getStore(STORE_NAME);

  const cacheKey = `cache:${key}`;
  const lastGoodKey = `lastgood:${key}`;

  // Try cached data first
  try {
    const cached = await store.get(cacheKey, {
      type: "json"
    });

    if (cached?.data && cached?.cachedAt) {
      const age = Math.floor(
        (Date.now() - new Date(cached.cachedAt).getTime()) / 1000
      );

      if (age < ttl) {
        return cached.data;
      }
    }
  } catch (error) {
    console.warn(`Cache read failed for ${key}:`, error);
  }

  // Cache expired or missing — fetch fresh data
  try {
    const data = await fetcher();

    data.synced = new Date().toISOString();

    // Save fresh cache
    await store.setJSON(cacheKey, {
      cachedAt: new Date().toISOString(),
      data
    });

    // Save last known good copy
    await store.setJSON(lastGoodKey, data);

    return data;
  } catch (error) {
    console.error(`Fresh fetch failed for ${key}:`, error);

    // Last-good fallback
    try {
      const lastGood = await store.get(lastGoodKey, {
        type: "json"
      });

      if (lastGood) {
        return {
          ...lastGood,
          stale: true
        };
      }
    } catch (fallbackError) {
      console.error(
        `Last-good fallback failed for ${key}:`,
        fallbackError
      );
    }

    // Nothing available
    return {
      error: String(error),
      synced: null
    };
  }
}

/**
 * Bank of Canada
 *
 * One request returns:
 * - registered
 * - in_review
 */
async function fetchBoc() {
  const response = await fetch(SRC.boc, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`BoC ${response.status}`);
  }

  const json = await response.json();

  const pick = (accounts) =>
    (accounts || []).map((entry) => ({
      id: entry.id,
      en_legal_name: entry.en_legal_name,
      fr_legal_name: entry.fr_legal_name,
      main_trade_name: entry.main_trade_name,
      head_office_country: entry.head_office_country,
      has_violations: entry.has_violations,
      status: entry.status,
      created_on: entry.created_on
    }));

  return {
    data: {
      accounts: {
        registered: pick(json?.accounts?.registered),
        in_review: pick(json?.accounts?.in_review)
      }
    }
  };
}

/**
 * FINTRAC
 *
 * Prefer JSON.
 * If JSON fails or is empty,
 * fall back to CSV.
 */
async function fetchFintrac() {
  try {
    const response = await fetch(SRC.fintracJson, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json"
      }
    });

    if (response.ok) {
      const json = await response.json();

      const rows = Array.isArray(json)
        ? json
        : json.data || json.aaData;

      if (rows?.length) {
        return {
          rows
        };
      }
    }
  } catch (error) {
    console.warn("FINTRAC JSON failed, using CSV:", error);
  }

  // CSV fallback
  const response = await fetch(SRC.fintracCsv, {
    headers: {
      "User-Agent": UA
    }
  });

  if (!response.ok) {
    throw new Error(`FINTRAC ${response.status}`);
  }

  const csvText = await response.text();

  return {
    rows: parseCsv(csvText)
  };
}

/**
 * CSV parser
 *
 * Handles:
 * - quoted fields
 * - commas inside quotes
 * - escaped quotes
 * - Windows CRLF
 * - UTF-8 BOM
 */
function parseCsv(text) {
  const rows = [];

  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") {
        i++;
      }

      row.push(cell);
      rows.push(row);

      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  if (!rows.length) {
    return [];
  }

  const head = rows
    .shift()
    .map((header) =>
      header.replace(/^\uFEFF/, "").trim()
    );

  return rows
    .filter(
      (r) =>
        r.length === head.length &&
        r.some(Boolean)
    )
    .map((r) =>
      Object.fromEntries(
        head.map((header, index) => [
          header,
          r[index]
        ])
      )
    );
}