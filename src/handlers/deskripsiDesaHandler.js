const pool = require("../config/db");
const { Storage } = require("@google-cloud/storage");
const multer = require("multer");
const Joi = require("joi");
require("dotenv").config();

// Setup GCP Storage
const storage = new Storage({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});
const bucket = storage.bucket(process.env.BUCKET_NAME);

// Validation Schema
const deskripsiDesaSchema = Joi.object({
  kd_desa: Joi.string().required().messages({
    "any.required": "Kode desa wajib diisi",
  }),
  jenis_desa: Joi.array().items(Joi.string().valid("alam", "budaya", "buatan")).min(1).required(),
  lokasi_desa: Joi.string().allow("", null),
  deskripsi_desa: Joi.string().allow("", null),
  fasilitas_desa: Joi.array().items(Joi.string()).default([]),
  url_video: Joi.array().items(Joi.string().uri()).default([]),
  // TAMBAHAN BARU untuk koordinat
  latitude: Joi.number().min(-90).max(90).allow(null).messages({
    "number.min": "Latitude harus antara -90 dan 90",
    "number.max": "Latitude harus antara -90 dan 90",
  }),
  longitude: Joi.number().min(-180).max(180).allow(null).messages({
    "number.min": "Longitude harus antara -180 dan 180",
    "number.max": "Longitude harus antara -180 dan 180",
  }),
});

// File validation
const fileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) {
    return cb(new Error("Hanya file gambar yang diperbolehkan!"), false);
  }
  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
  if (!allowedTypes.includes(file.mimetype)) {
    return cb(new Error("Format yang diperbolehkan: JPG, PNG, WebP"), false);
  }
  cb(null, true);
};

// Multer setup
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file
    files: 10, // maksimal 10 files
  },
  fileFilter: fileFilter,
});

// Upload middleware configuration
const uploadFields = upload.fields([
  { name: "gambar_cover", maxCount: 1 },
  { name: "galeri_desa", maxCount: 8 },
]);

// Error handling middleware
const handleUploadErrors = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        status: "fail",
        message: "Ukuran file terlalu besar. Maksimal 5MB per file.",
      });
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({
        status: "fail",
        message: "Terlalu banyak file. Maksimal 8 gambar untuk galeri.",
      });
    }
    return res.status(400).json({
      status: "fail",
      message: `Upload error: ${err.message}`,
    });
  } else if (err) {
    return res.status(400).json({
      status: "fail",
      message: err.message,
    });
  }
  next();
};

// Fungsi upload gambar ke GCS
const uploadImageToGCS = async (file) => {
  try {
    const timestamp = Date.now();
    const fileName = `desa/${timestamp}-${file.originalname.replace(/\s+/g, "-")}`;
    const blob = bucket.file(fileName);

    const blobStream = blob.createWriteStream({
      resumable: false,
      public: true,
      metadata: {
        contentType: file.mimetype,
        cacheControl: "public, max-age=31536000",
      },
    });

    return new Promise((resolve, reject) => {
      blobStream.on("error", (err) => {
        console.error("Upload error:", err.message);
        reject(new Error("Upload gambar gagal"));
      });

      blobStream.on("finish", () => {
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        console.log("File berhasil diupload:", publicUrl);
        resolve(publicUrl);
      });

      blobStream.end(file.buffer);
    });
  } catch (error) {
    console.error("Error in uploadImageToGCS:", error.message);
    throw error;
  }
};

// Fungsi hapus gambar dari GCS
const deleteImageFromGCS = async (publicUrl) => {
  if (!publicUrl || typeof publicUrl !== "string") return;

  try {
    // Extract filename from URL
    const urlParts = publicUrl.split("/");
    const fileName = urlParts[urlParts.length - 1];
    const filePath = `desa/${fileName}`;

    await bucket.file(filePath).delete();
    console.log(`File deleted from GCS: ${filePath}`);
  } catch (error) {
    console.error(`Gagal menghapus file dari GCS: ${publicUrl}`, error.message);
    // Don't throw error, just log it
  }
};

// Fungsi hapus multiple gambar dari GCS
const deleteMultipleImagesFromGCS = async (imageUrls) => {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return;

  console.log(`Deleting ${imageUrls.length} images from GCS...`);

  const deletePromises = imageUrls.map(async (url) => {
    try {
      await deleteImageFromGCS(url);
      return { url, success: true };
    } catch (error) {
      console.error(`Failed to delete ${url}:`, error.message);
      return { url, success: false, error: error.message };
    }
  });

  const results = await Promise.allSettled(deletePromises);

  const successful = results.filter((result) => result.status === "fulfilled" && result.value.success).length;

  const failed = results.length - successful;

  console.log(`Successfully deleted: ${successful}/${imageUrls.length} images`);
  if (failed > 0) {
    console.log(`Failed to delete: ${failed} images`);
  }
};

// Helper function untuk upload multiple files
const uploadMultipleFiles = async (files) => {
  if (!files || files.length === 0) return [];

  try {
    const uploadPromises = files.map((file) => uploadImageToGCS(file));
    return await Promise.all(uploadPromises);
  } catch (error) {
    console.error("Error uploading multiple files:", error.message);
    throw error;
  }
};

// CREATE - Tambah deskripsi desa
const addDeskripsiDesa = async (req, res) => {
  let client;
  let uploadedUrls = [];
  try {
    // 💡 DEBUG: Lihat semua input dari request
    console.log("🔹 Raw Request Body:", req.body);
    console.log("🔹 Files Uploaded:", req.files);
    client = await pool.connect();

    // Parse and validate data
    let data;
    try {
      data = typeof req.body.data === "string" ? JSON.parse(req.body.data) : req.body;

      // 💡 DEBUG: Hasil parsing JSON
      console.log("🔹 Parsed Data:", data);
    } catch (err) {
      return res.status(400).json({
        status: "fail",
        message: "Format data tidak valid",
      });
    }

    const { error, value } = deskripsiDesaSchema.validate(data);
    if (error) {
      console.error("Joi Validation Error:", error.details[0].message);
      return res.status(400).json({
        status: "fail",
        message: error.details[0].message,
      });
    }

    const {
      kd_desa,
      jenis_desa,
      lokasi_desa,
      deskripsi_desa,
      fasilitas_desa,
      url_video,
      latitude, // TAMBAHAN BARU
      longitude, // TAMBAHAN BARU
    } = value;

    console.log("🔍 Mencari kode desa di database:", kd_desa);

    // Check if kd_desa exists in desa_wisata
    const checkDesa = await client.query("SELECT TRIM(kd_desa) AS kd_desa FROM desa_wisata WHERE TRIM(kd_desa) ILIKE $1", [kd_desa.trim()]);

    console.log("📊 Hasil Query Database:", checkDesa.rows);

    if (checkDesa.rows.length === 0) {
      return res.status(400).json({
        status: "fail",
        message: "Kode desa tidak ditemukan dalam tabel desa_wisata. Pastikan kode desa benar.",
      });
    }

    // Cek apakah deskripsi sudah ada
    const checkExisting = await client.query("SELECT kd_desa FROM deskripsi_desa WHERE kd_desa = $1", [kd_desa]);
    if (checkExisting.rows.length > 0) {
      return res.status(400).json({
        status: "fail",
        message: "Deskripsi desa sudah ada. Gunakan endpoint update.",
      });
    }

    // Upload files
    let gambar_cover = null;
    let galeri_desa = [];
    if (req.files) {
      if (req.files.gambar_cover && req.files.gambar_cover[0]) {
        gambar_cover = await uploadImageToGCS(req.files.gambar_cover[0]);
        uploadedUrls.push(gambar_cover);
      }
      if (req.files.galeri_desa && req.files.galeri_desa.length > 0) {
        galeri_desa = await uploadMultipleFiles(req.files.galeri_desa);
        uploadedUrls.push(...galeri_desa);
      }
    }

    // Insert to database - UPDATED QUERY
    const insertQuery = `
            INSERT INTO deskripsi_desa (
                kd_desa, jenis_desa, gambar_cover, lokasi_desa, deskripsi_desa, 
                fasilitas_desa, url_video, galeri_desa, latitude, longitude,
                created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
            RETURNING *
        `;
    const result = await client.query(insertQuery, [kd_desa, jenis_desa, gambar_cover, lokasi_desa, deskripsi_desa, fasilitas_desa, url_video, galeri_desa, latitude, longitude]);

    return res.status(201).json({
      status: "success",
      message: "Deskripsi desa berhasil ditambahkan",
      data: result.rows[0],
    });
  } catch (err) {
    if (uploadedUrls.length > 0) {
      await deleteMultipleImagesFromGCS(uploadedUrls);
    }

    // 💡 DEBUG: Log error detail
    console.error("🚨 Error adding deskripsi desa:", err.message);
    console.error("Full error object:", err);

    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    if (client) client.release();
  }
};

//Get deskripsi desa by kd_desa
const getDeskripsiDesaByKdDesa = async (req, res) => {
  const { kd_desa } = req.params;
  let client;

  try {
    client = await pool.connect();

    const withDesa = req.query.with_desa === "true";
    let query = "SELECT * FROM deskripsi_desa WHERE kd_desa = $1";

    if (withDesa) {
      query = `
        SELECT dd.*, dw.nama_desa 
        FROM deskripsi_desa dd
        JOIN desa_wisata dw ON dd.kd_desa = dw.kd_desa
        WHERE dd.kd_desa = $1
      `;
    }

    const result = await client.query(query, [kd_desa]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "fail",
        message: "Deskripsi desa tidak ditemukan",
      });
    }

    return res.status(200).json({
      status: "success",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("Error fetching deskripsi desa by kd_desa:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    if (client) client.release();
  }
};

const getAllAtraksiWisata = async (req, res) => {
  try {
    const query = `
      SELECT 
        d.kd_desa,
        COALESCE(dd.gambar_cover, '') AS gambar_cover,
        COALESCE(d.kabupaten, '') AS kabupaten, 
        COALESCE(d.nama_popular, '') AS nama_popular,
        d.slug,
        dd.jenis_desa
      FROM desa_wisata d
      LEFT JOIN deskripsi_desa dd ON d.kd_desa = dd.kd_desa
      WHERE dd.atraksi IS NOT NULL
        AND dd.jenis_desa IS NOT NULL
        AND ARRAY_LENGTH(dd.jenis_desa) > 0
    `;

    const result = await pool.query(query);

    return res.status(200).json({
      status: "success",
      data: result.rows,
    });
  } catch (err) {
    console.error("Error fetching desa wisata details:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

// UPDATE - Update deskripsi desa
const updateDeskripsiDesa = async (req, res) => {
  const { kd_desa } = req.params;
  let client;
  let uploadedUrls = [];

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Get existing data
    const existingData = await client.query("SELECT * FROM deskripsi_desa WHERE kd_desa = $1", [kd_desa]);

    if (existingData.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Deskripsi desa tidak ditemukan",
      });
    }

    const currentData = existingData.rows[0];

    // Parse and validate new data
    let data;
    try {
      data = typeof req.body.data === "string" ? JSON.parse(req.body.data) : req.body;
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "Format data tidak valid",
      });
    }

    // Extended schema untuk update - DENGAN KOORDINAT DAN JENIS_DESA
    const updateSchema = Joi.object({
      jenis_desa: Joi.array().items(Joi.string().valid("alam", "budaya", "buatan")).min(1).optional(),
      lokasi_desa: Joi.string().allow("", null),
      deskripsi_desa: Joi.string().allow("", null),
      fasilitas_desa: Joi.array().items(Joi.string()).default([]),
      url_video: Joi.array().items(Joi.string().uri()).default([]),
      remove_cover: Joi.boolean().default(false),
      keep_gallery_images: Joi.array().items(Joi.string().uri()).default([]),
      // TAMBAHAN BARU untuk koordinat
      latitude: Joi.number().min(-90).max(90).allow(null).messages({
        "number.min": "Latitude harus antara -90 dan 90",
        "number.max": "Latitude harus antara -90 dan 90",
      }),
      longitude: Joi.number().min(-180).max(180).allow(null).messages({
        "number.min": "Longitude harus antara -180 dan 180",
        "number.max": "Longitude harus antara -180 dan 180",
      }),
    });

    const { error, value } = updateSchema.validate(data);
    if (error) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: error.details[0].message,
      });
    }

    const {
      jenis_desa,
      lokasi_desa,
      deskripsi_desa,
      fasilitas_desa,
      url_video,
      remove_cover,
      keep_gallery_images,
      latitude, // TAMBAHAN BARU
      longitude, // TAMBAHAN BARU
    } = value;

    // Handle cover image
    let gambar_cover = currentData.gambar_cover;
    if (remove_cover || req.files?.gambar_cover?.[0]) {
      if (currentData.gambar_cover) await deleteImageFromGCS(currentData.gambar_cover);
      if (remove_cover) {
        gambar_cover = null;
      } else {
        gambar_cover = await uploadImageToGCS(req.files.gambar_cover[0]);
        uploadedUrls.push(gambar_cover);
      }
    }

    // Handle gallery images
    const currentGallery = currentData.galeri_desa || [];
    const imagesToKeep = keep_gallery_images.filter((url) => currentGallery.includes(url));
    const imagesToDelete = currentGallery.filter((url) => !imagesToKeep.includes(url));
    if (imagesToDelete.length > 0) await deleteMultipleImagesFromGCS(imagesToDelete);

    let galeri_desa = [...imagesToKeep];
    if (req.files?.galeri_desa?.length > 0) {
      const newGalleryImages = await uploadMultipleFiles(req.files.galeri_desa);
      galeri_desa.push(...newGalleryImages);
      uploadedUrls.push(...newGalleryImages);
    }

    // UPDATE QUERY - DENGAN KOORDINAT DAN JENIS_DESA
    const updateQuery = `
        UPDATE deskripsi_desa SET
          jenis_desa = COALESCE($1, jenis_desa),
          gambar_cover = $2,
          lokasi_desa = $3,
          deskripsi_desa = $4,
          fasilitas_desa = $5,
          url_video = $6,
          galeri_desa = $7,
          latitude = $8,
          longitude = $9,
          updated_at = NOW()
        WHERE kd_desa = $10
        RETURNING *
      `;

    const result = await client.query(updateQuery, [
      jenis_desa,
      gambar_cover,
      lokasi_desa,
      deskripsi_desa,
      fasilitas_desa,
      url_video,
      galeri_desa,
      latitude, // TAMBAHAN BARU
      longitude, // TAMBAHAN BARU
      kd_desa,
    ]);

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: "Deskripsi desa berhasil diperbarui",
      data: result.rows[0],
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(console.error);
    if (uploadedUrls.length > 0) await deleteMultipleImagesFromGCS(uploadedUrls);

    console.error("Error updating deskripsi desa:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    if (client) client.release();
  }
};

// DELETE - Delete deskripsi desa
const deleteDeskripsiDesa = async (req, res) => {
  const { kd_desa } = req.params;
  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Get existing data to delete images
    const result = await client.query("SELECT * FROM deskripsi_desa WHERE kd_desa = $1", [kd_desa]);

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Deskripsi desa tidak ditemukan",
      });
    }

    const existingData = result.rows[0];

    // Delete all images from GCS
    const imagesToDelete = [];

    if (existingData.gambar_cover) {
      imagesToDelete.push(existingData.gambar_cover);
    }

    if (existingData.galeri_desa && Array.isArray(existingData.galeri_desa)) {
      imagesToDelete.push(...existingData.galeri_desa);
    }

    if (imagesToDelete.length > 0) {
      await deleteMultipleImagesFromGCS(imagesToDelete);
    }

    // Delete from database
    await client.query("DELETE FROM deskripsi_desa WHERE kd_desa = $1", [kd_desa]);
    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: "Deskripsi desa dan semua gambarnya berhasil dihapus",
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(console.error);
    console.error("Error deleting deskripsi desa:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  addDeskripsiDesa,
  getDeskripsiDesaByKdDesa,
  updateDeskripsiDesa,
  deleteDeskripsiDesa,
  uploadFields,
  handleUploadErrors,
};
