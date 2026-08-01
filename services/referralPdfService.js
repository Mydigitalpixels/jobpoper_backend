/**
 * Streams a paginated PDF of a user's referral list directly to the response.
 *
 * Uses pdfkit with bufferPages so "Page N of M" can be stamped after the total
 * page count is known. Reads the DB in batches so peak memory stays flat
 * regardless of how many referrals the user has.
 *
 * Requires: npm install pdfkit
 */
const path = require("path");
const fs = require("fs");
const User = require("../models/User");
const { deriveAccountStatus } = require("../utils/referralPresenter");

const BRAND = "#4268F2";
const INK = "#1F2937";
const MUTED = "#6B7280";
const LINE = "#CBD5E1";
const BATCH = 500;

const STATUS_LABEL = {
  verified: "Verified",
  not_verified: "Not Verified",
  // Legacy values kept so older in-memory rows still render if present.
  active: "Verified",
  pending_profile: "Not Verified",
  inactive: "Not Verified",
};

// Column layout (x offsets and widths) within the content area.
const COLS = [
  { key: "idx", label: "#", w: 26 },
  { key: "name", label: "Name", w: 110 },
  { key: "email", label: "Email", w: 140 },
  { key: "phone", label: "Phone", w: 85 },
  { key: "date", label: "Registered", w: 70 },
  { key: "status", label: "Verification", w: 64 },
];

const fmtDate = (d) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  const day = String(dt.getDate()).padStart(2, "0");
  const mon = String(dt.getMonth() + 1).padStart(2, "0");
  return `${day}/${mon}/${dt.getFullYear()}`;
};

const streamReferralPdf = async (res, { owner, total }) => {
  let PDFDocument;
  try {
    PDFDocument = require("pdfkit");
  } catch (_) {
    return res.status(500).json({
      status: "error",
      code: "PDF_LIB_MISSING",
      message:
        "PDF generation is unavailable. Please install the pdfkit dependency on the server.",
    });
  }

  const now = new Date();
  const dateStr = fmtDate(now);
  const fileDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const code = owner.referralCode || "user";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="referrals-${code}-${fileDate}.pdf"`
  );

  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
  doc.pipe(res);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentW = right - left;

  const logoPath = path.join(__dirname, "..", "assets", "brand-logo.png");
  const hasLogo = fs.existsSync(logoPath);

  const drawPageHeader = () => {
    doc.fontSize(14).fillColor(BRAND).font("Helvetica-Bold").text("MakeMy Task", left, 40);
    if (hasLogo) {
      try { doc.image(logoPath, right - 40, 34, { width: 40 }); } catch (_) {}
    }
    doc.moveTo(left, 62).lineTo(right, 62).strokeColor(BRAND).lineWidth(1).stroke();
  };

  const drawTableHeader = (y) => {
    let x = left;
    doc.fontSize(9).font("Helvetica-Bold").fillColor("#FFFFFF");
    doc.rect(left, y - 4, contentW, 18).fill(BRAND);
    doc.fillColor("#FFFFFF");
    COLS.forEach((c) => {
      doc.text(c.label, x + 3, y, { width: c.w - 6, ellipsis: true });
      x += c.w;
    });
    return y + 18;
  };

  // ── Title block (page 1) ──
  drawPageHeader();
  let y = 80;
  doc.fontSize(20).fillColor(INK).font("Helvetica-Bold").text("Referral List", left, y);
  y += 30;
  doc.fontSize(10).font("Helvetica").fillColor(INK);
  const meta = [
    ["Representative", owner.profile?.fullName || "—"],
    ["Referral code", owner.referralCode || "—"],
    ["Phone", owner.phoneNumber || "—"],
    ["Total referrals", String(total)],
    ["Export date", dateStr],
  ];
  meta.forEach(([k, v]) => {
    doc.font("Helvetica-Bold").fillColor(MUTED).text(`${k}: `, left, y, { continued: true });
    doc.font("Helvetica").fillColor(INK).text(v);
    y += 16;
  });
  y += 10;
  y = drawTableHeader(y);

  const bottomLimit = doc.page.height - 60;
  let rowIdx = 0;

  const writeRow = (u) => {
    if (y + 16 > bottomLimit) {
      doc.addPage();
      drawPageHeader();
      y = drawTableHeader(80);
    }
    rowIdx += 1;
    const status = STATUS_LABEL[deriveAccountStatus(u)] || "Not Verified";
    const values = {
      idx: String(rowIdx),
      name: u.profile?.fullName || "—",
      email: u.profile?.email || "—",
      phone: u.phoneNumber || "—",
      date: fmtDate(u.createdAt),
      status,
    };
    let x = left;
    doc.font("Helvetica").fontSize(8.5).fillColor(INK);
    if (rowIdx % 2 === 0) {
      doc.rect(left, y - 3, contentW, 15).fill("#F8FAFC");
      doc.fillColor(INK);
    }
    COLS.forEach((c) => {
      doc.text(values[c.key], x + 3, y, { width: c.w - 6, ellipsis: true });
      x += c.w;
    });
    y += 15;
  };

  // ── Batched read → rows ──
  let skip = 0;
  let rows;
  do {
    rows = await User.find({ referredBy: owner._id })
      .select("profile.fullName profile.email profile.isProfileComplete phoneNumber isActive isVerified createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(BATCH)
      .lean();
    rows.forEach(writeRow);
    skip += BATCH;
  } while (rows.length === BATCH);

  // ── Footers on every page ──
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const fy = doc.page.height - 46;
    doc.fontSize(8).font("Helvetica").fillColor(MUTED);
    doc.moveTo(left, fy - 6).lineTo(right, fy - 6).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.fillColor(MUTED);
    doc.text("Confidential — internal use only", left, fy, { width: contentW / 3, align: "left" });
    doc.text(`Page ${i + 1} of ${range.count}`, left, fy, { width: contentW, align: "center" });
    doc.text(`Generated ${dateStr}`, left, fy, { width: contentW, align: "right" });
  }

  doc.end();
};

module.exports = { streamReferralPdf };
