/* Business reports.

   Built with PDFKit rather than a screenshot: every figure is real text, so the
   owner can select it, search it, and paste it into a message to their landlord.
   The document is assembled from the same MongoDB aggregations the dashboard
   reads, under the same tenant authorization, and it wears the business's own
   logo — fetched from that business's branding, never a generic mark and never
   another company's. */

import PDFDocument from 'pdfkit';
import { ObjectId } from 'mongodb';
import { col, collections } from '../db.js';
import { config } from '../config.js';
import { PRINT } from '../lib/palette.js';
import * as analytics from './analytics.js';

const INK = PRINT.ink;
const MUTED = '#3B5568';
const FAINT = '#64798A';
const HAIRLINE = '#D8E2E7';
const PAGE = { size: 'A4', margins: { top: 54, bottom: 64, left: 54, right: 54 } };

const money = value => (value === null || value === undefined ? '—' : String(value));
const minutes = value => (value ? `${value} min` : '—');

const PERIODS = {
  today: { label: 'Today', days: 0 },
  week: { label: 'Last 7 days', days: 7 },
  month: { label: 'Last 30 days', days: 30 }
};

function periodRange(key) {
  const period = PERIODS[key] || PERIODS.today;
  const since = period.days
    ? new Date(Date.now() - period.days * 24 * 3600 * 1000)
    : new Date(new Date().setHours(0, 0, 0, 0));
  return { ...period, since };
}

/* Reads the logo straight out of the collection rather than fetching its own
   URL over the network — same bytes, no round-trip, and nothing to time out
   while somebody waits on a report. */
async function fetchLogo(business) {
  const url = business.logo || business.branding?.logo || '';
  const id = /^\/api\/branding\/([a-f0-9]{24})/i.exec(url)?.[1];
  if (!id) return null;
  try {
    const asset = await col(collections.brandingAssets).findOne({ _id: new ObjectId(id) });
    // PDFKit embeds PNG and JPEG only.
    if (!asset || !/image\/(png|jpe?g)/.test(asset.mime)) return null;
    return asset.data.buffer ? Buffer.from(asset.data.buffer) : Buffer.from(asset.data);
  } catch {
    return null;
  }
}

async function gatherData(business, range) {
  const businessId = business._id;
  const summary = await analytics.summary(businessId, { since: range.since, timezone: business.timezone || 'UTC' });

  const [byHour, staff, tickets, services] = await Promise.all([
    col(collections.events).aggregate([
      { $match: { businessId, type: analytics.EVENTS.ticketCreated, createdAt: { $gte: range.since } } },
      { $group: { _id: { $hour: { date: '$createdAt', timezone: business.timezone || 'UTC' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray(),

    col(collections.events).aggregate([
      { $match: { businessId, type: analytics.EVENTS.ticketCalled, createdAt: { $gte: range.since }, actorId: { $nin: ['', null] } } },
      { $group: { _id: '$actorId', called: { $sum: 1 } } },
      { $sort: { called: -1 } },
      { $limit: 12 }
    ]).toArray(),

    col(collections.tickets)
      .find({ businessId, createdAt: { $gte: range.since } })
      .sort({ createdAt: 1 })
      .limit(1000)          // a day's worth of desk activity, bounded
      .toArray(),

    col(collections.services).find({ businessId }).toArray()
  ]);

  const members = await col(collections.members).find({ businessId }).toArray();
  const staffNames = new Map(members.map(m => [m.userId, m.name || m.email]));

  return {
    summary,
    byHour,
    services,
    staff: staff.map(row => ({ name: staffNames.get(row._id) || 'Team member', called: row.called })),
    tickets
  };
}

/* ---------- drawing helpers ---------- */

function sectionTitle(doc, text) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - 120) doc.addPage();
  doc.x = doc.page.margins.left;
  doc.moveDown(1.2);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(FAINT)
    .text(text.toUpperCase(), doc.page.margins.left, doc.y, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      characterSpacing: 1.6
    });
  doc.moveDown(0.5);
  const y = doc.y;
  doc.strokeColor(HAIRLINE).lineWidth(1).moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y).stroke();
  doc.moveDown(0.8);
}

function statGrid(doc, entries) {
  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const columns = 4;
  const cellWidth = usable / columns;
  const rows = Math.ceil(entries.length / columns);
  const startY = doc.y;

  entries.forEach((entry, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = left + column * cellWidth;
    const y = startY + row * 62;
    doc.font('Helvetica').fontSize(8).fillColor(FAINT)
      .text(entry.label.toUpperCase(), x, y, { width: cellWidth - 12, characterSpacing: 1.2 });
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK)
      .text(entry.value, x, y + 14, { width: cellWidth - 12 });
  });

  doc.y = startY + rows * 62;
  doc.x = left;   // grids move the cursor; sections after them must start at the margin
}

/** A table that flows across pages, repeating its header. */
/** Trims a value to the width it is given, so no cell ever runs into its neighbour. */
function clip(doc, value, width) {
  const text = String(value ?? '—');
  if (doc.widthOfString(text) <= width) return text;
  let cut = text;
  while (cut.length > 1 && doc.widthOfString(`${cut}…`) > width) cut = cut.slice(0, -1);
  return `${cut.trim()}…`;
}

function table(doc, { columns, rows, emptyText = 'Nothing recorded in this period.' }) {
  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const widths = columns.map(column => Math.round(usable * column.width));

  /* Each header cell is drawn at the same y with lineBreak off. Chaining them
     with `continued` made PDFKit advance the cursor per cell, which walked the
     header diagonally down the page. */
  const header = () => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(FAINT);
    let x = left;
    columns.forEach((column, index) => {
      doc.text(clip(doc, column.header.toUpperCase(), widths[index] - 8), x, y, {
        width: widths[index] - 8,
        align: column.align || 'left',
        characterSpacing: 0.8,
        lineBreak: false
      });
      x += widths[index];
    });
    doc.y = y + 14;
    doc.x = left;
    doc.strokeColor(HAIRLINE).lineWidth(1).moveTo(left, doc.y).lineTo(left + usable, doc.y).stroke();
    doc.y += 8;
  };

  doc.x = left;
  if (!rows.length) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(FAINT).text(emptyText, left, doc.y);
    doc.x = left;
    return;
  }

  header();

  rows.forEach(row => {
    // Break before a row rather than through it.
    if (doc.y > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    let x = left;
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    columns.forEach((column, index) => {
      const width = widths[index] - 8;
      doc.text(clip(doc, row[index], width), x, y, {
        width,
        align: column.align || 'left',
        lineBreak: false
      });
      x += widths[index];
    });
    doc.y = y + 17;
    doc.x = left;
  });
  doc.x = left;
}

/* Hours as drawn bars: real vector rectangles beside real text, so the shape of
   the day is readable at a glance and the numbers stay selectable. */
function hourlyChart(doc, byHour) {
  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  if (!byHour.length) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(FAINT)
      .text('Nobody joined the queue in this period.', left, doc.y);
    doc.x = left;
    return;
  }

  const busiest = Math.max(...byHour.map(row => row.count));
  const barLeft = left + 84;
  const barMax = usable - 84 - 40;

  byHour.forEach(row => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
    const y = doc.y;
    doc.font('Helvetica').fontSize(10).fillColor(INK)
      .text(`${String(row._id).padStart(2, '0')}:00`, left, y, { width: 70, lineBreak: false });
    doc.roundedRect(barLeft, y + 2, Math.max(3, (row.count / busiest) * barMax), 9, 2)
      .fillColor(PRINT.accent).fill();
    doc.fillColor(MUTED).font('Helvetica').fontSize(9)
      .text(String(row.count), barLeft + barMax + 8, y, { width: 30, align: 'right', lineBreak: false });
    doc.y = y + 18;
    doc.x = left;
  });
  doc.fillColor(INK);
}

/**
 * Streams a branded PDF report for one business.
 * @param {import('http').ServerResponse} res
 */
export async function streamReport(business, { period = 'today', generatedBy = '' } = {}, res) {
  const range = periodRange(period);
  const [data, logo] = await Promise.all([gatherData(business, range), fetchLogo(business)]);

  // Buffered pages let the footer be stamped on every page once the total is known.
  const doc = new PDFDocument({ ...PAGE, bufferPages: true, info: {
    Title: `${business.name} — queue report`,
    Author: business.name,
    Subject: `Queue activity, ${range.label.toLowerCase()}`,
    Creator: 'Diiwaan'
  } });
  doc.pipe(res);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  /* ---------- masthead ---------- */
  if (logo) {
    try { doc.image(logo, left, doc.y, { fit: [46, 46] }); } catch { /* unreadable image */ }
  }
  const textLeft = logo ? left + 60 : left;
  const headTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(17).fillColor(INK).text(business.name, textLeft, headTop + 2);
  const contact = [business.city, business.address, business.phone].filter(Boolean).join(' · ');
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text(contact || `diiwaan.so/${business.slug}`, textLeft);

  doc.y = Math.max(doc.y, headTop + 46);
  doc.moveDown(1.1);
  doc.font('Helvetica-Bold').fontSize(23).fillColor(INK).text('Queue report');
  doc.font('Helvetica').fontSize(11).fillColor(MUTED).text(
    `${range.label} · ${range.since.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} to ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
  );
  doc.moveDown(0.9);

  /* ---------- headline numbers ---------- */
  const summary = data.summary;
  sectionTitle(doc, 'At a glance');
  statGrid(doc, [
    { label: 'Customers served', value: money(summary.completed) },
    { label: 'Still waiting', value: money(summary.waiting) },
    { label: 'Average wait', value: minutes(summary.avgWaitMin) },
    { label: 'Average service', value: minutes(summary.avgServiceMin) },
    { label: 'Longest wait', value: minutes(summary.maxWaitMin) },
    { label: 'Skipped', value: money(summary.skipped) },
    { label: 'No-shows', value: money(summary.noShow) },
    { label: 'Left the queue', value: money(summary.cancelled) }
  ]);

  /* ---------- services ---------- */
  sectionTitle(doc, 'Service performance');
  table(doc, {
    columns: [
      { header: 'Service', width: 0.4 },
      { header: 'Customers', width: 0.2, align: 'right' },
      { header: 'Completed', width: 0.2, align: 'right' },
      { header: 'Avg service', width: 0.2, align: 'right' }
    ],
    rows: summary.services.map(service => [service.name, service.total, service.completed, minutes(service.avgServiceMin)]),
    emptyText: 'No services were chosen in this period.'
  });

  /* ---------- demand by hour ---------- */
  sectionTitle(doc, 'When customers arrived');
  hourlyChart(doc, data.byHour);

  /* ---------- team ---------- */
  sectionTitle(doc, 'Who served');
  table(doc, {
    columns: [
      { header: 'Team member', width: 0.65 },
      { header: 'Customers called', width: 0.35, align: 'right' }
    ],
    rows: data.staff.map(member => [member.name, member.called]),
    emptyText: 'No calls were recorded in this period.'
  });

  /* ---------- the log ---------- */
  sectionTitle(doc, 'Customer log');
  const timeOf = value => (value
    ? new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '—');
  const STATUS_WORDS = {
    waiting: 'Waiting', called: 'Called', serving: 'Being served', completed: 'Served',
    skipped: 'Skipped', cancelled: 'Left', no_show: 'No-show'
  };
  table(doc, {
    columns: [
      { header: 'Ticket', width: 0.11 },
      { header: 'Customer', width: 0.27 },
      { header: 'Service', width: 0.19 },
      { header: 'Joined', width: 0.11, align: 'right' },
      { header: 'Called', width: 0.11, align: 'right' },
      { header: 'Waited', width: 0.09, align: 'right' },
      { header: 'Outcome', width: 0.12, align: 'right' }
    ],
    rows: data.tickets.map(ticket => [
      ticket.label,
      ticket.name,
      ticket.serviceName || '—',
      timeOf(ticket.createdAt),
      timeOf(ticket.calledAt),
      ticket.calledAt ? `${Math.max(0, Math.round((ticket.calledAt - ticket.createdAt) / 60000))}m` : '—',
      STATUS_WORDS[ticket.status] || ticket.status
    ]),
    emptyText: 'No customers joined in this period.'
  });

  /* ---------- footer on every page ---------- */
  const pages = doc.bufferedPageRange();
  const stamp = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (let index = 0; index < pages.count; index++) {
    doc.switchToPage(pages.start + index);
    /* Writing below the bottom margin makes PDFKit start a new page; drop the
       margin for the duration of the stamp so the footer lands on this one. */
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 42;
    doc.font('Helvetica').fontSize(8).fillColor(FAINT);
    doc.text(`${business.name} · ${range.label} · generated ${stamp}${generatedBy ? ` by ${generatedBy}` : ''}`,
      left, y, { width: (right - left) * 0.75, lineBreak: false, ellipsis: true });
    doc.text(`Page ${index + 1} of ${pages.count}`, left, y, { width: right - left, align: 'right', lineBreak: false });
    doc.fontSize(7).fillColor('#93A3AE')
      .text('Made with Diiwaan', left, y + 11, { width: (right - left) * 0.75, lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  doc.flushPages();
  doc.end();
}
