// Shared "Export CSV" helper. Pages call CsvExport.record(name, apiResponse)
// whenever they load data; clicking the button flattens everything recorded
// into one CSV (a section per table) reflecting the current filters.
(function () {
  const store = {};

  function esc(v) {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const line = (cells) => cells.map(esc).join(',');
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const isTable = (v) => Array.isArray(v) && v.length > 0 && v.every(isObj);

  // Splits an object into scalar key/value rows and nested tables.
  function collect(prefix, value, scalars, tables) {
    if (isTable(value)) {
      tables.push([prefix, value]);
    } else if (Array.isArray(value)) {
      if (value.length) scalars.push([prefix, value.join('; ')]);
    } else if (isObj(value)) {
      Object.keys(value).forEach((k) => collect(prefix ? `${prefix}.${k}` : k, value[k], scalars, tables));
    } else {
      scalars.push([prefix, value]);
    }
  }

  function tableLines(rows) {
    const cols = [];
    rows.forEach((r) => Object.keys(r).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
    return [line(cols), ...rows.map((r) => line(cols.map((c) => r[c])))];
  }

  function build() {
    const out = [];
    Object.keys(store).forEach((name) => {
      const scalars = [];
      const tables = [];
      collect('', store[name], scalars, tables);
      if (scalars.length) {
        out.push(line([`# ${name}`]), line(['Field', 'Value']));
        scalars.forEach(([k, v]) => out.push(line([k, v])));
        out.push('');
      }
      tables.forEach(([path, rows]) => {
        out.push(line([`# ${name}${path ? ' / ' + path : ''}`]), ...tableLines(rows), '');
      });
    });
    return out.join('\r\n');
  }

  function download(filename, csv) {
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.CsvExport = {
    record(name, data) { store[name] = data; },
    // Exports recorded data, or `csv` directly if provided.
    run(baseName, csv) {
      const body = csv !== undefined ? csv : build();
      if (!body) { alert('Nothing to export yet — wait for the data to load.'); return; }
      download(`${baseName}-${new Date().toISOString().slice(0, 10)}.csv`, body);
    },
    toCsvLine: line,
  };
})();
