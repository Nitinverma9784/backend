const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * @param {Buffer} buffer
 * @param {{ resource_type?: string; folder?: string; transformation?: object[] }} [opts]
 */
const uploadFromBuffer = (buffer, opts = {}) => {
  const { resource_type = 'auto', folder = 'whatsapp-crm', transformation } = opts;
  return new Promise((resolve, reject) => {
    const uploadOpts = { resource_type, folder };
    if (Array.isArray(transformation) && transformation.length) {
      uploadOpts.transformation = transformation;
    }
    const stream = cloudinary.uploader.upload_stream(uploadOpts, (error, result) => {
      if (error) return reject(error);
      resolve(result.secure_url);
    });
    stream.end(buffer);
  });
};

/** Outbound images — stored under a dedicated folder for CRM galleries and backups. */
const uploadImageBuffer = (buffer) =>
  uploadFromBuffer(buffer, {
    resource_type: 'image',
    folder: 'whatsapp-crm/images',
  });

/** PDFs and other non-image files (Cloudinary raw). */
const uploadDocumentBuffer = (buffer) =>
  uploadFromBuffer(buffer, {
    resource_type: 'raw',
    folder: 'whatsapp-crm/documents',
  });

const assertCloudinaryConfigured = () => {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    const err = new Error('Cloudinary is not configured (set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)');
    err.code = 'CLOUDINARY_CONFIG';
    throw err;
  }
};

module.exports = {
  uploadFromBuffer,
  uploadImageBuffer,
  uploadDocumentBuffer,
  assertCloudinaryConfigured,
};
