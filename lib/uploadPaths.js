// lib/uploadPaths.js
// Single source of truth for where merchant-uploaded files (receipt logos,
// profile photos) physically live on disk.
//
// WHY THIS IS AN ENV VAR: these used to be hardcoded to public/uploads/,
// inside the repo checkout. That works on a laptop and silently destroys
// data on a real host -- Railway (like Heroku/Render) gives each deploy a
// fresh filesystem, so every redeploy would wipe every logo, and since logos
// print on receipts, every merchant's receipts would quietly lose their
// branding on each deploy.
//
// The fix is a Railway volume: a disk that survives deploys, mounted at a
// path outside the checkout. Point UPLOAD_DIR at that mount path and the
// files persist. Left unset, this falls back to the old in-repo location, so
// local development is unchanged and needs no setup.
//
// TRADEOFF: a volume attaches to exactly ONE running instance, so this rules
// out running multiple copies of the app. That was already true -- the daily
// retention purge and the affiliate-payout scheduler are both in-memory
// setInterval timers with no shared lock, so a second instance would run its
// own duplicate copy of each (see CLAUDE.md's "Not done yet"). If this ever
// needs to scale past one instance, uploads move to object storage
// (S3 / Supabase Storage) and those two jobs become a real cron service.
const path = require('path');
const fs = require('fs');

// The directory holding every uploaded file. Everything below is a
// subdirectory of it, and the public URLs (/uploads/logos/..., stored in
// ReceiptTheme.logoUrl and Merchant.profilePhotoUrl) are served from here by
// server.js -- so moving this path does NOT require rewriting any URL
// already saved in the database.
const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');

const LOGO_DIR = path.join(UPLOAD_ROOT, 'logos');
const PHOTO_DIR = path.join(UPLOAD_ROOT, 'profile-photos');

// Create them at require time. A volume mounts empty on its very first
// deploy, so without this the first logo upload would fail on a missing
// directory rather than just working.
fs.mkdirSync(LOGO_DIR, { recursive: true });
fs.mkdirSync(PHOTO_DIR, { recursive: true });

module.exports = { UPLOAD_ROOT, LOGO_DIR, PHOTO_DIR };
