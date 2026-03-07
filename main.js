const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 860,
    minWidth: 800,
    minHeight: 700,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'Image Collage Maker'
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Open single file dialog
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Image',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Read an image file and return a base64 data URL for reliable display in renderer
ipcMain.handle('read-image', async (event, filePath) => {
  const data = fs.readFileSync(filePath);
  const ext  = path.extname(filePath).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                 '.png': 'image/png',  '.gif': 'image/gif',
                 '.bmp': 'image/bmp' }[ext] || 'image/jpeg';
  return `data:${mime};base64,${data.toString('base64')}`;
});

// Open the folder containing the saved file
ipcMain.handle('open-folder', async (event, filePath) => {
  shell.showItemInFolder(filePath);
});

// ── Smart layout: fewer photos → bigger cells ────────────────────────────────
function getLayout(n) {
  if (n <= 1) return { rows: 1, cols: 1 };
  if (n <= 2) return { rows: 1, cols: 2 };
  if (n <= 3) return { rows: 1, cols: 3 };
  if (n <= 4) return { rows: 2, cols: 2 };
  if (n <= 6) return { rows: 2, cols: 3 };
  return { rows: 3, cols: 3 };
}

// Generate Word document
ipcMain.handle('generate-docx', async (event, slots) => {
  // Collect only filled slots (renderer sends b64 + mime, no file path needed)
  const filled = slots.filter(s => s !== null && s.b64);
  if (filled.length === 0) return { success: false, error: 'No images to generate.' };

  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Collage',
    defaultPath: 'photo-collage.docx',
    filters: [{ name: 'Word Document', extensions: ['docx'] }]
  });
  if (saveResult.canceled || !saveResult.filePath) return { success: false, error: 'Save canceled.' };

  try {
    const {
      Document, Packer, Paragraph, Table, TableRow, TableCell,
      ImageRun, WidthType, AlignmentType, HeightRule,
      TableLayoutType, VerticalAlign, BorderStyle
    } = require('docx');

    const { rows, cols } = getLayout(filled.length);

    // A4 in twips (1 inch = 1440 twips, A4 = 210×297 mm)
    const PAGE_W = 11906;   // 210 mm
    const PAGE_H = 16838;   // 297 mm
    const MARGIN = 567;     // ~10 mm margins for maximum image area
    const CONT_W = PAGE_W - 2 * MARGIN;
    const CONT_H = PAGE_H - 2 * MARGIN;

    const cellWTwp = Math.floor(CONT_W / cols);
    const cellHTwp = Math.floor(CONT_H / rows);

    // docx ImageRun.transformation expects PIXELS (it multiplies by 9525 internally to get EMU).
    // 1 twip = 1/1440 inch; at 96 DPI → 1 twip = 96/1440 = 1/15 px
    const TWP_TO_PX = 96 / 1440;
    const imgMaxW = Math.floor(cellWTwp * TWP_TO_PX * 0.97);
    const imgMaxH = Math.floor(cellHTwp * TWP_TO_PX * 0.97);

    function scaleToFit(iw, ih, maxW, maxH) {
      const scale = Math.min(maxW / iw, maxH / ih);
      return { width: Math.floor(iw * scale), height: Math.floor(ih * scale) };
    }

    function mimeToType(mime) {
      const map = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
                    'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp' };
      return map[(mime || '').toLowerCase()] || 'jpg';
    }

    const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

    const tableRows = [];
    for (let r = 0; r < rows; r++) {
      const cells = [];
      for (let c = 0; c < cols; c++) {
        const slot = filled[r * cols + c] || null;
        let children;

        // slot.b64 is raw base64 sent from renderer — no filesystem access needed
        if (slot && slot.b64) {
          const imgData = Buffer.from(slot.b64, 'base64');
          const iw = slot.width  || 800;
          const ih = slot.height || 600;
          const { width, height } = scaleToFit(iw, ih, imgMaxW, imgMaxH);

          children = [new Paragraph({
            alignment: AlignmentType.CENTER,
            // Zero spacing — critical to keep all rows on one page
            spacing: { before: 0, after: 0, line: 240 },
            children: [new ImageRun({
              data: imgData,
              transformation: { width, height },
              type: mimeToType(slot.mime)
            })]
          })];
        } else {
          children = [new Paragraph({
            children: [],
            spacing: { before: 0, after: 0 }
          })];
        }

        cells.push(new TableCell({
          children,
          width: { size: cellWTwp, type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          borders: {
            top: NO_BORDER, bottom: NO_BORDER,
            left: NO_BORDER, right: NO_BORDER
          },
          // Zero margins — image scaling already handles safe sizing
          margins: { top: 0, bottom: 0, left: 0, right: 0 }
        }));
      }

      tableRows.push(new TableRow({
        children: cells,
        height: { value: cellHTwp, rule: HeightRule.EXACT }
      }));
    }

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            size: { width: PAGE_W, height: PAGE_H },
            margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }
          }
        },
        children: [new Table({
          rows: tableRows,
          width: { size: CONT_W, type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
          borders: {
            top: NO_BORDER, bottom: NO_BORDER,
            left: NO_BORDER, right: NO_BORDER,
            insideHorizontal: NO_BORDER, insideVertical: NO_BORDER
          }
        })]
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(saveResult.filePath, buffer);

    return { success: true, filePath: saveResult.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
