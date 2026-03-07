// ── State ──────────────────────────────────────────────────────────────────
const MAX_SLOTS = 9;
const slots = new Array(MAX_SLOTS).fill(null);
// slot: { displayURL, b64, mime, width, height }
//   displayURL: blob:// or data: URL for the <img> preview
//   b64:        raw base64 string (no prefix) sent to main for docx
//   mime:       e.g. 'image/jpeg'

let dragSrcIndex = null;

// ── DOM ────────────────────────────────────────────────────────────────────
const grid        = document.getElementById('grid');
const generateBtn = document.getElementById('generateBtn');
const clearBtn    = document.getElementById('clearBtn');
const imageCount  = document.getElementById('imageCount');
const layoutLabel = document.getElementById('layoutLabel');
const notifEl     = document.getElementById('notification');
const notifMsg    = document.getElementById('notifMsg');
const notifFolder = document.getElementById('notifFolder');
const dropOverlay = document.getElementById('dropOverlay');

// ── Smart layout helper (mirrors main.js) ──────────────────────────────────
function getLayout(n) {
  if (n <= 1) return { rows: 1, cols: 1 };
  if (n <= 2) return { rows: 1, cols: 2 };
  if (n <= 3) return { rows: 1, cols: 3 };
  if (n <= 4) return { rows: 2, cols: 2 };
  if (n <= 6) return { rows: 2, cols: 3 };
  return { rows: 3, cols: 3 };
}

// ── Build grid ─────────────────────────────────────────────────────────────
function buildGrid() {
  grid.innerHTML = '';
  for (let i = 0; i < MAX_SLOTS; i++) {
    const el = document.createElement('div');
    el.className = 'slot';
    el.dataset.index = i;
    el.setAttribute('draggable', 'false');
    el.innerHTML = `
      <img class="slot-image" src="" alt="" />
      <div class="slot-placeholder">
        <svg width="32" height="32" viewBox="0 0 36 36" fill="none">
          <rect x="3" y="7" width="30" height="22" rx="3" stroke="currentColor" stroke-width="1.8"/>
          <circle cx="12" cy="14" r="3" stroke="currentColor" stroke-width="1.8"/>
          <path d="M3 25l8-7 5 5 4-4 13 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="drop-text">Drop image here</span>
        <span class="browse-hint">or click to browse</span>
      </div>
      <button class="remove-btn" title="Remove">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
      <div class="slot-num">${i + 1}</div>
    `;
    bindSlotEvents(el, i);
    grid.appendChild(el);
  }
}

// ── Event binding ──────────────────────────────────────────────────────────
function bindSlotEvents(el, index) {
  el.addEventListener('click', (e) => {
    if (e.target.closest('.remove-btn')) return;
    if (!slots[index]) openBrowse(index);
  });

  el.querySelector('.remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    removeSlot(index);
  });

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.add(dragSrcIndex !== null ? 'drag-over-internal' : 'drag-over');
  });

  el.addEventListener('dragleave', () => {
    el.classList.remove('drag-over', 'drag-over-internal');
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-over', 'drag-over-internal');

    if (dragSrcIndex !== null) {
      if (dragSrcIndex !== index) swapSlots(dragSrcIndex, index);
      dragSrcIndex = null;
    } else {
      handleFileDrop(e.dataTransfer.files, index, true);
    }
  });

  el.addEventListener('dragstart', (e) => {
    if (!slots[index]) { e.preventDefault(); return; }
    dragSrcIndex = index;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  });

  el.addEventListener('dragend', () => {
    dragSrcIndex = null;
    el.classList.remove('dragging');
    document.querySelectorAll('.slot').forEach(s =>
      s.classList.remove('drag-over', 'drag-over-internal')
    );
  });
}

// ── File → base64 (renderer-side, no IPC needed) ──────────────────────────
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result); // "data:image/jpeg;base64,..."
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function parseDataURL(dataURL) {
  // "data:image/jpeg;base64,/9j/..." → { b64, mime }
  const comma = dataURL.indexOf(',');
  const meta  = dataURL.slice(5, comma);         // "image/jpeg;base64"
  const mime  = meta.split(';')[0];              // "image/jpeg"
  const b64   = dataURL.slice(comma + 1);        // raw base64
  return { b64, mime };
}

// ── File handling ──────────────────────────────────────────────────────────
async function handleFileDrop(files, startIndex, overwrite = false) {
  let slotIdx = startIndex;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!isImageFile(file)) continue;

    if (!overwrite) {
      while (slotIdx < MAX_SLOTS && slots[slotIdx] !== null) slotIdx++;
    }
    if (slotIdx >= MAX_SLOTS) {
      showNotification('All 9 slots are filled.', 'error');
      break;
    }

    try {
      const dataURL = await fileToDataURL(file);
      // Use a blob URL for the preview (lighter on the DOM than a huge base64 src)
      const blobURL = URL.createObjectURL(file);
      const { b64, mime } = parseDataURL(dataURL);
      addImage(slotIdx, blobURL, b64, mime);
    } catch {
      showNotification('Could not read image file.', 'error');
    }

    slotIdx++;
  }
}

function isImageFile(file) {
  return /^image\/(jpeg|png|gif|bmp|webp)$/i.test(file.type) ||
         /\.(jpg|jpeg|png|gif|bmp)$/i.test(file.name);
}

// Browse via dialog: main process reads file and returns base64 data URL
async function openBrowse(index) {
  const filePath = await window.electronAPI.openFileDialog();
  if (!filePath) return;

  try {
    const dataURL = await window.electronAPI.readImage(filePath);
    const { b64, mime } = parseDataURL(dataURL);
    // Use the data URL directly as the preview src for browsed files
    addImage(index, dataURL, b64, mime);
  } catch {
    showNotification('Could not load image.', 'error');
  }
}

// ── Add image to a slot ────────────────────────────────────────────────────
function addImage(index, displayURL, b64, mime) {
  const img = new Image();
  img.onload = () => {
    // Revoke previous blob URL if any
    if (slots[index] && slots[index].displayURL && slots[index].displayURL.startsWith('blob:')) {
      URL.revokeObjectURL(slots[index].displayURL);
    }
    slots[index] = { displayURL, b64, mime, width: img.naturalWidth, height: img.naturalHeight };
    renderSlot(index);
    updateUI();
  };
  img.onerror = () => {
    if (displayURL.startsWith('blob:')) URL.revokeObjectURL(displayURL);
    showNotification('Could not load image.', 'error');
  };
  img.src = displayURL;
}

// ── Slot operations ────────────────────────────────────────────────────────
function removeSlot(index) {
  if (slots[index] && slots[index].displayURL && slots[index].displayURL.startsWith('blob:')) {
    URL.revokeObjectURL(slots[index].displayURL);
  }
  slots[index] = null;
  renderSlot(index);
  updateUI();
}

function swapSlots(a, b) {
  [slots[a], slots[b]] = [slots[b], slots[a]];
  renderSlot(a);
  renderSlot(b);
  updateUI();
}

// ── Render slot ────────────────────────────────────────────────────────────
function renderSlot(index) {
  const el   = grid.children[index];
  const slot = slots[index];
  const img  = el.querySelector('.slot-image');
  const ph   = el.querySelector('.slot-placeholder');
  const rmv  = el.querySelector('.remove-btn');

  if (slot) {
    el.classList.add('filled');
    el.setAttribute('draggable', 'true');
    img.src = slot.displayURL;
    img.style.display = 'block';
    ph.style.display  = 'none';
    rmv.style.display = 'flex';
  } else {
    el.classList.remove('filled');
    el.setAttribute('draggable', 'false');
    img.src = '';
    img.style.display = 'none';
    ph.style.display  = 'flex';
    rmv.style.display = 'none';
  }
}

// ── Update header ──────────────────────────────────────────────────────────
function updateUI() {
  const count = slots.filter(Boolean).length;
  imageCount.textContent = `${count} / 9 images`;
  generateBtn.disabled   = count === 0;
  clearBtn.disabled      = count === 0;

  if (count === 0) {
    layoutLabel.textContent = '—';
  } else {
    const { rows, cols } = getLayout(count);
    layoutLabel.textContent = `${count} photo${count > 1 ? 's' : ''} → ${rows}×${cols} grid on A4`;
  }
}

// ── Window-level drag/drop ─────────────────────────────────────────────────
let overlayTimer = null;

document.addEventListener('dragover', (e) => {
  if (dragSrcIndex !== null) return;
  e.preventDefault();
  dropOverlay.classList.add('visible');
  clearTimeout(overlayTimer);
});

document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null || e.relatedTarget === document.documentElement) {
    overlayTimer = setTimeout(() => dropOverlay.classList.remove('visible'), 80);
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('visible');
  if (e.target.closest('.slot')) return;
  handleFileDrop(e.dataTransfer.files, 0, false);
});

// ── Generate ───────────────────────────────────────────────────────────────
generateBtn.addEventListener('click', async () => {
  generateBtn.disabled  = true;
  generateBtn.innerHTML = '<span class="spinner"></span> Generating…';

  // Send b64 + mime so main never needs to touch the filesystem for image data
  const payload = slots.map(s =>
    s ? { b64: s.b64, mime: s.mime, width: s.width, height: s.height } : null
  );

  const result = await window.electronAPI.generateDocx(payload);

  generateBtn.disabled  = false;
  generateBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <rect x="10" y="7" width="5" height="7" rx="1" fill="currentColor" opacity="0.3"/>
      <path d="M12 9v3M10.5 11.5l1.5 1.5 1.5-1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    Export to Word`;

  if (result.success) {
    showNotification(`Saved: ${result.filePath}`, 'success', result.filePath);
  } else {
    showNotification(`Error: ${result.error}`, 'error');
  }
});

// ── Clear all ──────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (slots[i]) {
      if (slots[i].displayURL && slots[i].displayURL.startsWith('blob:')) {
        URL.revokeObjectURL(slots[i].displayURL);
      }
      slots[i] = null;
      renderSlot(i);
    }
  }
  updateUI();
});

// ── Notification ───────────────────────────────────────────────────────────
let notifTimer = null;

function showNotification(msg, type = 'info', savedFilePath = null) {
  notifMsg.textContent = msg;
  notifEl.className    = `notification ${type} show`;

  if (savedFilePath) {
    notifFolder.style.display = 'inline-flex';
    notifFolder.onclick = () => window.electronAPI.openFolder(savedFilePath);
  } else {
    notifFolder.style.display = 'none';
  }

  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => { notifEl.className = 'notification'; }, 6000);
}

// ── Init ───────────────────────────────────────────────────────────────────
buildGrid();
updateUI();
