const FORMULA_PREFIX = /^[=+\-@]/;

function safeCell(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function quote(value) {
  const text = safeCell(value).replaceAll('"', '""');
  return `"${text}"`;
}

export function subscribersToCsv(records) {
  const columns = [
    ["subscriber_id", "_id"],
    ["name", "name"],
    ["email", "email"],
    ["cohort", "cohort"],
    ["intent", "intent"],
    ["status", "status"],
    ["created_at", "created_at"],
    ["updated_at", "updated_at"],
    ["revision", "revision"],
    ["source", "source"],
    ["record_hash", "_hash"],
    ["caused_by_event_id", "caused_by_event_id"],
    ["caused_by_event_hash", "caused_by_event_hash"],
  ];

  const rows = [columns.map(([header]) => quote(header)).join(",")];
  for (const record of records) {
    rows.push(columns.map(([, key]) => quote(record[key])).join(","));
  }
  return `${rows.join("\r\n")}\r\n`;
}
