const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Ensure directory exists
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function generateFileName(prefix = 'img') {
  const id = crypto.randomBytes(8).toString('hex');
  return `${prefix}-${Date.now()}-${id}.webp`;
}

const imageOnlyFilter = (req, file, cb) => {
  if (file.mimetype && file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image uploads are allowed'), false);
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per file
  fileFilter: imageOnlyFilter
});

const uploadWithoutFormatRestriction = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per file
});

async function processAndSave(buffer, destDir, filename) {
  ensureDir(destDir);
  const fullPath = path.join(destDir, filename);
  await sharp(buffer)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(fullPath);
  return filename;
}

function saveOriginalFile(buffer, destDir, generatedFileName, originalName) {
  const originalExtension =
    (path.extname(originalName || "").toLowerCase() || ".bin");
  const fallbackFileName = `${path.parse(generatedFileName).name}${originalExtension}`;
  const fullPath = path.join(destDir, fallbackFileName);
  ensureDir(destDir);
  fs.writeFileSync(fullPath, buffer);
  return fallbackFileName;
}

// Profile image: single file under uploads/profiles
const uploadProfileImage = [
  upload.single('profileImage'),
  async (req, res, next) => {
    try {
      if (!req.file) return next();
      const filename = generateFileName('profile');
      const destDir = path.join(__dirname, '..', 'uploads', 'profiles');
      await processAndSave(req.file.buffer, destDir, filename);
      req.processedFileName = filename;
      return next();
    } catch (err) {
      return next(err);
    }
  }
];

// Job images: up to 5 files under uploads/jobs
const uploadJobImages = [
  upload.array('attachments', 5),
  async (req, res, next) => {
    try {
      if (!req.files || !req.files.length) {
        req.processedFileNames = [];
        return next();
      }
      const destDir = path.join(__dirname, '..', 'uploads', 'jobs');
      const saved = [];
      let errors = 0;
      for (const file of req.files) {
        let filename = generateFileName('job');
        let success = false;
        let fallbackPath = null;
        try {
          await processAndSave(file.buffer, destDir, filename);
          success = true;
        } catch (err) {
          // Fallback: save original buffer without conversion (e.g., HEIC)
          try {
            filename = saveOriginalFile(
              file.buffer,
              destDir,
              filename,
              file.originalname,
            );
            fallbackPath = path.join(destDir, filename);
            success = true;
          } catch (fallbackErr) {
            // Remove partially written file if any error during fallback
            try { if (fallbackPath) fs.unlinkSync(fallbackPath); } catch (e) {}
            console.warn('Failed to save fallback attachment:', fallbackErr.message);
            errors++;
          }
        }
        if (success) saved.push(filename);
      }
      req.processedFileNames = saved;
      if (req.files.length && !saved.length) {
        // No good images
        return res.status(400).json({ status: 'error', message: 'All attachments failed to process' });
      }
      return next();
    } catch (err) {
      req.processedFileNames = [];
      return next(err);
    }
  }
];

// Verification documents: selfie + photo ID
const uploadVerificationDocuments = [
  uploadWithoutFormatRestriction.fields([
    { name: 'selfie', maxCount: 1 },
    { name: 'photoId', maxCount: 1 }
  ]),
  async (req, res, next) => {
    try {
      const files = req.files || {};
      const processed = {
        selfie: null,
        photoId: null
      };

      if (files.selfie?.[0]) {
        const selfieFile = files.selfie[0];
        let selfieFilename = generateFileName('selfie');
        const selfieDir = path.join(__dirname, '..', 'uploads', 'verification', 'selfies');
        try {
          await processAndSave(selfieFile.buffer, selfieDir, selfieFilename);
        } catch (error) {
          selfieFilename = saveOriginalFile(
            selfieFile.buffer,
            selfieDir,
            selfieFilename,
            selfieFile.originalname,
          );
        }
        processed.selfie = selfieFilename;
      }

      if (files.photoId?.[0]) {
        const idFile = files.photoId[0];
        let idFilename = generateFileName('photo-id');
        const idDir = path.join(__dirname, '..', 'uploads', 'verification', 'id-documents');
        try {
          await processAndSave(idFile.buffer, idDir, idFilename);
        } catch (error) {
          idFilename = saveOriginalFile(
            idFile.buffer,
            idDir,
            idFilename,
            idFile.originalname,
          );
        }
        processed.photoId = idFilename;
      }

      req.processedVerificationFiles = processed;
      return next();
    } catch (err) {
      return next(err);
    }
  }
];

module.exports = {
  uploadProfileImage,
  uploadJobImages,
  uploadVerificationDocuments
};
