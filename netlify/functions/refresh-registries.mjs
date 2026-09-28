/**
 * ComplyFactor Registry Scheduled Refresh
 *
 * Runs daily and refreshes both regulator datasets.
 */

import { getStore } from "@netlify/blobs";

const SRC = {
  boc: "https://www.bankofcanada.ca/rps-api/cif2/accounts/list",
  fintracJson: "https://fintrac-canafe.canada.ca/msb-esm/list.json",
  fintracCsv: "https://fintrac-canafe.canada.ca/msb-esm/reg-eng.csv"
};

const UA =
  "ComplyFactor-RegistryMirror/1.0 (+https://complyfactor.com/registry-search; compliance@complyfactor.com)";

const STORE_NAME = "complyfactor-registries";

export default async function handler() {
  const store = getStore(STORE_NAME);

  const [boc, fintrac] = await Promise.all([
    fetchBoc(),
    fetchFintrac()
  ]);

  await store.setJSON("cache:boc", {
    cachedAt: new Date().toISOString(),
    data: boc
  });

  await store.setJSON("cache:fintrac", {
    cachedAt: new Date().toISOString(),
    data: fintrac
  });

  await store.setJSON("lastgood:boc", boc);
  await store.setJSON("lastgood:fintrac", fintrac);

  console.log("ComplyFactor registries refreshed successfully.");

  return new Response("Registry refresh completed.", {
    status: 200
  });
}

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

  const response = await fetch(SRC.fintracCsv, {
    headers: {
      "User-Agent": UA
    }
  });

  if (!response.ok) {
    throw new Error(`FINTRAC ${response.status}`);
  }

  return {
    rows: parseCsv(await response.text())
  };
}

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