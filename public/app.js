const els = {
  homeBtn: document.getElementById("homeBtn"),
  searchForm: document.getElementById("searchForm"),
  searchInput: document.getElementById("searchInput"),
  chipsBar: document.getElementById("chipsBar"),
  statusBanner: document.getElementById("statusBanner"),
  gridSection: document.getElementById("gridSection"),
  gridHeading: document.getElementById("gridHeading"),
  gridSource: document.getElementById("gridSource"),
  videoGrid: document.getElementById("videoGrid"),
  playerSection: document.getElementById("playerSection"),
  backBtn: document.getElementById("backBtn"),
  videoPlayer: document.getElementById("videoPlayer"),
  playerLoader: document.getElementById("playerLoader"),
  qualitySelect: document.getElementById("qualitySelect"),
  sourceBadge: document.getElementById("sourceBadge"),
  copyLinkBtn: document.getElementById("copyLinkBtn"),
  videoTitle: document.getElementById("videoTitle"),
  videoAuthor: document.getElementById("videoAuthor"),
  videoViews: document.getElementById("videoViews"),
  videoPublished: document.getElementById("videoPublished"),
  videoDescription: document.getElementById("videoDescription"),
  relatedList: document.getElementById("relatedList"),
  historyBtn: document.getElementById("historyBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsModal: document.getElementById("settingsModal"),
  closeSettings: document.getElementById("closeSettings"),
  customPipedInput: document.getElementById("customPipedInput"),
  customInvidiousInput: document.getElementById("customInvidiousInput"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  clearHistoryBtn: document.getElementById("clearHistoryBtn")
};

let currentVideoId = null;

function getSettings() {
  return {
    piped: localStorage.getItem("ytp_piped") || "",
    invidious: localStorage.getItem("ytp_invidious") || ""
  };
}

function buildApiQuery(params = {}) {
  const s = getSettings();
  const qs = new URLSearchParams(params);
  if (s.piped) qs.set("piped", s.piped);
  if (s.invidious) qs.set("invidious", s.invidious);
  return qs.toString();
}

function showError(msg) {
  if (!msg) {
    els.statusBanner.classList.add("hidden");
    els.statusBanner.textContent = "";
    return;
  }
  els.statusBanner.textContent = msg;
  els.statusBanner.classList.remove("hidden");
}

function renderSkeletons(count = 8) {
  els.videoGrid.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const card = document.createElement("div");
    card.className = "video-card";
    card.innerHTML = `
      <div class="thumb-wrap skeleton"></div>
      <div class="card-body">
        <div class="skeleton" style="height:16px;border-radius:4px;margin-bottom:8px;"></div>
        <div class="skeleton" style="height:12px;width:60%;border-radius:4px;"></div>
      </div>
    `;
    els.videoGrid.appendChild(card);
  }
}

function renderGrid(items, heading, sourceText = "") {
  els.gridHeading.textContent = heading;
  els.gridSource.textContent = sourceText ? `المصدر: ${sourceText}` : "";
  els.videoGrid.innerHTML = "";

  if (!items || items.length === 0) {
    els.videoGrid.innerHTML = `<p class="muted-text">لا توجد نتائج لعرضها.</p>`;
    return;
  }

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "video-card";
    card.onclick = () => openVideo(item.id);
    card.innerHTML = `
      <div class="thumb-wrap">
        <img src="${item.thumbnail}" alt="" loading="lazy" />
        ${item.duration ? `<span class="duration-badge">${escapeHtml(item.duration)}</span>` : ""}
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(item.title)}</div>
        <div class="card-meta">
          <span>${escapeHtml(item.author || "")}</span>
          <span>${escapeHtml([item.views, item.published].filter(Boolean).join(" • "))}</span>
        </div>
      </div>
    `;
    els.videoGrid.appendChild(card);
  }
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function saveToHistory(video) {
  try {
    const hist = JSON.parse(localStorage.getItem("ytp_history") || "[]");
    const filtered = hist.filter((v) => v.id !== video.id);
    filtered.unshift({
      id: video.id,
      title: video.title,
      author: video.author,
      duration: video.duration,
      views: video.views,
      thumbnail: `/api/thumb?id=${video.id}&q=mqdefault`
    });
    localStorage.setItem("ytp_history", JSON.stringify(filtered.slice(0, 30)));
  } catch {
    // ignore storage errors
  }
}

function showGridView() {
  els.videoPlayer.pause();
  els.videoPlayer.removeAttribute("src");
  els.videoPlayer.load();
  els.playerSection.classList.add("hidden");
  els.gridSection.classList.remove("hidden");
  const url = new URL(window.location.href);
  url.searchParams.delete("v");
  window.history.replaceState({}, "", url);
}

async function loadCategory(cat = "all", label = "مقاطع رائجة") {
  showError("");
  showGridView();
  renderSkeletons(8);
  try {
    const res = await fetch(`/api/trending?${buildApiQuery({ cat })}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "خطأ في التحميل");
    renderGrid(data.items, label, data.source);
  } catch (err) {
    els.videoGrid.innerHTML = "";
    showError(err.message);
  }
}

async function doSearch(query) {
  if (!query.trim()) return;
  showError("");
  showGridView();
  renderSkeletons(8);
  try {
    const res = await fetch(`/api/search?${buildApiQuery({ q: query.trim() })}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "فشل البحث");
    renderGrid(data.items, `نتائج البحث: ${query}`, data.source);
  } catch (err) {
    els.videoGrid.innerHTML = "";
    showError(err.message);
  }
}

async function openVideo(videoId) {
  currentVideoId = videoId;
  showError("");
  els.gridSection.classList.add("hidden");
  els.playerSection.classList.remove("hidden");
  els.playerLoader.classList.remove("hidden");
  els.videoPlayer.pause();
  els.videoPlayer.removeAttribute("src");
  els.relatedList.innerHTML = "";
  window.scrollTo({ top: 0, behavior: "smooth" });

  const url = new URL(window.location.href);
  url.searchParams.set("v", videoId);
  window.history.replaceState({}, "", url);

  try {
    const res = await fetch(`/api/video?${buildApiQuery({ id: videoId })}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "تعذر تشغيل الفيديو");

    els.videoTitle.textContent = data.title;
    els.videoAuthor.textContent = data.author || "قناة يوتيوب";
    els.videoViews.textContent = data.views || "";
    els.videoPublished.textContent = data.published || "";
    els.videoDescription.textContent = data.description || "لا يوجد وصف.";
    els.sourceBadge.textContent = `المصدر: ${data.source}`;

    saveToHistory(data);

    // Populate quality selector
    els.qualitySelect.innerHTML = "";
    const s = getSettings();
    const extraParams = [];
    if (s.piped) extraParams.push(`piped=${encodeURIComponent(s.piped)}`);
    if (s.invidious) extraParams.push(`invidious=${encodeURIComponent(s.invidious)}`);
    const suffix = extraParams.length ? `&${extraParams.join("&")}` : "";

    data.formats.forEach((f, idx) => {
      const opt = document.createElement("option");
      opt.value = f.proxyUrl + suffix;
      opt.textContent = f.label;
      if (idx === 0) opt.selected = true;
      els.qualitySelect.appendChild(opt);
    });

    if (data.formats.length > 0) {
      els.videoPlayer.src = data.formats[0].proxyUrl + suffix;
      els.videoPlayer.load();
      els.videoPlayer.play().catch(() => {});
    }

    // Related videos
    for (const rel of data.related || []) {
      const item = document.createElement("div");
      item.className = "related-item";
      item.onclick = () => openVideo(rel.id);
      item.innerHTML = `
        <div class="thumb-wrap">
          <img src="${rel.thumbnail}" alt="" loading="lazy" />
          ${rel.duration ? `<span class="duration-badge">${escapeHtml(rel.duration)}</span>` : ""}
        </div>
        <div class="related-info">
          <div class="related-title">${escapeHtml(rel.title)}</div>
          <div class="related-meta">${escapeHtml(rel.author || "")}</div>
          <div class="related-meta">${escapeHtml(rel.views || "")}</div>
        </div>
      `;
      els.relatedList.appendChild(item);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    els.playerLoader.classList.add("hidden");
  }
}

// Event Listeners
els.searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  doSearch(els.searchInput.value);
});

els.homeBtn.addEventListener("click", () => {
  els.searchInput.value = "";
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  document.querySelector('.chip[data-cat="all"]')?.classList.add("active");
  loadCategory("all", "مقاطع رائجة");
});

els.backBtn.addEventListener("click", showGridView);

els.chipsBar.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  loadCategory(btn.dataset.cat, btn.textContent);
});

els.qualitySelect.addEventListener("change", () => {
  const currentTime = els.videoPlayer.currentTime || 0;
  const wasPlaying = !els.videoPlayer.paused;
  els.videoPlayer.src = els.qualitySelect.value;
  els.videoPlayer.load();
  els.videoPlayer.addEventListener(
    "loadedmetadata",
    () => {
      try {
        els.videoPlayer.currentTime = currentTime;
      } catch {}
      if (wasPlaying) els.videoPlayer.play().catch(() => {});
    },
    { once: true }
  );
});

els.videoPlayer.addEventListener("waiting", () => {
  els.playerLoader.classList.remove("hidden");
});
els.videoPlayer.addEventListener("canplay", () => {
  els.playerLoader.classList.add("hidden");
});
els.videoPlayer.addEventListener("error", () => {
  els.playerLoader.classList.add("hidden");
  showError("حدث خطأ أثناء تحميل البث. جرب تغيير الجودة أو إضافة سيرفر Piped في الإعدادات.");
});

els.copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    els.copyLinkBtn.textContent = "تم النسخ ✓";
    setTimeout(() => (els.copyLinkBtn.textContent = "نسخ رابط المشاهدة"), 1800);
  } catch {
    showError("لم يتم النسخ تلقائياً، انسخ الرابط من شريط العنوان.");
  }
});

els.historyBtn.addEventListener("click", () => {
  showError("");
  showGridView();
  const hist = JSON.parse(localStorage.getItem("ytp_history") || "[]");
  renderGrid(hist, "سجل المشاهدة المحلي", "المتصفح");
});

// Settings Modal
els.settingsBtn.addEventListener("click", () => {
  const s = getSettings();
  els.customPipedInput.value = s.piped;
  els.customInvidiousInput.value = s.invidious;
  els.settingsModal.classList.remove("hidden");
});

els.closeSettings.addEventListener("click", () => {
  els.settingsModal.classList.add("hidden");
});

els.settingsModal.addEventListener("click", (e) => {
  if (e.target === els.settingsModal) els.settingsModal.classList.add("hidden");
});

els.saveSettingsBtn.addEventListener("click", () => {
  localStorage.setItem("ytp_piped", els.customPipedInput.value.trim());
  localStorage.setItem("ytp_invidious", els.customInvidiousInput.value.trim());
  els.settingsModal.classList.add("hidden");
  if (currentVideoId && !els.playerSection.classList.contains("hidden")) {
    openVideo(currentVideoId);
  } else {
    loadCategory("all", "مقاطع رائجة");
  }
});

els.clearHistoryBtn.addEventListener("click", () => {
  localStorage.removeItem("ytp_history");
  els.settingsModal.classList.add("hidden");
});

// Initial load
(function init() {
  const params = new URLSearchParams(window.location.search);
  const v = params.get("v");
  if (v) {
    openVideo(v);
  } else {
    loadCategory("all", "مقاطع رائجة");
  }
})();
