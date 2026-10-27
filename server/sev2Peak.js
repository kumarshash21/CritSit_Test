// Builds the data behind the Sev2 Peak Readiness page (everything except the
// hand-written Prevention plan) from Salesforce Sev2 cases + Jira dev cases.
import { getSev2PeakCases, getNonCritSev2Cases, getNonCritSev3Cases } from './salesforce.js';
import { fetchIssuesByIds } from './jira.js';
import { SEV2_SITES, ALL_SITES } from './sev1Sites.js';

export const DEFAULT_FROM = '2026-07-01';

const BUG_AREAS = new Set([
  'Software Issue/Bug', 'Navigation Issue', 'Outdated Software Version',
  'Product/ Feature Limitation', 'Product/ Feature Limitation - Capability',
]);
const grp = (col, owner, areas) => ({ col, owner, areas: areas || [col] });
const GROUPS = [
  grp('PPS Strategy', 'go'), grp('Congestion', 'go'), grp('PPF', 'go'), grp('Order Pool', 'go'), grp('OWT', 'go'),
  grp('Configuration / Productivity', 'go', ['Configuration', 'Configuration Issue', 'UPH', 'Solution Config', 'Product Config']),
  grp('GO Infra', 'go', ['Infrastructure Resource & Capacity issues', 'GO Network Issue']),
  grp('Inconclusive', 'go', ['More Info Required', 'None / Invalid Issue / No Issue Found', 'Additional Information Required', 'No Issue Found']),
  grp('GO SOP / Training', 'go', ['GO SOP/Training Issue', 'Manual Intervention']),
  grp('Duplicate', 'go'),
  grp('Customer Network Issue', 'cu'), grp('Customer SOP/Training Issue', 'cu'), grp('Customer WMS Issue', 'cu'),
];
const AREA_GROUP = new Map(GROUPS.flatMap((g) => g.areas.map((a) => [a, g])));
const INCONCLUSIVE = GROUPS.find((g) => g.col === 'Inconclusive');
const BUG_COL = 'Software bug';
// Cases whose Technical Impacted Area isn't set yet (support fills it in after investigating).
const INPROGRESS = { col: 'In progress', owner: 'ip' };
// Heat-map header labels only; the column names above stay the matching keys.
const HEAT_LABEL = Object.fromEntries(['PPS Strategy', 'Congestion', 'PPF', 'Order Pool', 'OWT'].map((c) => [c, `R2R - ${c}`]));
const COLS = [BUG_COL, ...GROUPS.map((g) => g.col), INPROGRESS.col, 'Total'];

const OUT_CLOSED = 'Dev case closed (Done / Resolved)';
const OUT_NOFIX = 'Closed without a fix';
const OUT_OPEN = 'Still open';
const OUT_NODEV = 'No dev case';
const outcome = (status) => (['Done', 'Resolved'].includes(status) ? OUT_CLOSED
  : ['Rejected', 'No longer an issue', 'Unable to Conclude'].includes(status) ? OUT_NOFIX : OUT_OPEN);

const R2R = /r2r|rack[\s-]*(to|2)[\s-]*rack|t2t|tote[\s-]*to[\s-]*tote/i;
const IST_MS = 5.5 * 3600000;
const r2 = (n) => Math.round(n * 100) / 100;
const ticketNo = (n) => String(n).replace(/^0+/, '');
const istDate = (iso) => new Date(new Date(iso).getTime() + IST_MS);
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const sortedPairs = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function dtStat(name, rows) {
  const v = rows.filter((r) => r.hrs != null);
  const out = { name, n: rows.length, withdata: v.length, sum: 0, avg: 0, med: 0, max: 0 };
  if (!v.length) return out;
  const sum = v.reduce((a, r) => a + r.hrs, 0);
  const hi = v.reduce((a, r) => (r.hrs > a.hrs ? r : a));
  return { ...out, sum: r2(sum), avg: r2(sum / v.length), med: r2(median(v.map((r) => r.hrs))), max: r2(hi.hrs), maxt: hi.t, maxsite: hi.site };
}

// Monday (IST) of the week containing the case's IST creation date.
function weekStart(iso) {
  const d = istDate(iso);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekLabel = (ymd) => `${Number(ymd.slice(8))} ${MON[Number(ymd.slice(5, 7)) - 1]}`;

// Downtime__c is minutes scaled by the impact share; the page reports it as
// full-site hours (Downtime__c / 60 / impact fraction).
const downtimeHrs = (c) => (c.Downtime__c == null || !c.Impact_Percentage__c
  ? null : c.Downtime__c / 60 / (c.Impact_Percentage__c / 100));

async function loadSev2Rows(from, to, sites, fetchCases = getSev2PeakCases) {
  const siteOf = new Map(sites.flatMap((s) => s.accounts.map((a) => [a, s.name])));
  const cases = await fetchCases(from, to, [...siteOf.keys()]);
  const jira = new Map((await fetchIssuesByIds(cases.map((c) => c.Jira_Ticket_Id__c))).map((i) => [i.id, i]));

  const unmapped = new Set();
  const rows = cases.map((c) => {
    const area = c.Technical_Impacted_Area__c || '(blank)';
    const dev = jira.get(String(c.Jira_Ticket_Id__c));
    const isBug = Boolean(dev) || BUG_AREAS.has(area);
    let group = area === '(blank)' ? INPROGRESS : AREA_GROUP.get(area) || null;
    if (!group && !BUG_AREAS.has(area)) { unmapped.add(area); group = INCONCLUSIVE; }
    return {
      t: ticketNo(c.CaseNumber), url: c.__caseUrl, site: siteOf.get(c.Account_Name__c), area, dev, isBug, group,
      subj: c.Subject || '', created: c.CreatedDate, solved: c.Status === 'Solved' || c.Status === 'Closed',
      opa: c.Operational_Impacted_Area__c || 'Not set', hrs: downtimeHrs(c),
      ou: c.OneUptime_Incident_Number__c || '—', ouUrl: c.OneUptime_Case_Url__c || '', ouSt: c.OneUptime_Status__c || '—',
    };
  });
  return { rows, unmapped };
}

function buildSev2Peak(all, from, to, site, sites, label = 'Sev2') {
  const { unmapped } = all;
  const pick = new Set([].concat(site || []));
  const rows = pick.size ? all.rows.filter((r) => pick.has(r.site)) : all.rows;
  const SITES = pick.size ? sites.filter((s) => pick.has(s.name)) : sites;
  const bugs = rows.filter((r) => r.isBug);
  const nonBugs = rows.filter((r) => !r.isBug);
  const colOf = (r) => (r.isBug ? BUG_COL : r.group.col);

  // Heatmap, sites sorted by total
  const order = SITES.map((s) => {
    const mine = rows.filter((r) => r.site === s.name);
    return { name: s.name, vals: [...COLS.slice(0, -1).map((c) => mine.filter((r) => colOf(r) === c).length), mine.length] };
  }).sort((a, b) => b.vals.at(-1) - a.vals.at(-1));
  const totals = COLS.map((_, j) => order.reduce((a, o) => a + o.vals[j], 0));
  const zero = order.filter((o) => !o.vals.at(-1)).map((o) => o.name);

  // Bug list
  const buglist = bugs.map((r) => {
    const f = r.dev?.fields;
    const st = f?.status?.name || '—';
    const inArea = BUG_AREAS.has(r.area);
    return {
      t: r.t, url: r.url, site: r.site, area: r.area, ou: r.ou, ouUrl: r.ouUrl, ouSt: r.ouSt, subj: r.subj, proj: f?.project?.key || '—',
      key: r.dev?.key || '—', st, out: r.dev ? outcome(st) : OUT_NODEV, dt: r2(r.hrs ?? 0),
      impg: inArea ? 'Software bug' : r.group.owner === 'go' ? 'GO owned' : r.group.owner === 'cu' ? 'Customer owned' : 'Not set',
      imp: inArea ? 'Software bug area' : r.group.col,
    };
  }).sort((a, b) => Number(a.t) - Number(b.t));
  const OWNER = { go: 'GO owned', cu: 'Customer owned', ip: 'In progress' };
  const nonbuglist = nonBugs.map((r) => ({
    t: r.t, url: r.url, site: r.site, area: r.area, cat: r.group.col, owner: OWNER[r.group.owner], subj: r.subj,
    st: r.solved ? 'Solved / Closed' : 'Open', dt: r.hrs == null ? null : r2(r.hrs),
  })).sort((a, b) => Number(a.t) - Number(b.t));
  const oc = count(buglist, (b) => b.out);
  const bugAreaCounts = sortedPairs(count(bugs, (r) => r.area));
  const ownerbar = (owner) => {
    const gs = GROUPS.filter((g) => g.owner === owner);
    return { labels: gs.map((g) => g.col), counts: gs.map((g) => nonBugs.filter((r) => r.group === g).length) };
  };
  const goN = nonBugs.filter((r) => r.group.owner === 'go').length;

  // Weekly trend (IST weeks, Monday start)
  const weeks = [...new Set(rows.map((r) => weekStart(r.created)))].sort();
  const typeOf = (r) => (r.isBug ? 'Software bug' : r.group.owner === 'go' ? 'GO owned' : r.group.owner === 'cu' ? 'Customer owned' : 'In progress');
  const trend = { labels: weeks.map(weekLabel) };
  for (const k of ['Software bug', 'GO owned', 'Customer owned', 'In progress']) {
    trend[k] = weeks.map((w) => rows.filter((r) => weekStart(r.created) === w && typeOf(r) === k).length);
  }
  const r2rRows = rows.filter((r) => R2R.test(r.subj));
  const opa = sortedPairs(count(rows, (r) => r.opa));
  const lastCreated = rows.map((r) => r.created).sort().at(-1);

  return {
    generatedAt: new Date().toISOString(), from, to, site: pick.size ? [...pick] : null, allSites: sites.map((x) => x.name), unmappedAreas: [...unmapped],
    lastDate: lastCreated ? istDate(lastCreated).toISOString().slice(0, 10) : null,
    tot: rows.length, bug: bugs.length, nb: nonBugs.length, goN, cuN: nonBugs.filter((r) => r.group.owner === 'cu').length,
    ipN: nonBugs.filter((r) => r.group.owner === 'ip').length,
    bsplit: {
      dev: bugs.filter((r) => r.dev).length, nodev: bugs.filter((r) => !r.dev).length,
      area_bug: buglist.filter((b) => b.impg === 'Software bug').length,
      area_go: buglist.filter((b) => b.impg === 'GO owned').length,
      area_cu: buglist.filter((b) => b.impg === 'Customer owned').length,
      area_ip: buglist.filter((b) => b.impg === 'Not set').length,
    },
    r2r: r2rRows.length, r2rpct: r2(r2rRows.length / (rows.length || 1) * 100),
    r2rTopSites: sortedPairs(count(r2rRows, (r) => r.site)).slice(0, 3),
    r2rTopCols: sortedPairs(count(r2rRows, colOf)).slice(0, 3),
    nlist: SITES.length, nzero: zero.length, zero,
    notsolved: rows.filter((r) => !r.solved).length,
    oc,
    dtstats: [
      dtStat('Software bug', bugs),
      dtStat('GO owned', nonBugs.filter((r) => r.group.owner === 'go')),
      dtStat('Customer owned', nonBugs.filter((r) => r.group.owner === 'cu')),
    ],
    dtall: dtStat(`All ${label}`, rows),
    ownerbars: { go: ownerbar('go'), cu: ownerbar('cu') },
    heat: {
      sites: order.map((o) => o.name), cols: COLS.map((c) => HEAT_LABEL[c] || c), rows: order.map((o) => o.vals), totals,
      bands: [[BUG_COL, 1], ['GO owned', GROUPS.filter((g) => g.owner === 'go').length],
        ['Customer owned', GROUPS.filter((g) => g.owner === 'cu').length], ['Pending', 1], ['', 1]],
    },
    bugbar: { labels: bugAreaCounts.map((p) => p[0]), counts: bugAreaCounts.map((p) => p[1]) },
    proj: count(bugs.filter((r) => r.dev), (r) => r.dev.fields.project.key),
    trend, opa: { labels: opa.map((p) => p[0]), counts: opa.map((p) => p[1]) },
    buglist,
    nonbuglist,
  };
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map();
export const isSev2Site = (name, all = false) => (all ? ALL_SITES : SEV2_SITES).some((s) => s.name === name);

// kind: 'sev2' (CritSit Sev2, impact >= 50), 'nc-sev2' (Sev2 below 50% impact) or 'nc-sev3' (Sev3).
const KINDS = {
  sev2: { fetchCases: getSev2PeakCases, label: 'Sev2' },
  'nc-sev2': { fetchCases: getNonCritSev2Cases, label: 'Sev2' },
  'nc-sev3': { fetchCases: getNonCritSev3Cases, label: 'Sev3' },
};
export async function getPeak(kind, from, to, { refresh = false, site = [], all = false } = {}) {
  const { fetchCases, label } = KINDS[kind];
  const sites = all ? ALL_SITES : SEV2_SITES;
  const f = from || DEFAULT_FROM;
  const t = to || new Date(Date.now() + IST_MS + 86400000).toISOString().slice(0, 10);
  const key = `${kind}|${f}|${t}|${all ? 'all' : ''}`;
  let hit = cache.get(key);
  if (refresh || !hit || Date.now() - hit.at >= TTL_MS) {
    hit = { at: Date.now(), all: await loadSev2Rows(f, t, sites, fetchCases) };
    cache.set(key, hit);
  }
  return buildSev2Peak(hit.all, f, t, site, sites, label);
}
export const getSev2Peak = (from, to, opts) => getPeak('sev2', from, to, opts);
