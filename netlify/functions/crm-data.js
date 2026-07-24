const COQL_URL  = "https://www.zohoapis.in/crm/v7/coql";
const TOKEN_URL = "https://accounts.zoho.in/oauth/v2/token";

// Full Account_Status picklist from Zoho CRM (Target_Accounts module)
const ALL_STATUSES = [
  "-None-", "Active Sales funnel", "Avoid - Bad Fit", "Avoid - Current Client",
  "Avoid - Duplicate Account", "Avoid - Past Client", "Cold", "Dead", "Hot",
  "Lead Generated", "Mild", "Nurture", "Nurture - Active",
  "Nurture - check back quarterly", "Working - Client", "Working - Cold",
  "Working - Engaged"
];

async function getToken() {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     process.env.ZOHO_CLIENT_ID,
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

exports.handler = async () => {
  try {
    const token = await getToken();

    // (a) Pull all nurture-titled notes (paginate), keep only Target_Accounts parents
    const allNotes = await coqlAll(token,
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

    // (b) collect distinct account ids
    const accountIds = Object.keys(notesByAcc);

    // (c) pull those accounts by id (chunk id in (...))
    const accounts = [];
    for (const ids of chunk(accountIds, 100)) {
      const inList = ids.map(id => `'${id}'`).join(",");
      const rows = await coqlAll(token,
        `SELECT id, Name, Owner, Account_Status, Next_Step_Date, Manual_Focus, Business_Case_Score FROM Target_Accounts WHERE id in (${inList})`
      );
      accounts.push(...rows);
    }

    const TODAY = new Date().toISOString().split("T")[0];

    // (d) build per-account objects (notes = nurture notes only, action_count = note_count)
    const usersMap = {};
    const built = accounts.map(a => {
      const notes = (notesByAcc[a.id] || []).sort((x, y) =>
        x.created_at > y.created_at ? -1 : 1
      );
      const last = notes[0];
      const lastDate = last ? last.created_at.split("T")[0] : null;
      const nsd = a.Next_Step_Date || null;
      const isPending = !!nsd && nsd < TODAY &&
        !notes.some(n => n.created_at.split("T")[0] >= nsd);

      if (a.Owner?.id) usersMap[a.Owner.id] = { id: a.Owner.id, full_name: a.Owner.name };

      return {
        id: a.id,
        name: a.Name,
        owner_id: a.Owner?.id || null,
        owner_name: a.Owner?.name || "Unassigned",
        status: normalizeStatus(a.Account_Status),
        raw_status: a.Account_Status,
        manual_focus: a.Manual_Focus || null,
        business_score: (a.Business_Case_Score === undefined ? null : a.Business_Case_Score),
        next_step_date: nsd,
        notes,
        note_count: notes.length,
        action_count: notes.length,
        last_action_date: lastDate,
        latest_action_snippet: last ? (last.content || "").substring(0, 120) : "",
        is_pending: isPending,
      };
    });

    usersMap["__UN__"] = { id: null, full_name: "Unassigned" };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=300, stale-while-revalidate=60",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        generated_at: TODAY,
        all_statuses: [...ALL_STATUSES].sort(),
        users: Object.values(usersMap),
        accounts: built,
      }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
