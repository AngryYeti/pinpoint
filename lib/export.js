// lib/export.js
// Builds the punch list in three formats: PDF (via the bundled jsPDF), CSV and plain text.
// Runs in the dashboard page. jsPDF is loaded by a <script> tag there (window.jspdf).

const PRIORITY_LABEL = { none: '', low: 'Low', medium: 'Medium', high: 'High' };

export function formatDate(ts = Date.now()) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function isoDate(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Acme Co. Redesign" -> "acme-co-redesign-punch-list-2026-11-26" */
export function fileBaseName(project) {
  const slug = String(project.name || project.domain)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project';
  return `${slug}-punch-list-${isoDate()}`;
}

/** Groups comments by page, ordered by the first comment number on each page. */
export function groupByPage(comments) {
  const groups = new Map();
  for (const c of [...comments].sort((a, b) => a.number - b.number)) {
    if (!groups.has(c.pageKey)) groups.set(c.pageKey, { pageKey: c.pageKey, url: c.url, title: c.pageTitle, comments: [] });
    const g = groups.get(c.pageKey);
    g.comments.push(c);
    g.title = c.pageTitle || g.title; // newest title wins
  }
  return [...groups.values()];
}

function summary(comments) {
  const done = comments.filter((c) => c.status === 'done').length;
  const high = comments.filter((c) => c.priority === 'high' && c.status !== 'done').length;
  return { total: comments.length, done, open: comments.length - done, high };
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

export function toText(project, comments, { filterLabel } = {}) {
  const s = summary(comments);
  const lines = [
    `${project.name}: Punch list${filterLabel ? ` (${filterLabel})` : ''}`,
    `${project.domain} · ${formatDate()} · ${s.total} item${s.total === 1 ? '' : 's'} (${s.open} open, ${s.done} done)`,
    '',
  ];
  for (const g of groupByPage(comments)) {
    lines.push(`== ${g.title} ==`, g.url);
    for (const c of g.comments) {
      const tags = [c.priority !== 'none' ? PRIORITY_LABEL[c.priority].toUpperCase() : null, c.status === 'done' ? 'DONE' : 'OPEN']
        .filter(Boolean)
        .map((t) => `[${t}]`)
        .join(' ');
      const [first, ...rest] = c.note.split('\n');
      lines.push(`  #${c.number} ${tags} ${first}`);
      for (const line of rest) lines.push(`      ${line}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(value) {
  let s = String(value ?? '');
  // Stop spreadsheet apps from running a note like "=HYPERLINK(...)" as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(project, comments) {
  const header = ['Number', 'Status', 'Priority', 'Note', 'Page title', 'Page URL', 'Element (CSS selector)', 'Created', 'Updated', 'Project', 'Domain'];
  const rows = [header];
  for (const g of groupByPage(comments)) {
    for (const c of g.comments) {
      rows.push([
        c.number,
        c.status === 'done' ? 'Done' : 'Open',
        PRIORITY_LABEL[c.priority] || '',
        c.note,
        c.pageTitle,
        c.url,
        c.selector,
        new Date(c.createdAt).toISOString(),
        new Date(c.updatedAt).toISOString(),
        project.name,
        project.domain,
      ]);
    }
  }
  // The BOM makes Excel open accented characters correctly.
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * jsPDF's built-in fonts only cover Western European characters.
 * Swap typographic punctuation for plain equivalents and replace anything
 * else (emoji, CJK, ...) with "?" so the PDF never shows garbage.
 */
export function pdfSafe(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•●]/g, '*')
    .replace(/ /g, ' ')
    .replace(/[^\n\x20-\x7E\xA1-\xFF]/gu, '?');
}

const COLORS = {
  ink: [17, 24, 39],
  muted: [107, 114, 128],
  line: [229, 231, 235],
  brand: [79, 70, 229],
  priority: {
    high: { bg: [254, 226, 226], fg: [185, 28, 28] },
    medium: { bg: [254, 243, 199], fg: [180, 83, 9] },
    low: { bg: [219, 234, 254], fg: [29, 78, 216] },
  },
  open: { bg: [243, 244, 246], fg: [55, 65, 81] },
  done: { bg: [220, 252, 231], fg: [21, 128, 61] },
};

/**
 * @param {object} project   { name, domain }
 * @param {object[]} comments
 * @param {object} shots     { [commentId]: { dataUrl, width, height } }
 * @returns {Blob}
 */
export function toPDF(project, comments, shots, { filterLabel } = {}) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  doc.setProperties({ title: `${pdfSafe(project.name)} punch list`, creator: 'PinPoint Feedback' });

  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const M = 16; // margin
  const W = PAGE_W - M * 2;
  const BOTTOM = PAGE_H - M - 6; // leave room for the footer
  const INDENT = 11; // text starts to the right of the number bubble
  let y = M;

  const setText = (size, style = 'normal', color = COLORS.ink) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };
  const lineH = (size) => size * 0.3528 * 1.35; // pt -> mm with comfortable leading
  const ensure = (needed) => {
    if (y + needed > BOTTOM) {
      doc.addPage();
      y = M;
    }
  };

  // ---- Header -------------------------------------------------------------
  const s = summary(comments);
  doc.setFillColor(...COLORS.brand);
  doc.rect(0, 0, PAGE_W, 3, 'F');

  setText(9, 'bold', COLORS.brand);
  doc.text('PUNCH LIST', M, y + 3);
  y += 9;
  setText(20, 'bold');
  const titleLines = doc.splitTextToSize(pdfSafe(project.name), W);
  doc.text(titleLines, M, y + 2);
  y += titleLines.length * lineH(20) + 1;

  setText(10, 'normal', COLORS.muted);
  doc.text(pdfSafe(`${project.domain}  |  ${formatDate()}${filterLabel ? `  |  ${filterLabel}` : ''}`), M, y + 2);
  y += 7;

  setText(10, 'normal');
  const stats = `${s.total} item${s.total === 1 ? '' : 's'}   |   ${s.open} open   |   ${s.done} done${s.high ? `   |   ${s.high} high priority open` : ''}`;
  doc.text(stats, M, y + 2);
  y += 6;
  doc.setDrawColor(...COLORS.line);
  doc.setLineWidth(0.4);
  doc.line(M, y, PAGE_W - M, y);
  y += 7;

  if (!comments.length) {
    setText(11, 'italic', COLORS.muted);
    doc.text('No comments yet.', M, y);
  }

  // ---- Comments, grouped by page -----------------------------------------
  for (const group of groupByPage(comments)) {
    ensure(22);
    setText(12.5, 'bold');
    const pageTitle = doc.splitTextToSize(pdfSafe(group.title), W);
    doc.text(pageTitle, M, y);
    y += pageTitle.length * lineH(12.5);
    setText(8.5, 'normal', COLORS.brand);
    const urlLines = doc.splitTextToSize(pdfSafe(group.url), W);
    const urlText = urlLines.length > 1 ? urlLines[0].replace(/.{3}$/, '...') : urlLines[0];
    doc.textWithLink(urlText, M, y, { url: group.url });
    y += 7;

    for (const c of group.comments) {
      const shot = shots[c.id];
      setText(10.5);
      const noteLines = doc.splitTextToSize(pdfSafe(c.note), W - INDENT);
      const noteH = noteLines.length * lineH(10.5);

      let imgW = 0;
      let imgH = 0;
      if (shot?.width && shot?.height) {
        imgW = Math.min(W - INDENT, shot.width * 0.2); // ~0.2mm per px keeps it crisp
        imgH = imgW * (shot.height / shot.width);
        const maxH = 85;
        if (imgH > maxH) {
          imgH = maxH;
          imgW = imgH * (shot.width / shot.height);
        }
      }
      const blockH = 8 + noteH + (imgH ? imgH + 4 : 0) + 6;
      ensure(Math.min(blockH, BOTTOM - M));

      // Number bubble
      const done = c.status === 'done';
      doc.setFillColor(...(done ? COLORS.done.fg : COLORS.brand));
      doc.circle(M + 4, y + 0.6, 4, 'F');
      setText(c.number > 99 ? 7 : 8.5, 'bold', [255, 255, 255]);
      doc.text(String(c.number), M + 4, y + 1.9, { align: 'center' });

      // Badges
      let x = M + INDENT;
      if (c.priority && c.priority !== 'none') {
        x += badge(doc, x, y + 1.6, `${PRIORITY_LABEL[c.priority].toUpperCase()} PRIORITY`, COLORS.priority[c.priority]) + 2;
      }
      x += badge(doc, x, y + 1.6, done ? 'DONE' : 'OPEN', done ? COLORS.done : COLORS.open) + 3;
      setText(8, 'normal', COLORS.muted);
      doc.text(pdfSafe(`Added ${new Date(c.createdAt).toLocaleDateString()}`), x, y + 1.6);
      y += 7;

      // Note (flows across pages if very long)
      setText(10.5, 'normal', done ? COLORS.muted : COLORS.ink);
      for (const line of noteLines) {
        ensure(lineH(10.5));
        doc.text(line, M + INDENT, y + 1);
        y += lineH(10.5);
      }

      // Screenshot
      if (imgH) {
        y += 2;
        ensure(imgH + 2);
        try {
          doc.addImage(shot.dataUrl, 'JPEG', M + INDENT, y, imgW, imgH, undefined, 'FAST');
          doc.setDrawColor(...COLORS.line);
          doc.setLineWidth(0.3);
          doc.rect(M + INDENT, y, imgW, imgH);
          y += imgH;
        } catch (err) {
          console.warn('PinPoint: could not add screenshot to PDF', err);
        }
        y += 2;
      }

      y += 4;
      doc.setDrawColor(...COLORS.line);
      doc.setLineWidth(0.2);
      doc.line(M + INDENT, y - 2, PAGE_W - M, y - 2);
      y += 2;
    }
    y += 4;
  }

  // ---- Footer on every page ------------------------------------------------
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    setText(8, 'normal', COLORS.muted);
    doc.text(pdfSafe(`${project.name}  |  Page ${i} of ${pages}`), M, PAGE_H - 9);
    doc.text('Made with PinPoint Feedback', PAGE_W - M, PAGE_H - 9, { align: 'right' });
  }

  return doc.output('blob');
}

function badge(doc, x, baseline, text, { bg, fg }) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  const w = doc.getTextWidth(text) + 4;
  doc.setFillColor(...bg);
  doc.roundedRect(x, baseline - 3.3, w, 4.6, 1.2, 1.2, 'F');
  doc.setTextColor(...fg);
  doc.text(text, x + 2, baseline);
  return w;
}
