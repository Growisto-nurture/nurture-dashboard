// Daily Zoho CRM -> Nurture Dashboard refresh script.
// Pulls fresh Target_Accounts + nurture Notes, rebuilds dashboard_data.json,
// and re-embeds it into index.html as STATIC_DATA. Runs headless (GitHub Actions).

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const COQL_URL = "https://www.zohoapis.in/crm/v7/coql";
const TOKEN_URL = "https://accounts.zoho.in/oauth/v2/token";

const ALL_STATUSES = [
  "-None-", "Active Sales funnel", "Avoid - Bad Fit", "Avoid - Current Client",
  "Avoid - Duplicate Account", "Avoid - Past Client", "Cold", "Dead", "Hot",
  "Lead Generated", "Mild", "Nurture", "Nurture - Active",
  "Nurture - check back quarterly", "Working - Client", "Working - Cold",
  "Working - Engaged",
].sort();

async function getToken() {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Token error: " + JSON.stringify(d));
  return d.access_token;
}

async function coqlAll(token, baseQuery) {
  const rows = [];
  let offset = 0;
  while (true) {
    const q = baseQuery + ` LIMIT ${offset}, 200`;
    const r = await fetch(COQL_URL, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ select_query: q }),
    });
    const d = await r.json();
    // Zoho returns 204/empty on no rows, but an error object on scope/auth problems — fail loudly on those.
    if (d && (d.code || d.error)) {
      throw new Error(`COQL error for [${baseQuery.slice(0, 60)}...]: ${JSON.stringify(d)}`);
    }
    if (!d.data || d.data.length === 0) break;
    rows.push(...d.data);
    if (d.data.length < 200) break;
    offset += 200;
  }
  return rows;
}

function normalizeStatus(s) {
  if (!s) return s;
  if (s === "Nurture- Active" || s === "Nurture - active") return "Nurture - Active";
  return s;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// India has no DST, so this is a reliable IST calendar-day stamp.
function todayIST() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function main() {
  const token = await getToken();
  const TODAY = todayIST();

  // 1. Pull all nurture-titled notes, keep only Target_Accounts parents
  const allNotes = await coqlAll(
    token,
    `SELECT id, Note_Title, Note_Content, Created_Time, Parent_Id FROM Notes WHERE Note_Title like '%urture%' ORDER BY id`
  );

  const notesByAcc = {};
  for (const n of allNotes) {
    const mod = n.Parent_Id?.module?.api_name;
    const pid = n.Parent_Id?.id;
    if (mod !== "Target_Accounts" || !pid) continue;
    if (!notesByAcc[pid]) notesByAcc[pid] = [];
    notesByAcc[pid].push({
      id: n.id,
      title: n.Note_Title || "",
      content: n.Note_Content || "",
      created_at: n.Created_Time,
    });
  }

  // 2. Pull accounts that have nurture notes, in chunks of 100
  const noteAccountIds = Object.keys(notesByAcc);
  const accountsById = {};
  for (const ids of chunk(noteAccountIds, 100)) {
    const inList = ids.map((id) => `'${id}'`).join(",");
    const rows = await coqlAll(
      token,
      `SELECT id, Name, Owner, Account_Status, Next_Step_Date, Manual_Focus, Business_Case_Score FROM Target_Accounts WHERE id in (${inList})`
    );
    for (const a of rows) accountsById[a.id] = a;
  }

  // 3. ALSO pull every Active Sales funnel account, even with zero nurture notes
  const activeFunnelRows = await coqlAll(
    token,
    `SELECT id, Name, Owner, Account_Status, Next_Step_Date, Manual_Focus, Business_Case_Score FROM Target_Accounts WHERE Account_Status = 'Active Sales funnel'`
  );
  for (const a of activeFunnelRows) accountsById[a.id] = a;

  const accounts = Object.values(accountsById);

  // 4. Resolve owner FULL names (COQL Owner.name is last-name-only — must query Users separately)
  const ownerIds = [...new Set(accounts.map((a) => a.Owner?.id).filter(Boolean))];
  const fullNameById = {};
  for (const ids of chunk(ownerIds, 100)) {
    const inList = ids.map((id) => `'${id}'`).join(",");
    const rows = await coqlAll(token, `SELECT id, first_name, last_name FROM users WHERE id in (${inList})`);
    for (const u of rows) {
      fullNameById[u.id] = `${u.first_name || ""} ${u.last_name || ""}`.trim();
    }
  }

  // 5. Build final per-account records
  const usersMap = {};
  const built = accounts.map((a) => {
    const notes = (notesByAcc[a.id] || []).sort((x, y) => (x.created_at > y.created_at ? -1 : 1));
    const nonEmpty = notes.find((n) => (n.content || "").trim().length > 0);
    const newest = notes[0];
    const snippetSource = nonEmpty || newest;
    const latestSnippet = snippetSource
      ? (snippetSource.content && snippetSource.content.trim().length > 0
          ? snippetSource.content
          : snippetSource.title
        ).substring(0, 120)
      : "";

    const nsd = a.Next_Step_Date || null;
    const isPending = !!nsd && nsd < TODAY && !notes.some((n) => n.created_at.split("T")[0] >= nsd);

    const ownerId = a.Owner?.id || null;
    const ownerName = ownerId ? fullNameById[ownerId] || a.Owner?.name || "Unassigned" : "Unassigned";
    if (ownerId) usersMap[ownerId] = { id: ownerId, full_name: ownerName };

    return {
      id: a.id,
      name: a.Name,
      owner_id: ownerId,
      owner_name: ownerName,
      status: normalizeStatus(a.Account_Status),
      raw_status: a.Account_Status,
      manual_focus: a.Manual_Focus || null,
      business_score: (a.Business_Case_Score === undefined ? null : a.Business_Case_Score),
      next_step_date: nsd,
      notes,
      note_count: notes.length,
      action_count: notes.length,
      last_action_date: newest ? newest.created_at.split("T")[0] : null,
      latest_action_snippet: latestSnippet,
      is_pending: isPending,
    };
  });

  // Never deploy an empty dashboard — better to fail the workflow and keep yesterday's data live.
  if (built.length === 0) {
    throw new Error("Refusing to deploy: zero accounts returned from Zoho CRM. Check scopes/token.");
  }

  usersMap["__UN__"] = { id: null, full_name: "Unassigned" };

  const dashboardData = {
    generated_at: TODAY,
    all_statuses: ALL_STATUSES,
    users: Object.values(usersMap),
    accounts: built,
  };

  // 6. Write dashboard_data.json
  writeFileSync(join(ROOT, "dashboard_data.json"), JSON.stringify(dashboardData));

  // 7. Re-embed into index.html (find the STATIC_DATA line by pattern, never assume a line number)
  const htmlPath = join(ROOT, "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const lines = html.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("const STATIC_DATA = "));
  if (idx < 0) throw new Error("STATIC_DATA line not found in index.html");
  lines[idx] = "const STATIC_DATA = " + JSON.stringify(dashboardData) + ";";
  writeFileSync(htmlPath, lines.join("\n"));

  console.log(`Refreshed: ${built.length} accounts, ${allNotes.length} nurture notes, generated_at=${TODAY}`);
  console.log(`Pending: ${built.filter((a) => a.is_pending).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
