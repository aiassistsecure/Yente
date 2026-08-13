const API_URL = "/api/admin/subscribers";
const EXPORT_URL = "/api/admin/subscribers.csv";
const PAGE_SIZE = 100;
const NUMBER = new Intl.NumberFormat("en-US");

const filters = document.querySelector("[data-filters]");
const body = document.querySelector("[data-records-body]");
const syncState = document.querySelector("[data-sync-state]");
const pageSummary = document.querySelector("[data-page-summary]");
const previousButton = document.querySelector("[data-previous]");
const nextButton = document.querySelector("[data-next]");
let offset = 0;
let total = 0;
let refreshTimer = null;

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function appendCell(row, text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text ?? "—";
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function cohortLabel(value) {
  return value === "founder_developer"
    ? "Founder / developer"
    : value === "investor_employer"
      ? "Investor / employer"
      : value;
}

function renderRecords(records) {
  body.replaceChildren();
  if (!records.length) {
    const row = document.createElement("tr");
    const cell = appendCell(row, "No subscribers match these filters.", "empty");
    cell.colSpan = 6;
    body.append(row);
    return;
  }

  for (const record of records) {
    const row = document.createElement("tr");
    const subscriber = document.createElement("td");
    const name = document.createElement("strong");
    const email = document.createElement("a");
    name.textContent = record.name;
    email.textContent = record.email;
    email.href = `mailto:${record.email}`;
    subscriber.append(name, email);
    row.append(subscriber);
    appendCell(row, cohortLabel(record.cohort));
    const intent = appendCell(row, record.intent || "Not stated", "intent");
    intent.title = record.intent || "Not stated";
    appendCell(row, record.status, `status status-${record.status}`);
    appendCell(
      row,
      record.created_at
        ? new Date(record.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
        : "—",
    );
    appendCell(row, String(record.revision ?? 1));
    body.append(row);
  }
}

function renderCapacity(result) {
  const founders = result.capacity.cohorts.foundersDevelopers;
  const investors = result.capacity.cohorts.investorsEmployers;
  setText("[data-total]", NUMBER.format(result.capacity.total.joined));
  setText("[data-founders]", NUMBER.format(founders.joined));
  setText("[data-founders-left]", `${NUMBER.format(founders.remaining)} seats remaining`);
  setText("[data-investors]", NUMBER.format(investors.joined));
  setText("[data-investors-left]", `${NUMBER.format(investors.remaining)} seats remaining`);
  setText("[data-sequence]", NUMBER.format(Number(result.capacity.sequence || 0)));
  setText(
    "[data-updated]",
    result.capacity.updatedAt
      ? `Last write ${new Date(result.capacity.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "No writes yet",
  );
}

function queryString() {
  const data = new FormData(filters);
  const query = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
  for (const key of ["search", "cohort", "status"]) {
    const value = String(data.get(key) || "").trim();
    if (value) query.set(key, value);
  }
  return query.toString();
}

async function loadRecords({ quiet = false } = {}) {
  window.clearTimeout(refreshTimer);
  if (!quiet) syncState.textContent = "Syncing…";
  try {
    const response = await fetch(`${API_URL}?${queryString()}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Admin API returned ${response.status}`);
    const result = await response.json();
    total = result.total;
    renderRecords(result.records);
    renderCapacity(result);

    const start = total ? offset + 1 : 0;
    const end = Math.min(total, offset + result.records.length);
    pageSummary.textContent = `${NUMBER.format(start)}–${NUMBER.format(end)} of ${NUMBER.format(total)}`;
    previousButton.disabled = offset === 0;
    nextButton.disabled = offset + PAGE_SIZE >= total;
    syncState.textContent = `Live · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    syncState.dataset.state = "live";
  } catch (error) {
    syncState.textContent = "Connection failed";
    syncState.dataset.state = "error";
    if (!quiet) {
      body.replaceChildren();
      const row = document.createElement("tr");
      const cell = appendCell(row, error.message, "empty error");
      cell.colSpan = 6;
      body.append(row);
    }
  } finally {
    refreshTimer = window.setTimeout(() => loadRecords({ quiet: true }), 15_000);
  }
}

filters.addEventListener("submit", (event) => {
  event.preventDefault();
  offset = 0;
  loadRecords();
});

previousButton.addEventListener("click", () => {
  offset = Math.max(0, offset - PAGE_SIZE);
  loadRecords();
});

nextButton.addEventListener("click", () => {
  if (offset + PAGE_SIZE < total) offset += PAGE_SIZE;
  loadRecords();
});

document.querySelector("[data-export]").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Preparing export…";
  try {
    const response = await fetch(EXPORT_URL, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`Export returned ${response.status}`);
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "yente-subscribers.csv";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    syncState.textContent = error.message;
    syncState.dataset.state = "error";
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

loadRecords();
