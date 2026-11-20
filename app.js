(function () {
  "use strict";

  // Auto-hydrating CDN engine URLs (cached by Service Worker on first online load for full offline use)
  const ENGINE_SOURCES = {
    pdfLib: [
      "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
      "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js"
    ],
    pdfJs: [
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
      "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js"
    ],
    pdfWorker: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js",
    jsZip: [
      "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
      "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js"
    ]
  };

  let engineReadyPromise = null;

  function loadScriptWithFallback(urls) {
    return new Promise((resolve, reject) => {
      let idx = 0;
      function tryNext() {
        if (idx >= urls.length) {
          reject(new Error("Could not load offline engine libraries. Connect once to cache them."));
          return;
        }
        const script = document.createElement("script");
        script.src = urls[idx++];
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
          script.remove();
          tryNext();
        };
        document.head.appendChild(script);
      }
      tryNext();
    });
  }

  async function ensureEngineReady() {
    if (window.PDFLib && window.pdfjsLib && window.JSZip) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = ENGINE_SOURCES.pdfWorker;
      return;
    }
    if (!engineReadyPromise) {
      engineReadyPromise = (async () => {
        if (!window.PDFLib) await loadScriptWithFallback(ENGINE_SOURCES.pdfLib);
        if (!window.pdfjsLib) await loadScriptWithFallback(ENGINE_SOURCES.pdfJs);
        if (!window.JSZip) await loadScriptWithFallback(ENGINE_SOURCES.jsZip);
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = ENGINE_SOURCES.pdfWorker;
        }
      })();
    }
    return engineReadyPromise;
  }

  const state = {
    mode: "merge",
    files: [],
    vault: [],
    latestOutput: null,
    compression: { dpi: 120, quality: 0.72 },
    defaultPrefix: "pdf_shield",
    busy: false
  };

  const MODE_META = {
    merge: {
      label: "Merge PDF",
      cta: "Run Merge PDF",
      settingsTitle: "Merge Settings",
      accept: "application/pdf,.pdf",
      dropTitle: "Tap to Select PDF Files",
      dropDesc: "Select 2 or more PDFs and order them with Up/Down buttons."
    },
    split: {
      label: "Split Pages",
      cta: "Run Split PDF",
      settingsTitle: "Split Settings",
      accept: "application/pdf,.pdf",
      dropTitle: "Tap to Select a PDF File",
      dropDesc: "Extract page ranges or split every page into a ZIP archive."
    },
    compress: {
      label: "Compress",
      cta: "Run Compress PDF",
      settingsTitle: "Compression Settings",
      accept: "application/pdf,.pdf",
      dropTitle: "Tap to Select PDF to Compress",
      dropDesc: "Sequential page-by-page compression tuned for mobile memory."
    },
    images: {
      label: "Images to PDF",
      cta: "Create PDF from Images",
      settingsTitle: "Images to PDF Settings",
      accept: "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp",
      dropTitle: "Tap to Select Images or Scan",
      dropDesc: "Choose JPG, PNG, or WebP images or use your camera."
    }
  };

  const els = {
    engineBadgeText: document.getElementById("engineBadgeText"),
    offlineReadyPill: document.getElementById("offlineReadyPill"),
    activeModeLabel: document.getElementById("activeModeLabel"),
    btnPrimaryLabel: document.getElementById("btnPrimaryLabel"),
    btnPrimaryRun: document.getElementById("btnPrimaryRun"),
    settingsTitle: document.getElementById("settingsTitle"),
    dropTitle: document.getElementById("dropTitle"),
    dropDesc: document.getElementById("dropDesc"),
    fileInput: document.getElementById("fileInput"),
    cameraInput: document.getElementById("cameraInput"),
    btnBrowseFiles: document.getElementById("btnBrowseFiles"),
    btnCameraScan: document.getElementById("btnCameraScan"),
    btnClearQueue: document.getElementById("btnClearQueue"),
    queueList: document.getElementById("queueList"),
    queueSummary: document.getElementById("queueSummary"),
    outputNameInput: document.getElementById("outputNameInput"),
    splitModeSelect: document.getElementById("splitModeSelect"),
    rangeInputWrap: document.getElementById("rangeInputWrap"),
    pageRangeInput: document.getElementById("pageRangeInput"),
    pageSizeSelect: document.getElementById("pageSizeSelect"),
    statusBox: document.getElementById("statusBox"),
    statusTitle: document.getElementById("statusTitle"),
    statusMeta: document.getElementById("statusMeta"),
    statusMessage: document.getElementById("statusMessage"),
    progressBar: document.getElementById("progressBar"),
    btnDownloadLatest: document.getElementById("btnDownloadLatest"),
    btnShareLatest: document.getElementById("btnShareLatest"),
    vaultList: document.getElementById("vaultList"),
    btnClearVault: document.getElementById("btnClearVault"),
    btnPurgeAll: document.getElementById("btnPurgeAll"),
    defaultPrefixInput: document.getElementById("defaultPrefixInput"),
    btnSavePrefs: document.getElementById("btnSavePrefs"),
    secConnStatus: document.getElementById("secConnStatus"),
    secCacheStatus: document.getElementById("secCacheStatus"),
    stickyActionBar: document.getElementById("stickyActionBar")
  };

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function sanitizeFilename(raw, ext) {
    const base = (raw || `${state.defaultPrefix}_${Date.now()}`)
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "output";
    return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
  }

  function setStatus(title, message, pct = 0, meta = "", isError = false) {
    els.statusBox.classList.remove("hidden");
    els.statusTitle.textContent = title;
    els.statusTitle.className = `font-label-md font-semibold ${isError ? "text-error" : "text-tertiary"}`;
    els.statusMeta.textContent = meta;
    els.statusMessage.textContent = message;
    els.progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  function updateConnectionStatus() {
    if (els.secConnStatus) {
      els.secConnStatus.textContent = navigator.onLine
        ? "Online (No user files ever leave your phone)"
        : "Offline / Airplane Mode (100% Local)";
    }
  }

  function setMode(newMode) {
    if (!MODE_META[newMode]) return;
    state.mode = newMode;
    const meta = MODE_META[newMode];

    document.querySelectorAll(".tool-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === newMode);
    });

    document.querySelectorAll(".tool-panel").forEach((panel) => {
      panel.classList.add("hidden");
    });
    const activePanel = document.getElementById(`panel-${newMode}`);
    if (activePanel) activePanel.classList.remove("hidden");

    els.activeModeLabel.textContent = `Mode: ${meta.label}`;
    els.btnPrimaryLabel.textContent = meta.cta;
    els.settingsTitle.textContent = meta.settingsTitle;
    els.fileInput.accept = meta.accept;
    els.dropTitle.textContent = meta.dropTitle;
    els.dropDesc.textContent = meta.dropDesc;
    els.outputNameInput.value = `${state.defaultPrefix}_${newMode}`;
  }

  function setNav(viewName) {
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.nav === viewName);
    });
    ["tools", "vault", "security", "settings"].forEach((v) => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.classList.toggle("hidden", v !== viewName);
    });
    els.stickyActionBar.classList.toggle("hidden", viewName !== "tools");
    if (viewName === "vault") renderVault();
    if (viewName === "security") updateConnectionStatus();
  }

  async function inspectPdfPageCount(file) {
    try {
      await ensureEngineReady();
      const buf = await file.arrayBuffer();
      const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      const count = doc.numPages;
      await doc.destroy();
      return count;
    } catch {
      return null;
    }
  }

  async function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    for (const f of incoming) {
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      const isImg = f.type.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(f.name);

      if (state.mode === "images" && !isImg) {
        setStatus("Unsupported File", `"${f.name}" is not a supported image (JPG, PNG, WebP).`, 0, "", true);
        continue;
      }
      if (state.mode !== "images" && !isPdf) {
        setStatus("Unsupported File", `"${f.name}" is not a PDF file.`, 0, "", true);
        continue;
      }

      const pageCount = isPdf ? await inspectPdfPageCount(f) : null;
      state.files.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        file: f,
        name: f.name,
        size: f.size,
        pageCount,
        kind: isPdf ? "PDF" : "IMG"
      });
    }

    els.fileInput.value = "";
    els.cameraInput.value = "";
    renderQueue();
  }

  function moveFile(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.files.length) return;
    const copy = state.files.slice();
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    state.files = copy;
    renderQueue();
  }

  function removeFile(index) {
    state.files.splice(index, 1);
    renderQueue();
  }

  function renderQueue() {
    const totalBytes = state.files.reduce((acc, item) => acc + item.size, 0);
    els.queueSummary.textContent = `${state.files.length} ${state.files.length === 1 ? "file" : "files"} • ${formatBytes(totalBytes)}`;

    if (!state.files.length) {
      els.queueList.innerHTML = `<div class="rounded-xl bg-surface-container p-4 text-center font-body-sm text-on-surface-variant">No files queued yet. Tap "Browse Files" or "Camera" above.</div>`;
      return;
    }

    els.queueList.innerHTML = state.files
      .map((item, idx) => {
        const pageBadge = item.pageCount ? ` • ${item.pageCount}p` : "";
        const upDisabled = idx === 0 ? "disabled" : "";
        const downDisabled = idx === state.files.length - 1 ? "disabled" : "";
        return `
          <div class="flex flex-col rounded-xl bg-surface-container p-3 shadow-sm gap-2">
            <div class="flex items-center justify-between gap-2 min-w-0">
              <div class="w-11 h-11 rounded-lg bg-surface-high flex items-center justify-center shrink-0 font-label-sm text-primary-container">
                ${item.kind}
              </div>
              <div class="flex flex-col min-w-0 flex-1">
                <span class="font-label-md text-on-surface font-semibold truncate">${escapeHtml(item.name)}</span>
                <span class="font-label-sm text-on-surface-variant">${formatBytes(item.size)}${pageBadge}</span>
              </div>
            </div>
            <div class="flex items-center justify-end gap-2">
              <button type="button" data-action="up" data-idx="${idx}" ${upDisabled} class="w-11 h-11 rounded-lg bg-surface-high text-on-surface font-label-md disabled:opacity-40" aria-label="Move Up">↑</button>
              <button type="button" data-action="down" data-idx="${idx}" ${downDisabled} class="w-11 h-11 rounded-lg bg-surface-high text-on-surface font-label-md disabled:opacity-40" aria-label="Move Down">↓</button>
              <button type="button" data-action="del" data-idx="${idx}" class="w-11 h-11 rounded-lg bg-error-container text-on-error-container font-label-md" aria-label="Remove File">✕</button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parsePageRanges(rangeStr, totalPages) {
    const pages = new Set();
    const parts = rangeStr.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error("Enter at least one page number or range (e.g. 1-3, 5).");

    for (const part of parts) {
      if (/^\d+$/.test(part)) {
        const p = Number(part);
        if (p < 1 || p > totalPages) throw new Error(`Page ${p} is out of range (1–${totalPages}).`);
        pages.add(p - 1);
      } else if (/^(\d+)\s*-\s*(\d+)$/.test(part)) {
        const [, aStr, bStr] = part.match(/^(\d+)\s*-\s*(\d+)$/);
        const a = Number(aStr);
        const b = Number(bStr);
        if (a < 1 || b < 1 || a > b || b > totalPages) {
          throw new Error(`Invalid range "${part}" for a ${totalPages}-page PDF.`);
        }
        for (let p = a; p <= b; p++) pages.add(p - 1);
      } else {
        throw new Error(`Invalid range syntax: "${part}". Use numbers or ranges like 1-3.`);
      }
    }
    return Array.from(pages).sort((x, y) => x - y);
  }

  async function runMerge() {
    if (state.files.length < 2) {
      throw new Error("Select at least 2 PDF files to merge.");
    }
    const { PDFDocument } = window.PDFLib;
    const merged = await PDFDocument.create();

    for (let i = 0; i < state.files.length; i++) {
      const entry = state.files[i];
      setStatus("Merging PDFs", `Copying pages from ${entry.name}...`, Math.round(((i + 1) / state.files.length) * 90), `${i + 1}/${state.files.length}`);
      const bytes = await entry.file.arrayBuffer();
      const src = await PDFDocument.load(bytes);
      const copied = await merged.copyPages(src, src.getPageIndices());
      copied.forEach((pg) => merged.addPage(pg));
    }

    const outBytes = await merged.save();
    return {
      blob: new Blob([outBytes], { type: "application/pdf" }),
      filename: sanitizeFilename(els.outputNameInput.value, ".pdf"),
      summary: `Merged ${state.files.length} PDFs (${formatBytes(outBytes.byteLength)}).`
    };
  }

  async function runSplit() {
    if (state.files.length !== 1) {
      throw new Error("Select exactly 1 PDF file to split.");
    }
    const { PDFDocument } = window.PDFLib;
    const srcBytes = await state.files[0].file.arrayBuffer();
    const src = await PDFDocument.load(srcBytes);
    const total = src.getPageCount();
    const splitMode = els.splitModeSelect.value;

    if (splitMode === "range") {
      const indices = parsePageRanges(els.pageRangeInput.value, total);
      const outDoc = await PDFDocument.create();
      setStatus("Splitting PDF", `Extracting ${indices.length} selected page(s)...`, 60);
      const pages = await outDoc.copyPages(src, indices);
      pages.forEach((p) => outDoc.addPage(p));
      const outBytes = await outDoc.save();
      return {
        blob: new Blob([outBytes], { type: "application/pdf" }),
        filename: sanitizeFilename(els.outputNameInput.value, ".pdf"),
        summary: `Extracted ${indices.length} page(s) from ${total} total pages (${formatBytes(outBytes.byteLength)}).`
      };
    }

    const zip = new window.JSZip();
    const baseName = sanitizeFilename(els.outputNameInput.value, "").replace(/\.pdf$/i, "");

    for (let i = 0; i < total; i++) {
      setStatus("Splitting Every Page", `Creating page ${i + 1} of ${total}...`, Math.round(((i + 1) / total) * 85), `${i + 1}/${total}`);
      const single = await PDFDocument.create();
      const [pg] = await single.copyPages(src, [i]);
      single.addPage(pg);
      const bytes = await single.save();
      zip.file(`${baseName}_page_${i + 1}.pdf`, bytes);
    }

    setStatus("Packaging ZIP", "Building ZIP archive locally...", 95);
    const zipBlob = await zip.generateAsync({ type: "blob" });
    return {
      blob: zipBlob,
      filename: sanitizeFilename(els.outputNameInput.value, ".zip"),
      summary: `Split ${total} pages into ZIP (${formatBytes(zipBlob.size)}).`
    };
  }

  async function runCompress() {
    if (state.files.length !== 1) {
      throw new Error("Select 1 PDF file to compress.");
    }
    const { PDFDocument } = window.PDFLib;
    const srcFile = state.files[0];
    const arrayBuf = await srcFile.file.arrayBuffer();
    const pdfDoc = await window.pdfjsLib.getDocument({ data: arrayBuf }).promise;
    const totalPages = pdfDoc.numPages;

    const outPdf = await PDFDocument.create();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    const scale = state.compression.dpi / 72;

    try {
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        setStatus(
          "Compressing PDF",
          `Rendering & compressing page ${pageNum} of ${totalPages} at ${state.compression.dpi} DPI...`,
          Math.round((pageNum / totalPages) * 90),
          `${pageNum}/${totalPages}`
        );

        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvasContext: ctx, viewport }).promise;

        const jpegDataUrl = canvas.toDataURL("image/jpeg", state.compression.quality);
        const base64 = jpegDataUrl.split(",")[1];
        const imgBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const embeddedImg = await outPdf.embedJpg(imgBytes);

        const origViewport = page.getViewport({ scale: 1 });
        const pdfPage = outPdf.addPage([origViewport.width, origViewport.height]);
        pdfPage.drawImage(embeddedImg, {
          x: 0,
          y: 0,
          width: origViewport.width,
          height: origViewport.height
        });

        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    } finally {
      await pdfDoc.destroy();
    }

    const outBytes = await outPdf.save();
    const pctSaved = srcFile.size > 0 ? Math.round((1 - outBytes.byteLength / srcFile.size) * 100) : 0;
    return {
      blob: new Blob([outBytes], { type: "application/pdf" }),
      filename: sanitizeFilename(els.outputNameInput.value, ".pdf"),
      summary: `${formatBytes(srcFile.size)} → ${formatBytes(outBytes.byteLength)} (${pctSaved >= 0 ? `${pctSaved}% smaller` : "larger; try Small 72 DPI"}).`
    };
  }

  async function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Could not decode image "${file.name}".`));
      };
      img.src = url;
    });
  }

  async function runImagesToPdf() {
    if (!state.files.length) {
      throw new Error("Select at least 1 image or capture a scan.");
    }
    const { PDFDocument } = window.PDFLib;
    const pdfDoc = await PDFDocument.create();
    const pageSize = els.pageSizeSelect.value;

    for (let i = 0; i < state.files.length; i++) {
      const item = state.files[i];
      setStatus("Building PDF", `Embedding image ${i + 1} of ${state.files.length}...`, Math.round(((i + 1) / state.files.length) * 90), `${i + 1}/${state.files.length}`);

      const imgEl = await loadImageElement(item.file);
      const c = document.createElement("canvas");
      c.width = imgEl.naturalWidth || 1;
      c.height = imgEl.naturalHeight || 1;
      const ctx = c.getContext("2d");
      ctx.drawImage(imgEl, 0, 0);

      const dataUrl = c.toDataURL("image/jpeg", 0.85);
      const b64 = dataUrl.split(",")[1];
      const jpgBytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const embedded = await pdfDoc.embedJpg(jpgBytes);

      c.width = 0;
      c.height = 0;

      const iw = embedded.width;
      const ih = embedded.height;

      if (pageSize === "FIT") {
        const pg = pdfDoc.addPage([iw, ih]);
        pg.drawImage(embedded, { x: 0, y: 0, width: iw, height: ih });
      } else {
        const [pw, ph] = pageSize === "LETTER" ? [612, 792] : [595.28, 841.89];
        const margin = 24;
        const maxW = pw - margin * 2;
        const maxH = ph - margin * 2;
        const ratio = Math.min(maxW / iw, maxH / ih);
        const drawW = iw * ratio;
        const drawH = ih * ratio;
        const x = (pw - drawW) / 2;
        const y = (ph - drawH) / 2;

        const pg = pdfDoc.addPage([pw, ph]);
        pg.drawImage(embedded, { x, y, width: drawW, height: drawH });
      }
    }

    const outBytes = await pdfDoc.save();
    return {
      blob: new Blob([outBytes], { type: "application/pdf" }),
      filename: sanitizeFilename(els.outputNameInput.value, ".pdf"),
      summary: `Created PDF from ${state.files.length} image(s) (${formatBytes(outBytes.byteLength)}).`
    };
  }

  function recordOutput(result) {
    state.latestOutput = result;
    state.vault.unshift({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      filename: result.filename,
      blob: result.blob,
      size: result.blob.size,
      createdAt: new Date().toLocaleTimeString(),
      modeLabel: MODE_META[state.mode].label
    });
    els.btnDownloadLatest.disabled = false;
    els.btnShareLatest.disabled = false;
  }

  function triggerDownload(item) {
    if (!item || !item.blob) return;
    const url = URL.createObjectURL(item.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = item.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function triggerAndroidShare(item) {
    if (!item || !item.blob) return;
    const fileObj = new File([item.blob], item.filename, { type: item.blob.type || "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [fileObj] }) && navigator.share) {
      try {
        await navigator.share({
          title: item.filename,
          files: [fileObj]
        });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    triggerDownload(item);
  }

  function renderVault() {
    if (!state.vault.length) {
      els.vaultList.innerHTML = `<div class="rounded-xl bg-surface-container p-4 text-center font-body-sm text-on-surface-variant">No processed files in this session yet.</div>`;
      return;
    }
    els.vaultList.innerHTML = state.vault
      .map(
        (v, idx) => `
          <div class="rounded-xl bg-surface-container p-3 flex flex-col gap-2">
            <div class="flex flex-col min-w-0">
              <span class="font-label-md text-on-surface font-semibold truncate">${escapeHtml(v.filename)}</span>
              <span class="font-label-sm text-on-surface-variant">${v.modeLabel} • ${formatBytes(v.size)} • ${v.createdAt}</span>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <button type="button" data-vault-dl="${idx}" class="h-11 rounded-lg bg-surface-high text-primary font-label-md">Download</button>
              <button type="button" data-vault-sh="${idx}" class="h-11 rounded-lg bg-surface-high text-tertiary font-label-md">Share</button>
            </div>
          </div>
        `
      )
      .join("");
  }

  async function handlePrimaryRun() {
    if (state.busy) return;

    state.busy = true;
    els.btnPrimaryRun.disabled = true;
    setStatus("Starting", "Initializing local document engine...", 10);

    try {
      await ensureEngineReady();
      let result;
      if (state.mode === "merge") result = await runMerge();
      else if (state.mode === "split") result = await runSplit();
      else if (state.mode === "compress") result = await runCompress();
      else if (state.mode === "images") result = await runImagesToPdf();

      recordOutput(result);
      setStatus("Complete", `${result.summary} Ready to Download or Share.`, 100, result.filename, false);
    } catch (err) {
      setStatus("Processing Error", err && err.message ? err.message : "Failed to process file.", 0, "", true);
    } finally {
      state.busy = false;
      els.btnPrimaryRun.disabled = false;
    }
  }

  document.querySelectorAll(".tool-tab").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => setNav(btn.dataset.nav));
  });

  document.querySelectorAll(".dpi-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dpi-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.compression.dpi = Number(btn.dataset.dpi);
      state.compression.quality = Number(btn.dataset.q);
    });
  });

  els.splitModeSelect.addEventListener("change", () => {
    els.rangeInputWrap.classList.toggle("hidden", els.splitModeSelect.value !== "range");
  });

  els.btnBrowseFiles.addEventListener("click", () => els.fileInput.click());
  els.btnCameraScan.addEventListener("click", () => {
    if (state.mode !== "images") setMode("images");
    els.cameraInput.click();
  });

  els.fileInput.addEventListener("change", (e) => addFiles(e.target.files));
  els.cameraInput.addEventListener("change", (e) => addFiles(e.target.files));

  els.btnClearQueue.addEventListener("click", () => {
    state.files = [];
    renderQueue();
  });

  els.queueList.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    const action = btn.dataset.action;
    if (action === "up") moveFile(idx, -1);
    else if (action === "down") moveFile(idx, 1);
    else if (action === "del") removeFile(idx);
  });

  els.btnPrimaryRun.addEventListener("click", handlePrimaryRun);
  els.btnDownloadLatest.addEventListener("click", () => triggerDownload(state.latestOutput));
  els.btnShareLatest.addEventListener("click", () => triggerAndroidShare(state.latestOutput));

  els.btnClearVault.addEventListener("click", () => {
    state.vault = [];
    renderVault();
  });

  els.vaultList.addEventListener("click", (e) => {
    const dlBtn = e.target.closest("[data-vault-dl]");
    const shBtn = e.target.closest("[data-vault-sh]");
    if (dlBtn) triggerDownload(state.vault[Number(dlBtn.dataset.vaultDl)]);
    if (shBtn) triggerAndroidShare(state.vault[Number(shBtn.dataset.vaultSh)]);
  });

  els.btnPurgeAll.addEventListener("click", () => {
    state.files = [];
    state.vault = [];
    state.latestOutput = null;
    els.btnDownloadLatest.disabled = true;
    els.btnShareLatest.disabled = true;
    renderQueue();
    renderVault();
    setStatus("Sandbox Purged", "Cleared queued files and session vault from memory.", 0);
  });

  els.btnSavePrefs.addEventListener("click", () => {
    const cleaned = (els.defaultPrefixInput.value || "pdf_shield").trim().replace(/[^a-zA-Z0-9_-]+/g, "_") || "pdf_shield";
    state.defaultPrefix = cleaned;
    els.defaultPrefixInput.value = cleaned;
    els.outputNameInput.value = `${cleaned}_${state.mode}`;
    setStatus("Preferences Saved", `Default output prefix set to "${cleaned}".`, 0);
    setNav("tools");
  });

  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  // Preload & cache the PDF libraries immediately on startup
  ensureEngineReady()
    .then(() => {
      if (els.engineBadgeText) els.engineBadgeText.textContent = "Offline Engine Ready";
      if (els.offlineReadyPill) els.offlineReadyPill.textContent = "Air-Gap Ready";
      if (els.secCacheStatus) els.secCacheStatus.textContent = "Cached & Ready Offline";
    })
    .catch(() => {
      if (els.engineBadgeText) els.engineBadgeText.textContent = "Connect Once to Cache";
      if (els.offlineReadyPill) els.offlineReadyPill.textContent = "Needs 1st Sync";
      if (els.secCacheStatus) els.secCacheStatus.textContent = "Not cached yet (open once while online)";
    });

  setMode("merge");
  renderQueue();
  updateConnectionStatus();
})();
