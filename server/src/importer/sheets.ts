import { auth, sheets } from "@googleapis/sheets";

/** Reads raw cell values from a spreadsheet's first tab. Injected so tests can fake it. */
export interface SheetSource {
  fetchRows(spreadsheetId: string): Promise<string[][]>;
}

/** Accepts a bare spreadsheet ID or a full docs.google.com URL. */
export function parseSheetId(value: string): string {
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : value.trim();
}

/**
 * Service-account credentials from GOOGLE_SERVICE_ACCOUNT_JSON (the key file's JSON contents),
 * or GOOGLE_APPLICATION_CREDENTIALS (a path to the key file). Returns null when neither is set.
 */
export function createGoogleSheetSource(env = process.env): SheetSource | null {
  const json = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json && !env.GOOGLE_APPLICATION_CREDENTIALS) return null;

  const client = new auth.GoogleAuth({
    ...(json ? { credentials: JSON.parse(json) } : {}),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const api = sheets({ version: "v4", auth: client });

  return {
    async fetchRows(spreadsheetId) {
      // A range without a tab name reads the first tab.
      const res = await api.spreadsheets.values.get({ spreadsheetId, range: "A:D" });
      return (res.data.values ?? []) as string[][];
    },
  };
}
