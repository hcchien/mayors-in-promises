const state = {
  catalog: [],
  results: {},
  viewerVotes: {},
  summary: { totalVotes: 0, voters: 0 },
  me: { user: null, counties: [] },
  year: null,
  countyId: null,
  categoryId: null,
};

const account = document.querySelector("#account");
const yearTabs = document.querySelector("#year-tabs");
const countyGrid = document.querySelector("#county-grid");
const candidateView = document.querySelector("#candidate-view");
const summaryStats = document.querySelector("#summary-stats");
const countyDialog = document.querySelector("#county-dialog");
const countyForm = document.querySelector("#county-form");
const formError = document.querySelector("#county-form-error");
const toast = document.querySelector("#toast");

boot();

async function boot() {
  countyGrid.innerHTML = '<div class="loading">正在整理政見資料…</div>';
  try {
    const [catalogResponse, me] = await Promise.all([api("/api/catalog"), api("/api/me")]);
    Object.assign(state, catalogResponse, { me });
    const params = new URLSearchParams(location.search);
    const requestedYear = Number(params.get("year"));
    state.year = state.catalog.some((item) => item.year === requestedYear)
      ? requestedYear
      : state.catalog[0]?.year;
    state.countyId = params.get("county");
    state.categoryId = Number(params.get("category")) || null;
    render();
  } catch (error) {
    countyGrid.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`;
  }
}

function render() {
  renderAccount();
  renderSummary();
  renderYears();
  renderCounties();
  renderCandidate();
}

function renderAccount() {
  const user = state.me.user;
  if (!user) {
    account.innerHTML = '<a class="login-button" href="/auth/google">使用 Google 登入</a>';
    return;
  }
  const places = state.me.counties.map((item) => item.name).join("、") || "尚未設定縣市";
  account.innerHTML = `
    <span class="account-name">${escapeHtml(user.name)} · ${escapeHtml(places)}</span>
    <button class="text-button" type="button" data-action="profile">縣市設定</button>
    <button class="text-button" type="button" data-action="logout">登出</button>`;
  account.querySelector('[data-action="profile"]').addEventListener("click", openCountyDialog);
  account.querySelector('[data-action="logout"]').addEventListener("click", logout);
}

function renderSummary() {
  const promises = state.catalog.reduce((sum, year) => sum + year.counties.reduce(
    (countySum, county) => countySum + county.candidate.categories.reduce(
      (categorySum, category) => categorySum + category.promises.length, 0,
    ), 0,
  ), 0);
  summaryStats.innerHTML = `
    <div><dt>政見項目</dt><dd>${formatNumber(promises)}</dd></div>
    <div><dt>累積投票</dt><dd>${formatNumber(state.summary.totalVotes)}</dd></div>
    <div><dt>參與市民</dt><dd>${formatNumber(state.summary.voters)}</dd></div>`;
}

function renderYears() {
  yearTabs.innerHTML = state.catalog.map((item) => `
    <button class="year-tab" role="tab" aria-selected="${item.year === state.year}" data-year="${item.year}">
      ${item.year}
    </button>`).join("");
  yearTabs.querySelectorAll("[data-year]").forEach((button) => button.addEventListener("click", () => {
    state.year = Number(button.dataset.year);
    state.countyId = null;
    state.categoryId = null;
    updateUrl();
    renderYears();
    renderCounties();
    renderCandidate();
  }));
}

function renderCounties() {
  const year = selectedYear();
  if (!year) return;
  if (!year.counties.some((county) => county.id === state.countyId)) state.countyId = null;
  countyGrid.innerHTML = year.counties.map((county) => `
    <button class="county-card" aria-pressed="${county.id === state.countyId}" data-county="${county.id}">
      <strong>${escapeHtml(county.name)}</strong>
      <span>${escapeHtml(county.candidate.name)} · ${escapeHtml(county.candidate.party)}</span>
    </button>`).join("");
  countyGrid.querySelectorAll("[data-county]").forEach((button) => button.addEventListener("click", () => {
    state.countyId = button.dataset.county;
    state.categoryId = null;
    updateUrl();
    renderCounties();
    renderCandidate();
    candidateView.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

function renderCandidate() {
  const county = selectedCounty();
  if (!county) {
    candidateView.hidden = true;
    candidateView.innerHTML = "";
    return;
  }
  candidateView.hidden = false;
  const candidate = county.candidate;
  if (!candidate.categories.some((category) => category.id === state.categoryId)) {
    state.categoryId = candidate.categories[0]?.id ?? null;
  }
  const category = candidate.categories.find((item) => item.id === state.categoryId);
  const sourceUrl = extractUrl(candidate.source);
  candidateView.innerHTML = `
    <div class="candidate-header">
      <div>
        <p class="candidate-meta">${state.year} · ${escapeHtml(county.name)} · ${escapeHtml(candidate.party)}</p>
        <h2>${escapeHtml(candidate.name)}</h2>
        ${sourceUrl ? `<a class="source-link" href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noopener">查看中選會當選資料 ↗</a>` : ""}
      </div>
      <p class="candidate-vision">${escapeHtml(candidate.vision)}</p>
    </div>
    <div class="category-wrap">
      <p class="step-label">03 選擇政見分類</p>
      <div class="category-tabs">${candidate.categories.map((item) => `
        <button class="category-tab" aria-pressed="${item.id === state.categoryId}" data-category="${item.id}">
          ${escapeHtml(item.name)} <span>(${item.promises.length})</span>
        </button>`).join("")}</div>
    </div>
    <div>
      <p class="step-label">04 政見項目</p>
      <div class="promise-list">${category ? category.promises.map((item, index) => promiseCard(item, index, county)).join("") : ""}</div>
    </div>`;
  candidateView.querySelectorAll("[data-category]").forEach((button) => button.addEventListener("click", () => {
    state.categoryId = Number(button.dataset.category);
    updateUrl();
    renderCandidate();
  }));
  candidateView.querySelectorAll("[data-vote]").forEach((button) => button.addEventListener("click", handleVote));
}

function promiseCard(item, index, county) {
  const result = state.results[item.id] || { achieved: 0, not_achieved: 0, total: 0 };
  const total = Number(result.total) || 0;
  const achieved = Number(result.achieved) || 0;
  const yesPercent = total ? Math.round((achieved / total) * 100) : 0;
  const noPercent = total ? 100 - yesPercent : 0;
  const viewerVote = state.viewerVotes[item.id];
  const eligible = state.me.counties.some((choice) => choice.id === county.id);
  const disabled = state.me.user && !eligible ? "disabled" : "";
  const note = !state.me.user
    ? "登入後即可投票"
    : eligible ? (viewerVote === undefined ? "每項只計一票，之後仍可更新" : "你的選擇已計入，可隨時更新")
      : `先把${county.name}設為出生地或工作地`;
  return `
    <article class="promise-card">
      <div>
        <span class="promise-index">PROMISE ${String(index + 1).padStart(2, "0")}</span>
        <h3>${escapeHtml(item.title)}</h3>
        <p class="promise-detail">${escapeHtml(item.detail)}</p>
        <details class="promise-source"><summary>資料來源</summary><small>${escapeHtml(item.source)}</small></details>
      </div>
      <div class="vote-panel">
        <div class="result-heading"><span>市民體感兌現率</span><strong>${total ? `${yesPercent}%` : "—"}</strong></div>
        <div class="result-bar" aria-label="兌現 ${yesPercent}%，未兌現 ${noPercent}%">
          <span class="yes" style="width:${yesPercent}%"></span><span class="no" style="width:${noPercent}%"></span>
        </div>
        <div class="result-legend"><span>兌現 ${yesPercent}%</span><span>未兌現 ${noPercent}% · ${formatNumber(total)} 票</span></div>
        <div class="vote-actions">
          <button class="vote-button yes ${viewerVote === 1 ? "selected" : ""}" data-vote="achieved" data-promise="${item.id}" ${disabled}>有兌現</button>
          <button class="vote-button no ${viewerVote === 0 ? "selected" : ""}" data-vote="not_achieved" data-promise="${item.id}" ${disabled}>沒兌現</button>
        </div>
        <p class="vote-note">${escapeHtml(note)}</p>
      </div>
    </article>`;
}

async function handleVote(event) {
  if (!state.me.user) {
    location.href = "/auth/google";
    return;
  }
  const county = selectedCounty();
  if (!state.me.counties.some((choice) => choice.id === county?.id)) {
    openCountyDialog();
    return;
  }
  const button = event.currentTarget;
  const promiseId = Number(button.dataset.promise);
  button.closest(".vote-actions").querySelectorAll("button").forEach((item) => { item.disabled = true; });
  try {
    const response = await api(`/api/promises/${promiseId}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: button.dataset.vote }),
    });
    state.results[promiseId] = response.result;
    state.viewerVotes[promiseId] = response.viewerVote;
    showToast("你的體感投票已更新");
    renderCandidate();
  } catch (error) {
    showToast(error.message);
    renderCandidate();
  }
}

function openCountyDialog() {
  const allCounties = selectedYear()?.counties || state.catalog[0]?.counties || [];
  const options = ['<option value="">不設定</option>', ...allCounties.map((county) =>
    `<option value="${county.id}">${escapeHtml(county.name)}</option>`,
  )].join("");
  document.querySelector("#birth-county").innerHTML = options;
  document.querySelector("#work-county").innerHTML = options;
  document.querySelector("#birth-county").value = state.me.counties.find((item) => item.slot === "birth")?.id || "";
  document.querySelector("#work-county").value = state.me.counties.find((item) => item.slot === "work")?.id || "";
  formError.textContent = "";
  countyDialog.showModal();
}

countyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  const form = new FormData(countyForm);
  try {
    const response = await api("/api/profile/counties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        birthCountyId: form.get("birthCountyId") || null,
        workCountyId: form.get("workCountyId") || null,
      }),
    });
    state.me.counties = response.counties;
    countyDialog.close();
    showToast("縣市設定已儲存");
    renderAccount();
    renderCandidate();
  } catch (error) {
    formError.textContent = error.message;
  }
});

async function logout() {
  await api("/auth/logout", { method: "POST" });
  state.me = { user: null, counties: [] };
  state.viewerVotes = {};
  renderAccount();
  renderCandidate();
  showToast("已登出");
}

function selectedYear() {
  return state.catalog.find((item) => item.year === state.year);
}

function selectedCounty() {
  return selectedYear()?.counties.find((item) => item.id === state.countyId);
}

function updateUrl() {
  const params = new URLSearchParams();
  if (state.year) params.set("year", state.year);
  if (state.countyId) params.set("county", state.countyId);
  if (state.categoryId) params.set("category", state.categoryId);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "請求失敗，請稍後再試");
  return body;
}

function extractUrl(value) {
  return value?.match(/https:\/\/[^\s；]+/)?.[0] || "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-TW").format(Number(value) || 0);
}

let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

