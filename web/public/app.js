const CAPACITY_URL = "/api/founding-network/capacity";
const SUBSCRIBE_URL = "/api/founding-network/subscribers";
const POLL_BASE_MS = 10_000;
const POLL_MAX_MS = 120_000;
const NUMBER = new Intl.NumberFormat("en-US");

const cohortKeys = {
  founder_developer: "foundersDevelopers",
  investor_employer: "investorsEmployers",
};

const form = document.querySelector("[data-waitlist-form]");
const submitButton = document.querySelector("[data-submit-button]");
const formMessage = document.querySelector("[data-form-message]");
const capacityStatus = document.querySelector("[data-capacity-status]");
let capacity = null;
let pollDelay = POLL_BASE_MS;
let pollTimer = null;

function cohortSnapshot(cohort) {
  const key = cohortKeys[cohort];
  return key && capacity?.cohorts?.[key];
}

function updateSelectedCohort() {
  const selected = form?.elements.cohort.value;
  document.querySelectorAll("[data-cohort-option]").forEach((option) => {
    option.classList.toggle("selected", option.dataset.cohortOption === selected);
  });

  const snapshot = cohortSnapshot(selected);
  const label = submitButton?.querySelector("span");
  if (submitButton && label) {
    submitButton.disabled = Boolean(snapshot?.full);
    label.textContent = snapshot?.full
      ? "This founding cohort is full"
      : "Claim my free founding spot";
  }
}

function applyCapacity(nextCapacity) {
  capacity = nextCapacity;
  for (const cohort of Object.keys(cohortKeys)) {
    const snapshot = cohortSnapshot(cohort);
    if (!snapshot) continue;

    const remaining = document.querySelector(`[data-capacity-remaining="${cohort}"]`);
    const joined = document.querySelector(`[data-capacity-joined="${cohort}"]`);
    const bar = document.querySelector(`[data-capacity-bar="${cohort}"]`);
    const track = bar?.parentElement;
    const option = document.querySelector(`[data-cohort-option="${cohort}"] input`);
    const percentage = Math.min(100, (snapshot.joined / snapshot.limit) * 100);

    if (remaining) remaining.textContent = NUMBER.format(snapshot.remaining);
    if (joined) joined.textContent = `${NUMBER.format(snapshot.joined)} claimed · updated live`;
    if (bar) bar.style.width = `${percentage}%`;
    if (track) track.setAttribute("aria-valuenow", String(snapshot.joined));
    if (option) option.disabled = snapshot.full;
    document
      .querySelector(`[data-cohort-card="${cohort}"]`)
      ?.classList.toggle("cohort-full", snapshot.full);
  }

  if (capacityStatus) {
    const updated = nextCapacity.updatedAt
      ? new Date(nextCapacity.updatedAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : "now";
    capacityStatus.textContent = `Live · ${updated}`;
    capacityStatus.classList.remove("offline");
  }
  updateSelectedCohort();
}

function schedulePoll(delay) {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(pollCapacity, delay);
}

async function pollCapacity() {
  if (document.hidden) return schedulePoll(POLL_BASE_MS);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(CAPACITY_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`capacity request returned ${response.status}`);
    applyCapacity(await response.json());
    pollDelay = POLL_BASE_MS;
  } catch {
    pollDelay = Math.min(POLL_MAX_MS, pollDelay * 2);
    if (capacityStatus) {
      capacityStatus.textContent = "Live count reconnecting…";
      capacityStatus.classList.add("offline");
    }
  } finally {
    window.clearTimeout(timeout);
    schedulePoll(pollDelay);
  }
}

function showMessage(message, state) {
  formMessage.textContent = message;
  formMessage.dataset.state = state;
}

form?.addEventListener("change", (event) => {
  if (event.target.name === "cohort") updateSelectedCohort();
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const data = new FormData(form);
  const payload = {
    name: data.get("name"),
    email: data.get("email"),
    cohort: data.get("cohort"),
    intent: data.get("intent"),
    companyWebsite: data.get("companyWebsite"),
    consent: data.get("consent") === "on",
  };

  submitButton.disabled = true;
  submitButton.setAttribute("aria-busy", "true");
  submitButton.querySelector("span").textContent = "Claiming your spot…";
  showMessage("", "idle");

  try {
    const response = await fetch(SUBSCRIBE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Yente could not save your spot.");

    if (result.capacity) applyCapacity(result.capacity);
    showMessage(
      `${result.message} Watch ${payload.email} for Yente’s intake.`,
      "success",
    );
    form.elements.name.value = "";
    form.elements.email.value = "";
    form.elements.intent.value = "";
    form.elements.consent.checked = false;
  } catch (error) {
    showMessage(error.message || "Yente could not save your spot. Please try again.", "error");
  } finally {
    submitButton.removeAttribute("aria-busy");
    updateSelectedCohort();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    pollDelay = POLL_BASE_MS;
    pollCapacity();
  }
});

updateSelectedCohort();
pollCapacity();
