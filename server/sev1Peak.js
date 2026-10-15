// Builds the data behind the Sev1 Peak Readiness page's "Bug vs non-bug split"
// tab from Salesforce (Sev1 cases) + Jira (bug classification).
import { getSev1PeakCases } from './salesforce.js';
import { fetchIssuesByIds } from './jira.js';
import { SEV1_SITES, ALL_SITES } from './sev1Sites.js';

export const DEFAULT_FROM = '2026-07-01';
export const DEFAULT_TO = '2026-10-01'; // exclusive, i.e. through 30 Sep

const BUG_AREAS = new Set([
  'Software Issue/Bug', 'Navigation Issue', 'Outdated Software Version', 'Product/ Feature Limitation',
]);

// Heatmap column -> owner and the Technical_Impacted_Area__c values merged into it.
const GROUPS = [
  { col: 'GO Infra', owner: 'go', areas: ['GO Network Issue', 'Infrastructure Resource & Capacity issues'] },
  { col: 'Configuration / Productivity', owner: 'go', areas: ['Configuration', 'Configuration Issue', 'UPH', 'Solution Config', 'Product Config'] },
  { col: 'GO SOP / Training + Manual Intervention', owner: 'go', areas: ['GO SOP/Training Issue', 'Manual Intervention'] },
  { col: 'Inconclusive', owner: 'go', areas: ['More Info Required', 'None / Invalid Issue / No Issue Found', 'Additional Information Required', 'No Issue Found'] },
  { col: 'Duplicate', owner: 'go', areas: ['Duplicate'] },
  { col: 'Customer Network Issue', owner: 'cu', areas: ['Customer Network Issue'] },
  { col: 'Customer WMS Issue', owner: 'cu', areas: ['Customer WMS Issue'] },
  { col: 'Customer SOP/Training Issue', owner: 'cu', areas: ['Customer SOP/Training Issue'] },
  { col: 'Customer Vendor Issue', owner: 'cu', areas: ['Customer Vendor Issue'] },
];
const AREA_GROUP = new Map(GROUPS.flatMap((g) => g.areas.map((a) => [a, g])));
const INCONCLUSIVE = GROUPS.find((g) => g.col === 'Inconclusive');
const BUG_COL = 'Software Bug';
// Cases whose Technical Impacted Area isn't set yet (support fills it in after investigating).
const INPROGRESS = { col: 'In progress', owner: 'ip' };
const COLS = [BUG_COL, ...GROUPS.map((g) => g.col), INPROGRESS.col, 'Total'];

// Jira resolution -> "Not a code fix" category.
const NOT_CODE_FIX = {
  'Logs Unavailable': 'Observability gap (RCA inconclusive)',
  'Insufficient Logging/Observability': 'Observability gap (RCA inconclusive)',
  'Require Live Debugging': 'Observability gap (RCA inconclusive)',
  'Wrong Technical Configuration': 'Configuration (technical / infra)',
  'Wrong Feature Configuration': 'Configuration (feature / application)',
  Duplicate: 'Duplicate of another ticket',
  'Incorrect Operating Procedure': 'Process / SOP',
  'Manual Intervention': 'Process / SOP',
  'Upgrade Procedure': 'Process / SOP',
  'New Requirement': 'New requirement / product gap',
  'Invalid Use Case/No issue': 'Invalid / no longer an issue',
  'No longer an issue': 'Invalid / no longer an issue',
};
const TERMINAL_STATUS = new Set(['Done', 'Resolved', 'Unable to Conclude', 'No longer an issue']);
const NO_GM_TEAM = 'Not set (SRE / AE / AES project)';

function classify(jira) {
  const none = { key: '—', gm: NO_GM_TEAM, st: '—', res: '—' };
  if (!jira) return { ...none, cf: 'Pending Jira analysis', bs: '—', cat: 'Pending Jira analysis' };
  const f = jira.fields;
  const st = f.status?.name || '—';
  const res = f.resolution?.name || null;
  const base = {
    key: jira.key, gm: f.customfield_10600?.value || NO_GM_TEAM, st, res: res || '—',
  };
  const codeFix = (bs, cat) => ({ ...base, cf: 'Code fix', bs, cat });

  if (res === 'New Bug') return codeFix('New bug', 'Code fix: New bug');
  if (res === 'Known Bug') return codeFix('Known bug', 'Code fix: Known bug');
  const type = f.issuetype?.name;
  if (type === 'Bug' || type === 'Story') {
    return codeFix('Not tagged new/known (Jira Bug/Story)', 'Code fix: not tagged');
  }
  if (!res || !TERMINAL_STATUS.has(st)) {
    return { ...base, cf: 'Pending Jira analysis', bs: '—', cat: 'Pending Jira analysis' };
  }
  const cat = f.project?.key === 'SRE'
    ? 'Infra / network incident (SRE ticket)'
    : NOT_CODE_FIX[res] || 'Other (unmapped Jira resolution)';
  return { ...base, cf: 'Not a code fix', bs: '—', cat };
}

const r2 = (n) => Math.round(n * 100) / 100;
const ticketNo = (caseNumber) => String(caseNumber).replace(/^0+/, '');

function downtimeStats(name, rows) {
  const withData = rows.filter((r) => r.hrs != null);
  const stat = { name, n: rows.length, withdata: withData.length, sum: 0, avg: 0, min: 0, max: 0 };
  if (!withData.length) return stat;
  const sum = withData.reduce((a, r) => a + r.hrs, 0);
  const lo = withData.reduce((a, r) => (r.hrs < a.hrs ? r : a));
  const hi = withData.reduce((a, r) => (r.hrs > a.hrs ? r : a));
  return {
    ...stat, sum: r2(sum), avg: r2(sum / withData.length), min: r2(lo.hrs), max: r2(hi.hrs),
    mint: lo.t, maxt: hi.t, minsite: lo.site, maxsite: hi.site,
  };
}

async function loadSev1Rows(from, to, sites) {
  const siteOf = new Map(sites.flatMap((s) => s.accounts.map((a) => [a, s.name])));
  const cases = await getSev1PeakCases(from, to, [...siteOf.keys()]);
  const jiraIssues = await fetchIssuesByIds(cases.map((c) => c.Jira_Ticket_Id__c));
  const jiraById = new Map(jiraIssues.map((i) => [i.id, i]));

  const unmapped = new Set();
  const rows = cases.map((c) => {
    const area = c.Technical_Impacted_Area__c || '(blank)';
    const isBug = BUG_AREAS.has(area);
    let group = null;
    if (!isBug) {
      group = area === '(blank)' ? INPROGRESS : AREA_GROUP.get(area);
      if (!group) { unmapped.add(area); group = INCONCLUSIVE; }
    }
    return {
      t: ticketNo(c.CaseNumber), site: siteOf.get(c.Account_Name__c), area, isBug, group,
      hrs: c.Downtime__c == null ? null : c.Downtime__c / 60, // Downtime__c is in minutes
      jira: jiraById.get(String(c.Jira_Ticket_Id__c)),
    };
  });

  return { rows, unmapped };
}

function buildSev1Peak(all, from, to, site, sites) {
  const { unmapped } = all;
  const rows = site ? all.rows.filter((r) => r.site === site) : all.rows;
  const SITES = site ? sites.filter((s) => s.name === site) : sites;

  // Heatmap
  const heatRows = SITES.map((s) => {
    const mine = rows.filter((r) => r.site === s.name);
    const vals = COLS.slice(0, -1).map((col) => mine.filter((r) => (r.isBug ? BUG_COL : r.group.col) === col).length);
    return [...vals, mine.length];
  });
  const totals = COLS.map((_, j) => heatRows.reduce((a, r) => a + r[j], 0));
  const bugs = rows.filter((r) => r.isBug);
  const nonBugs = rows.filter((r) => !r.isBug);

  // Bug list (Jira classification)
  const buglist = bugs.map((r) => ({
    t: r.t, site: r.site, area: r.area, ...classify(r.jira),
  })).sort((a, b) => Number(b.t) - Number(a.t));
  // Non-bug list: category = merged heatmap column, plus Jira dev case fields where one exists.
  const OWNER = { go: 'GO owned', cu: 'Customer owned', ip: 'In progress' };
  const nonbuglist = nonBugs.map((r) => {
    const f = r.jira?.fields;
    return {
      t: r.t, site: r.site, area: r.area, cat: r.group.col, owner: OWNER[r.group.owner],
      gm: r.jira ? f.customfield_10600?.value || NO_GM_TEAM : '—', key: r.jira?.key || '—',
      st: f?.status?.name || '—', res: f?.resolution?.name || '—',
      dt: r.hrs == null ? null : r2(r.hrs),
    };
  }).sort((a, b) => Number(b.t) - Number(a.t));
  const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const cf = count(buglist, (b) => b.cf);
  const bs = count(buglist.filter((b) => b.cf === 'Code fix'), (b) => b.bs);
  const gmCounts = Object.entries(count(buglist, (b) => b.gm)).sort((a, b) => b[1] - a[1]);

  const bugbar = [...BUG_AREAS];
  const ownerbar = (owner) => {
    const gs = GROUPS.filter((g) => g.owner === owner);
    return { labels: gs.map((g) => g.col), counts: gs.map((g) => nonBugs.filter((r) => r.group === g).length) };
  };
  const goN = nonBugs.filter((r) => r.group.owner === 'go').length;
  const cuN = nonBugs.filter((r) => r.group.owner === 'cu').length;
  const ipN = nonBugs.filter((r) => r.group.owner === 'ip').length;

  const withSev1 = SITES.map((s, i) => ({ s, i })).filter(({ i }) => heatRows[i].at(-1) > 0);
  return {
    generatedAt: new Date().toISOString(), from, to, site: site || null, allSites: sites.map((x) => x.name), unmappedAreas: [...unmapped],
    tot: rows.length, bug: bugs.length, nb: nonBugs.length, goN, cuN, ipN,
    dtstats: [
      downtimeStats('Software bug', bugs),
      downtimeStats('GO owned', nonBugs.filter((r) => r.group.owner === 'go')),
      downtimeStats('Customer owned', nonBugs.filter((r) => r.group.owner === 'cu')),
    ],
    ownerbars: { go: ownerbar('go'), cu: ownerbar('cu') },
    sitebar: {
      labels: withSev1.map(({ s }) => s.name),
      bug: withSev1.map(({ i }) => heatRows[i][0]),
      nb: withSev1.map(({ i }) => heatRows[i].at(-1) - heatRows[i][0]),
    },
    cf, bs,
    heat: {
      sites: SITES.map((s) => s.name), cols: COLS, rows: heatRows, totals,
      bands: [['Software bug', 1], ['GO owned', 5], ['Customer owned', 4], ['Pending', 1], ['', 1]],
    },
    bugbar: { labels: bugbar, counts: bugbar.map((a) => bugs.filter((r) => r.area === a).length) },
    gm: { labels: gmCounts.map((g) => g[0]), counts: gmCounts.map((g) => g[1]) },
    buglist,
    nonbuglist,
  };
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map();
export const isSev1Site = (name, all = false) => (all ? ALL_SITES : SEV1_SITES).some((s) => s.name === name);
export async function getSev1Peak(from, to, { refresh = false, site = '', all = false } = {}) {
  const sites = all ? ALL_SITES : SEV1_SITES;
  const f = from || DEFAULT_FROM;
  const t = to || DEFAULT_TO;
  const key = `${f}|${t}|${all ? 'all' : ''}`;
  let hit = cache.get(key);
  if (refresh || !hit || Date.now() - hit.at >= TTL_MS) {
    hit = { at: Date.now(), all: await loadSev1Rows(f, t, sites) };
    cache.set(key, hit);
  }
  return buildSev1Peak(hit.all, f, t, site, sites);
}
