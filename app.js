import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

(() => {
  "use strict";

  const STORAGE_KEY = "cardOffers_v1";
  const VIEW_KEY = "cardOffers_view";
  const SYNC_KEY_STORAGE = "cardOffers_syncKey";
  const EXPIRING_THRESHOLD_DAYS = 7;

  /* ---------- Firebase ---------- */

  const firebaseApp = initializeApp(firebaseConfig);
  const db = getFirestore(firebaseApp);
  let unsubscribeSnapshot = null;

  /* ---------- State ---------- */

  let offers = loadOffers();
  let currentView = localStorage.getItem(VIEW_KEY) || "category";
  let searchTerm = "";
  let actionTargetId = null;
  let syncKey = localStorage.getItem(SYNC_KEY_STORAGE) || "";

  /* ---------- DOM refs ---------- */

  const $ = (id) => document.getElementById(id);

  const listContainer = $("listContainer");
  const emptyState = $("emptyState");
  const noResultState = $("noResultState");
  const expiringSection = $("expiringSection");
  const expiringList = $("expiringList");
  const expiringCount = $("expiringCount");

  const searchInput = $("searchInput");
  const clearSearchBtn = $("clearSearchBtn");

  const menuBtn = $("menuBtn");
  const menuPanel = $("menuPanel");
  const exportBtn = $("exportBtn");
  const importBtn = $("importBtn");
  const importFile = $("importFile");

  const syncMenuBtn = $("syncMenuBtn");
  const syncMenuLabel = $("syncMenuLabel");
  const syncDialog = $("syncDialog");
  const closeSyncDialogBtn = $("closeSyncDialogBtn");
  const closeSyncDialogBtn2 = $("closeSyncDialogBtn2");
  const syncStatusText = $("syncStatusText");
  const syncNotConnected = $("syncNotConnected");
  const syncConnected = $("syncConnected");
  const generateSyncBtn = $("generateSyncBtn");
  const syncKeyInput = $("syncKeyInput");
  const connectSyncBtn = $("connectSyncBtn");
  const syncKeyDisplay = $("syncKeyDisplay");
  const copySyncBtn = $("copySyncBtn");
  const disconnectSyncBtn = $("disconnectSyncBtn");

  const addBtn = $("addBtn");
  const offerDialog = $("offerDialog");
  const offerForm = $("offerForm");
  const dialogTitle = $("dialogTitle");
  const closeDialogBtn = $("closeDialogBtn");
  const cancelBtn = $("cancelBtn");

  const actionSheetOverlay = $("actionSheetOverlay");
  const editActionBtn = $("editActionBtn");
  const deleteActionBtn = $("deleteActionBtn");
  const cancelActionBtn = $("cancelActionBtn");

  const toastEl = $("toast");

  const fields = {
    id: $("offerId"),
    bank: $("fieldBank"),
    card: $("fieldCard"),
    category: $("fieldCategory"),
    note: $("fieldNote"),
    startDate: $("fieldStartDate"),
    endDate: $("fieldEndDate"),
    needsRegistration: $("fieldNeedsRegistration"),
    needsSwitch: $("fieldNeedsSwitch"),
  };

  const tiersContainer = $("tiersContainer");
  const addTierBtn = $("addTierBtn");

  /* ---------- Storage ---------- */

  function loadOffers() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(migrateOffer) : [];
    } catch (e) {
      console.error("讀取資料失敗", e);
      return [];
    }
  }

  // 資料格式升級（會依序套用，讓不同版本的舊資料都能自動轉成最新格式）：
  // v1：只有單一 percent 欄位 → 轉成 tiers 陣列
  // v2：tiers 存在，但上限/最高回饋/超額回饋還放在卡片層級 → 搬進每個 tier 裡
  function migrateOffer(offer) {
    let tiers = Array.isArray(offer.tiers) ? offer.tiers : [];
    if (tiers.length === 0 && offer.percent !== "" && offer.percent != null) {
      tiers = [{ id: makeId(), label: "", percent: offer.percent }];
    }
    tiers = tiers.map((t) => ({
      id: t.id || makeId(),
      label: t.label || "",
      percent: t.percent ?? "",
      maxCashback: t.maxCashback ?? (offer.maxCashback ?? ""),
      monthlyCap: t.monthlyCap ?? (offer.monthlyCap ?? ""),
      fallbackPercent: t.fallbackPercent ?? (offer.fallbackPercent ?? ""),
    }));
    const { percent, maxCashback, monthlyCap, fallbackPercent, ...rest } = offer;
    return { ...rest, tiers };
  }

  function saveOffers() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(offers));
  }

  // 每次資料異動都呼叫這個：存本機 + (若已同步) 推上雲端
  function persist() {
    saveOffers();
    if (syncKey) pushToCloud();
  }

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  /* ---------- Date / status helpers ---------- */

  function todayStr() {
    const d = new Date();
    return toDateStr(d);
  }

  function toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function daysBetween(fromStr, toStr) {
    const from = new Date(fromStr + "T00:00:00");
    const to = new Date(toStr + "T00:00:00");
    return Math.round((to - from) / 86400000);
  }

  function getStatus(offer) {
    const today = todayStr();
    if (today > offer.endDate) {
      return { key: "expired", label: "已過期", icon: "🔴" };
    }
    if (today < offer.startDate) {
      return { key: "upcoming", label: "尚未開始", icon: "🔵" };
    }
    const daysLeft = daysBetween(today, offer.endDate);
    if (daysLeft <= EXPIRING_THRESHOLD_DAYS) {
      return { key: "soon", label: `剩 ${daysLeft} 天`, icon: "🟠", daysLeft };
    }
    return { key: "active", label: "生效中", icon: "🟢" };
  }

  function formatDateRange(start, end) {
    return `${formatShortDate(start)} – ${formatShortDate(end)}`;
  }

  function formatShortDate(str) {
    const [y, m, d] = str.split("-");
    return `${y}/${m}/${d}`;
  }

  /* ---------- Filtering / sorting / grouping ---------- */

  function matchesSearch(offer, term) {
    if (!term) return true;
    const tierLabels = Array.isArray(offer.tiers) ? offer.tiers.map((t) => t.label).filter(Boolean) : [];
    const haystack = [offer.bank, offer.card, offer.category, offer.note, ...tierLabels]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  }

  function getFilteredSorted() {
    const term = searchTerm.trim().toLowerCase();
    return offers
      .filter((o) => matchesSearch(o, term))
      .slice()
      .sort((a, b) => {
        const sa = getStatus(a).key;
        const sb = getStatus(b).key;
        const rank = { active: 0, soon: 0, upcoming: 1, expired: 2 };
        if (rank[sa] !== rank[sb]) return rank[sa] - rank[sb];
        return a.endDate.localeCompare(b.endDate);
      });
  }

  function groupOffers(list) {
    const groups = new Map();
    for (const offer of list) {
      const key = currentView === "category" ? (offer.category || "未分類") : `${offer.bank} ${offer.card}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(offer);
    }
    return groups;
  }

  /* ---------- Rendering ---------- */

  function render() {
    renderExpiring();
    renderList();
  }

  function renderExpiring() {
    const soon = offers
      .map((o) => ({ offer: o, status: getStatus(o) }))
      .filter((x) => x.status.key === "soon")
      .sort((a, b) => a.status.daysLeft - b.status.daysLeft);

    if (soon.length === 0) {
      expiringSection.classList.add("hidden");
      expiringList.innerHTML = "";
      return;
    }

    expiringSection.classList.remove("hidden");
    expiringCount.textContent = `${soon.length} 筆`;
    expiringList.innerHTML = soon
      .map(
        ({ offer, status }) => `
        <div class="expiring-item" data-id="${escapeAttr(offer.id)}">
          <span class="expiring-item-name">${escapeHtml(offer.bank)} ${escapeHtml(offer.card)} · ${escapeHtml(offer.category)}</span>
          <span class="expiring-item-days num">剩 ${status.daysLeft} 天</span>
        </div>`
      )
      .join("");

    expiringList.querySelectorAll(".expiring-item").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-id");
        scrollToCard(id);
      });
    });
  }

  function scrollToCard(id) {
    const el = document.querySelector(`.offer-card[data-id="${cssEscape(id)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.background = "var(--card-bg-hover)";
      setTimeout(() => (el.style.background = ""), 700);
    }
  }

  function renderList() {
    const filtered = getFilteredSorted();

    if (offers.length === 0) {
      listContainer.innerHTML = "";
      emptyState.classList.remove("hidden");
      noResultState.classList.add("hidden");
      return;
    }
    emptyState.classList.add("hidden");

    if (filtered.length === 0) {
      listContainer.innerHTML = "";
      noResultState.classList.remove("hidden");
      return;
    }
    noResultState.classList.add("hidden");

    const groups = groupOffers(filtered);
    let html = "";
    for (const [groupName, items] of groups) {
      html += `<div class="group-header">${escapeHtml(groupName)}</div>`;
      for (const offer of items) {
        html += renderCard(offer);
      }
    }
    listContainer.innerHTML = html;

    listContainer.querySelectorAll(".offer-more-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openActionSheet(btn.getAttribute("data-id"));
      });
    });
  }

  function renderTierBlock(tier) {
    const percentText = tier.percent !== "" && tier.percent != null ? `${trimNum(tier.percent)}%` : "–";
    const metaBits = [];
    if (tier.monthlyCap) metaBits.push(`上限 ${escapeHtml(tier.monthlyCap)}`);
    if (tier.maxCashback !== "" && tier.maxCashback != null) metaBits.push(`最高回饋 ${trimNum(tier.maxCashback)}`);
    if (tier.fallbackPercent !== "" && tier.fallbackPercent != null) {
      metaBits.push(`超過上限後 ${trimNum(tier.fallbackPercent)}%`);
    }
    return `
      <div class="tier-block">
        <div class="tier-block-head">
          <span class="tier-block-label">${tier.label ? escapeHtml(tier.label) : ""}</span>
          <span class="tier-block-percent num">${percentText}</span>
        </div>
        ${metaBits.length ? `<div class="tier-block-meta">${metaBits.join(" · ")}</div>` : ""}
      </div>`;
  }

  function renderCard(offer) {
    const status = getStatus(offer);
    const tiers = Array.isArray(offer.tiers) ? offer.tiers : [];
    const tags = [];
    if (offer.needsRegistration) tags.push("需登錄");
    if (offer.needsSwitch) tags.push("需切換權益");

    const tierBlocks = tiers.length
      ? `<div class="tier-blocks">${tiers.map(renderTierBlock).join("")}</div>`
      : `<div class="tier-blocks">${renderTierBlock({})}</div>`;

    return `
      <div class="offer-card" data-id="${escapeAttr(offer.id)}">
        <div class="offer-card-top">
          <div class="offer-main-info">
            <div class="offer-card-title">${escapeHtml(offer.bank)} ${escapeHtml(offer.card)}</div>
            <div class="offer-card-sub">${escapeHtml(offer.category)}</div>
          </div>
        </div>
        ${tierBlocks}
        ${offer.note ? `<div class="offer-card-note">${escapeHtml(offer.note)}</div>` : ""}
        ${tags.length ? `<div class="tag-row">${tags.map((t) => `<span class="tag">${t}</span>`).join("")}</div>` : ""}
        <div class="offer-card-bottom">
          <span class="offer-dates">${formatDateRange(offer.startDate, offer.endDate)}</span>
          <div class="offer-card-actions">
            <span class="status-pill status-${status.key}">${status.icon} ${status.label}</span>
            <button class="offer-more-btn" data-id="${escapeAttr(offer.id)}" aria-label="編輯">編輯</button>
          </div>
        </div>
      </div>`;
  }

  function trimNum(n) {
    const num = Number(n);
    if (Number.isNaN(num)) return n;
    return num % 1 === 0 ? String(num) : String(num);
  }

  /* ---------- Escaping helpers ---------- */

  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function cssEscape(str) {
    if (window.CSS && CSS.escape) return CSS.escape(str);
    return str.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  /* ---------- Search ---------- */

  searchInput.addEventListener("input", () => {
    searchTerm = searchInput.value;
    clearSearchBtn.classList.toggle("hidden", searchTerm.length === 0);
    renderList();
  });

  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    searchTerm = "";
    clearSearchBtn.classList.add("hidden");
    searchInput.focus();
    renderList();
  });

  /* ---------- View toggle ---------- */

  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      currentView = btn.getAttribute("data-view");
      localStorage.setItem(VIEW_KEY, currentView);
      renderList();
    });
  });

  /* ---------- Menu (export / import) ---------- */

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuPanel.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!menuPanel.contains(e.target) && e.target !== menuBtn) {
      menuPanel.classList.add("hidden");
    }
  });

  exportBtn.addEventListener("click", () => {
    menuPanel.classList.add("hidden");
    const dataStr = JSON.stringify(offers, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateTag = todayStr().replace(/-/g, "");
    a.href = url;
    a.download = `card-offers-${dateTag}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("已匯出 JSON");
  });

  importBtn.addEventListener("click", () => {
    menuPanel.classList.add("hidden");
    importFile.value = "";
    importFile.click();
  });

  importFile.addEventListener("change", () => {
    const file = importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed)) throw new Error("格式錯誤");
        const valid = parsed.every((o) => o && typeof o === "object" && o.bank && o.card);
        if (!valid) throw new Error("格式錯誤");
        const ok = window.confirm(`匯入將覆蓋目前所有資料（共 ${offers.length} 筆），確定要繼續嗎？`);
        if (!ok) return;
        offers = parsed.map((o) => migrateOffer({ ...o, id: o.id || makeId() }));
        persist();
        render();
        showToast("匯入成功");
      } catch (e) {
        window.alert("匯入失敗：檔案格式不正確");
      }
    };
    reader.readAsText(file);
  });

  /* ---------- Cloud sync ---------- */

  function generateRandomKey() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
  }

  function updateSyncUI() {
    if (syncKey) {
      syncMenuLabel.textContent = "☁️ 雲端同步（已連接）";
      syncStatusText.textContent = "✅ 這台裝置已連接雲端同步";
      syncStatusText.classList.add("is-synced");
      syncNotConnected.classList.add("hidden");
      syncConnected.classList.remove("hidden");
      syncKeyDisplay.value = syncKey;
    } else {
      syncMenuLabel.textContent = "☁️ 雲端同步";
      syncStatusText.textContent = "尚未設定同步，資料只存在這台裝置";
      syncStatusText.classList.remove("is-synced");
      syncNotConnected.classList.remove("hidden");
      syncConnected.classList.add("hidden");
    }
  }

  function pushToCloud() {
    if (!syncKey) return;
    const ref = doc(db, "syncs", syncKey);
    setDoc(ref, { offers, updatedAt: serverTimestamp() }).catch((err) => {
      console.error("同步上傳失敗", err);
      showToast("雲端同步失敗，請檢查網路");
    });
  }

  function subscribeCloud(key) {
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
    const ref = doc(db, "syncs", key);
    unsubscribeSnapshot = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (!Array.isArray(data.offers)) return;
        offers = data.offers.map(migrateOffer);
        saveOffers();
        render();
      },
      (err) => {
        console.error("雲端同步監聽失敗", err);
        showToast("雲端連線中斷，暫時使用本機資料");
      }
    );
  }

  function startSyncAsNewDevice() {
    const key = generateRandomKey();
    syncKey = key;
    localStorage.setItem(SYNC_KEY_STORAGE, key);
    pushToCloud();
    subscribeCloud(key);
    updateSyncUI();
    showToast("已產生同步碼並開始同步");
  }

  function connectToExistingKey(key) {
    const trimmed = key.trim();
    if (!trimmed) {
      window.alert("請輸入同步碼");
      return;
    }
    if (offers.length > 0) {
      const ok = window.confirm("連接後，這台裝置目前的本機資料會被雲端上的資料覆蓋，確定要繼續嗎？");
      if (!ok) return;
    }
    syncKey = trimmed;
    localStorage.setItem(SYNC_KEY_STORAGE, syncKey);
    subscribeCloud(syncKey);
    updateSyncUI();
    showToast("已連接同步碼");
  }

  function disconnectSync() {
    const ok = window.confirm("停止同步後，這台裝置會保留目前資料，但不會再跟其他裝置同步，確定嗎？");
    if (!ok) return;
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
    syncKey = "";
    localStorage.removeItem(SYNC_KEY_STORAGE);
    updateSyncUI();
    showToast("已停止同步");
  }

  syncMenuBtn.addEventListener("click", () => {
    menuPanel.classList.add("hidden");
    updateSyncUI();
    syncDialog.showModal();
  });

  closeSyncDialogBtn.addEventListener("click", () => syncDialog.close());
  closeSyncDialogBtn2.addEventListener("click", () => syncDialog.close());

  syncDialog.addEventListener("click", (e) => {
    const rect = syncDialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) syncDialog.close();
  });

  generateSyncBtn.addEventListener("click", startSyncAsNewDevice);

  connectSyncBtn.addEventListener("click", () => {
    connectToExistingKey(syncKeyInput.value);
    syncKeyInput.value = "";
  });

  copySyncBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(syncKey);
      showToast("已複製同步碼");
    } catch (e) {
      syncKeyDisplay.select();
      showToast("請手動複製選取的文字");
    }
  });

  disconnectSyncBtn.addEventListener("click", disconnectSync);

  /* ---------- Tier rows (回饋項目) ---------- */

  function makeTierRow(tier) {
    const row = document.createElement("div");
    row.className = "tier-input-row";
    row.innerHTML = `
      <div class="tier-input-top">
        <input type="text" class="tier-label-input" placeholder="名稱（例：國內）" value="${escapeAttr(tier.label || "")}">
        <input type="number" class="tier-percent-input" step="0.1" min="0" placeholder="回饋 %" value="${tier.percent ?? ""}">
        <button type="button" class="tier-remove-btn" aria-label="刪除這筆回饋">✕</button>
      </div>
      <div class="tier-input-grid">
        <input type="number" class="tier-maxcashback-input" step="1" min="0" placeholder="最高回饋" value="${tier.maxCashback ?? ""}">
        <input type="text" class="tier-monthlycap-input" placeholder="每月上限" value="${escapeAttr(tier.monthlyCap || "")}">
        <input type="number" step="0.1" min="0" class="tier-fallback-input" placeholder="超過上限後回饋 %" value="${tier.fallbackPercent ?? ""}">
      </div>
    `;
    row.querySelector(".tier-remove-btn").addEventListener("click", () => row.remove());
    return row;
  }

  function addTierRow(tier = { label: "", percent: "", maxCashback: "", monthlyCap: "", fallbackPercent: "" }) {
    tiersContainer.appendChild(makeTierRow(tier));
  }

  function clearTierRows() {
    tiersContainer.innerHTML = "";
  }

  function collectTiers() {
    const rows = tiersContainer.querySelectorAll(".tier-input-row");
    const tiers = [];
    rows.forEach((row) => {
      const label = row.querySelector(".tier-label-input").value.trim();
      const percentRaw = row.querySelector(".tier-percent-input").value;
      const maxCashbackRaw = row.querySelector(".tier-maxcashback-input").value;
      const monthlyCap = row.querySelector(".tier-monthlycap-input").value.trim();
      const fallbackRaw = row.querySelector(".tier-fallback-input").value;
      if (percentRaw === "" && !label && !monthlyCap && maxCashbackRaw === "" && fallbackRaw === "") return;
      tiers.push({
        id: makeId(),
        label,
        percent: percentRaw === "" ? "" : Number(percentRaw),
        maxCashback: maxCashbackRaw === "" ? "" : Number(maxCashbackRaw),
        monthlyCap,
        fallbackPercent: fallbackRaw === "" ? "" : Number(fallbackRaw),
      });
    });
    return tiers;
  }

  addTierBtn.addEventListener("click", () => addTierRow());

  /* ---------- Dialog: add / edit ---------- */

  function resetForm() {
    fields.id.value = "";
    fields.bank.value = "";
    fields.card.value = "";
    fields.category.value = "";
    fields.note.value = "";
    fields.startDate.value = todayStr();
    fields.endDate.value = "";
    fields.needsRegistration.checked = false;
    fields.needsSwitch.checked = false;
    clearTierRows();
    addTierRow();
  }

  function openAddDialog() {
    resetForm();
    dialogTitle.textContent = "新增優惠";
    offerDialog.showModal();
    setTimeout(() => fields.bank.focus(), 50);
  }

  function openEditDialog(id) {
    const offer = offers.find((o) => o.id === id);
    if (!offer) return;
    fields.id.value = offer.id;
    fields.bank.value = offer.bank || "";
    fields.card.value = offer.card || "";
    fields.category.value = offer.category || "";
    fields.note.value = offer.note || "";
    fields.startDate.value = offer.startDate || "";
    fields.endDate.value = offer.endDate || "";
    fields.needsRegistration.checked = !!offer.needsRegistration;
    fields.needsSwitch.checked = !!offer.needsSwitch;
    clearTierRows();
    const tiers = Array.isArray(offer.tiers) && offer.tiers.length ? offer.tiers : [{}];
    tiers.forEach((t) => addTierRow(t));
    dialogTitle.textContent = "編輯優惠";
    offerDialog.showModal();
  }

  addBtn.addEventListener("click", openAddDialog);
  closeDialogBtn.addEventListener("click", () => offerDialog.close());
  cancelBtn.addEventListener("click", () => offerDialog.close());

  offerDialog.addEventListener("click", (e) => {
    const rect = offerDialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) offerDialog.close();
  });

  offerForm.addEventListener("submit", (e) => {
    e.preventDefault();

    if (!fields.bank.value.trim() || !fields.card.value.trim() || !fields.category.value.trim()) {
      window.alert("請填寫銀行、信用卡與分類");
      return;
    }
    if (!fields.startDate.value || !fields.endDate.value) {
      window.alert("請填寫開始與結束日期");
      return;
    }
    if (fields.startDate.value > fields.endDate.value) {
      window.alert("結束日期不能早於開始日期");
      return;
    }

    const data = {
      bank: fields.bank.value.trim(),
      card: fields.card.value.trim(),
      category: fields.category.value.trim(),
      tiers: collectTiers(),
      note: fields.note.value.trim(),
      startDate: fields.startDate.value,
      endDate: fields.endDate.value,
      needsRegistration: fields.needsRegistration.checked,
      needsSwitch: fields.needsSwitch.checked,
    };

    if (fields.id.value) {
      const idx = offers.findIndex((o) => o.id === fields.id.value);
      if (idx !== -1) offers[idx] = { ...offers[idx], ...data };
      showToast("已儲存變更");
    } else {
      offers.push({ id: makeId(), ...data });
      showToast("已新增優惠");
    }

    persist();
    offerDialog.close();
    render();
  });

  /* ---------- Action sheet: edit / delete ---------- */

  function openActionSheet(id) {
    actionTargetId = id;
    actionSheetOverlay.classList.remove("hidden");
  }

  function closeActionSheet() {
    actionSheetOverlay.classList.add("hidden");
    actionTargetId = null;
  }

  actionSheetOverlay.addEventListener("click", (e) => {
    if (e.target === actionSheetOverlay) closeActionSheet();
  });

  cancelActionBtn.addEventListener("click", closeActionSheet);

  editActionBtn.addEventListener("click", () => {
    const id = actionTargetId;
    closeActionSheet();
    if (id) openEditDialog(id);
  });

  deleteActionBtn.addEventListener("click", () => {
    const id = actionTargetId;
    closeActionSheet();
    if (!id) return;
    const offer = offers.find((o) => o.id === id);
    if (!offer) return;
    const ok = window.confirm(`確定要刪除「${offer.bank} ${offer.card}」的這筆優惠嗎？`);
    if (!ok) return;
    offers = offers.filter((o) => o.id !== id);
    persist();
    render();
    showToast("已刪除");
  });

  /* ---------- Toast ---------- */

  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 1800);
  }

  /* ---------- Init ---------- */

  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    if (btn.getAttribute("data-view") === currentView) {
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
    } else {
      btn.classList.remove("active");
      btn.setAttribute("aria-selected", "false");
    }
  });

  updateSyncUI();
  if (syncKey) subscribeCloud(syncKey);
  render();
})();
