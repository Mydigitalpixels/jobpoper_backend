const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-m4a',
  'audio/x-wav',
  'audio/3gpp',
]);

sharp.concurrency(Math.max(1, Math.min(2, sharp.concurrency())));
sharp.cache({ files: 0, items: 64, memory: 64 });

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
  if (file.mimetype && ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, WEBP, HEIC, and HEIF image uploads are allowed'), false);
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
  const image = sharp(buffer, { failOn: 'warning' });
  await image.metadata();
  await image
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

async function saveVerificationFile(file, prefix, destDir) {
  let filename = generateFileName(prefix);

  try {
    await processAndSave(file.buffer, destDir, filename);
    return filename;
  } catch (error) {
    try {
      return saveOriginalFile(
        file.buffer,
        destDir,
        filename,
        file.originalname,
      );
    } catch (fallbackError) {
      console.warn(
        `Failed to save ${prefix} verification image:`,
        fallbackError.message,
      );
      throw error;
    }
  }
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

// Business profile images: up to 5 files under uploads/business-profiles
const uploadBusinessImages = [
  upload.array('images', 5),
  async (req, res, next) => {
    try {
      if (!req.files || !req.files.length) {
        req.processedFileNames = [];
        return next();
      }
      const destDir = path.join(__dirname, '..', 'uploads', 'business-profiles');
      const saved = [];
      for (const file of req.files) {
        const filename = generateFileName('business');
        try {
          await processAndSave(file.buffer, destDir, filename);
        } catch (err) {
          console.warn('Failed to process business image:', err.message);
          return res.status(400).json({
            status: 'error',
            message: 'One or more business images are invalid or unsupported',
          });
        }
        saved.push(filename);
      }
      req.processedFileNames = saved;
      if (req.files.length && !saved.length) {
        return res.status(400).json({ status: 'error', message: 'All images failed to process' });
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
        processed.selfie = await saveVerificationFile(
          files.selfie[0],
          'selfie',
          path.join(__dirname, '..', 'uploads', 'verification', 'selfies'),
        );
      }

      if (files.photoId?.[0]) {
        processed.photoId = await saveVerificationFile(
          files.photoId[0],
          'photo-id',
          path.join(__dirname, '..', 'uploads', 'verification', 'id-documents'),
        );
      }

      req.processedVerificationFiles = processed;
      return next();
    } catch (err) {
      return next(err);
    }
  }
];

// Combined job files: images (attachments) + audio (voiceNote) in one multipart request
const uploadJobFilesMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per file
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'attachments') {
      if (ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        const err = new Error('Only JPG, PNG, WEBP, HEIC, and HEIF image uploads are allowed for attachments');
        err.statusCode = 400;
        cb(err, false);
      }
    } else if (file.fieldname === 'voiceNote') {
      if (ALLOWED_AUDIO_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        const err = new Error('Only MP3, MP4, M4A, AAC, and WAV audio uploads are allowed for voice notes');
        err.statusCode = 400;
        cb(err, false);
      }
    } else {
      cb(null, false);
    }
  },
});

const uploadJobFiles = [
  uploadJobFilesMulter.fields([
    { name: 'attachments', maxCount: 5 },
    { name: 'voiceNote', maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const files = req.files || {};

      // --- Process image attachments ---
      const imageFiles = files['attachments'] || [];
      if (imageFiles.length) {
        const destDir = path.join(__dirname, '..', 'uploads', 'jobs');
        const saved = [];
        let errors = 0;
        for (const file of imageFiles) {
          let filename = generateFileName('job');
          let success = false;
          let fallbackPath = null;
          try {
            await processAndSave(file.buffer, destDir, filename);
            success = true;
          } catch (err) {
            try {
              filename = saveOriginalFile(file.buffer, destDir, filename, file.originalname);
              fallbackPath = path.join(destDir, filename);
              success = true;
            } catch (fallbackErr) {
              try { if (fallbackPath) fs.unlinkSync(fallbackPath); } catch (e) {}
              console.warn('Failed to save fallback attachment:', fallbackErr.message);
              errors++;
            }
          }
          if (success) saved.push(filename);
        }
        req.processedFileNames = saved;
        if (imageFiles.length && !saved.length) {
          return res.status(400).json({ status: 'error', message: 'All attachments failed to process' });
        }
      } else {
        req.processedFileNames = [];
      }

      // --- Process voice note ---
      const audioFiles = files['voiceNote'] || [];
      if (audioFiles.length) {
        const audioFile = audioFiles[0];
        const audioDestDir = path.join(__dirname, '..', 'uploads', 'jobs', 'audio');
        ensureDir(audioDestDir);
        const originalExt = path.extname(audioFile.originalname || '').toLowerCase() || '.m4a';
        const audioFilename = `voice-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${originalExt}`;
        const audioFullPath = path.join(audioDestDir, audioFilename);
        try {
          fs.writeFileSync(audioFullPath, audioFile.buffer);
          req.processedAudioFileName = audioFilename;
        } catch (err) {
          console.warn('Failed to save voice note:', err.message);
          req.processedAudioFileName = null;
        }
      } else {
        req.processedAudioFileName = null;
      }

      return next();
    } catch (err) {
      req.processedFileNames = [];
      req.processedAudioFileName = null;
      return next(err);
    }
  },
];

// Work images for professional profile: up to 10 files under uploads/work-images
const uploadWorkImages = [
  upload.array('workImages', 10),
  async (req, res, next) => {
    try {
      if (!req.files || !req.files.length) {
        req.processedFileNames = [];
        return next();
      }
      const destDir = path.join(__dirname, '..', 'uploads', 'work-images');
      const saved = [];
      for (const file of req.files) {
        let filename = generateFileName('work');
        let success = false;
        let fallbackPath = null;
        try {
          await processAndSave(file.buffer, destDir, filename);
          success = true;
        } catch (err) {
          try {
            filename = saveOriginalFile(file.buffer, destDir, filename, file.originalname);
            fallbackPath = path.join(destDir, filename);
            success = true;
          } catch (fallbackErr) {
            try { if (fallbackPath) fs.unlinkSync(fallbackPath); } catch (e) {}
            console.warn('Failed to save work image:', fallbackErr.message);
          }
        }
        if (success) saved.push(filename);
      }
      req.processedFileNames = saved;
      if (req.files.length && !saved.length) {
        return res.status(400).json({ status: 'error', message: 'All work images failed to process' });
      }
      return next();
    } catch (err) {
      req.processedFileNames = [];
      return next(err);
    }
  }
];

// Report images: up to 5 files under uploads/reports
const uploadReportImages = [
  upload.array('images', 5),
  async (req, res, next) => {
    try {
      if (!req.files || !req.files.length) {
        req.processedFileNames = [];
        return next();
      }
      const destDir = path.join(__dirname, '..', 'uploads', 'reports');
      const saved = [];
      for (const file of req.files) {
        let filename = generateFileName('report');
        let success = false;
        let fallbackPath = null;
        try {
          await processAndSave(file.buffer, destDir, filename);
          success = true;
        } catch (err) {
          try {
            filename = saveOriginalFile(file.buffer, destDir, filename, file.originalname);
            fallbackPath = path.join(destDir, filename);
            success = true;
          } catch (fallbackErr) {
            try { if (fallbackPath) fs.unlinkSync(fallbackPath); } catch (e) {}
            console.warn('Failed to save report image:', fallbackErr.message);
          }
        }
        if (success) saved.push(filename);
      }
      req.processedFileNames = saved;
      return next();
    } catch (err) {
      req.processedFileNames = [];
      return next(err);
    }
  }
];

module.exports = {
  uploadProfileImage,
  uploadJobImages,
  uploadJobFiles,
  uploadVerificationDocuments,
  uploadBusinessImages,
  uploadWorkImages,
  uploadReportImages
};
