const pool = require("../config/db");
const { deskripsiWisataSchema } = require("../handlers/schema");
const { Storage } = require("@google-cloud/storage");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

// Setup GCP Storage
const storage = new Storage({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});
const bucket = storage.bucket(process.env.BUCKET_NAME);

// File size and type validation for Multer
const fileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) {
    return cb(new Error("Hanya file gambar yang diperbolehkan!"), false);
  }
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.mimetype)) {
    return cb(new Error("Hanya format JPG, PNG, dan WebP yang diperbolehkan!"), false);
  }
  cb(null, true);
};

// Multer setup with validation
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // Limit file size to 20MB
  },
  fileFilter: fileFilter,
});

// Error handling middleware for file uploads
const handleUploadErrors = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        status: "fail",
        message: "Ukuran file terlalu besar. Maksimal 5MB.",
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
    const fileName = `wisata/${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;
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
        const publicUrl = `${process.env.BUCKET_URL}/${bucket.name}/${blob.name}`;
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
    const urlParts = new URL(publicUrl);
    const pathParts = urlParts.pathname.split("/");
    const fileName = pathParts.slice(2).join("/");

    await bucket.file(fileName).delete();
    console.log(`File dihapus dari GCS: ${fileName}`);
  } catch (error) {
    console.error(`Gagal menghapus file dari GCS:`, error.message);
  }
};

// Helper function to handle arrays of entities with their images
const processEntityWithImages = async (entities = [], files = [], existingEntities = []) => {
  const results = [];

  for (let i = 0; i < entities.length; i++) {
    const entity = { ...entities[i] };
    const startIdx = i * 5;
    const endIdx = startIdx + 5;
    const entityFiles = files.slice(startIdx, endIdx).filter((file) => file);

    try {
      // Hapus gambar lama jika ada
      if (Array.isArray(entity.gambar)) {
        for (const oldUrl of entity.gambar) {
          await deleteImageFromGCS(oldUrl);
        }
      } else if (typeof entity.gambar === "string") {
        await deleteImageFromGCS(entity.gambar);
      }

      // Upload file baru
      if (entityFiles.length > 0) {
        const imageUrls = await Promise.all(entityFiles.map((file) => uploadImageToGCS(file)));
        entity.gambar = imageUrls;
      } else if (!entity.gambar && existingEntities?.[i]?.gambar) {
        // Gunakan gambar lama
        entity.gambar = existingEntities[i].gambar;
      }
    } catch (error) {
      console.error(`Error processing images for entity ${i}:`, error.message);
    }

    entity.updated_at = new Date().toISOString();
    if (!entity.created_at) {
      entity.created_at = new Date().toISOString();
    }

    results.push(entity);
  }

  return results;
};

// Tambah deskripsi wisata
const addDeskripsiWisata = async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    if (!req.body || !req.body.data) {
      return res.status(400).json({
        status: "fail",
        message: "Data tidak ditemukan dalam request",
      });
    }

    let data;
    try {
      data = typeof req.body.data === "string" ? JSON.parse(req.body.data) : req.body.data;
    } catch (err) {
      return res.status(400).json({
        status: "fail",
        message: "Format data tidak valid",
      });
    }

    const { kd_desa, atraksi = [], penginapan = [], paket_wisata = [], suvenir = [] } = data;

    const { error } = deskripsiWisataSchema.validate({
      atraksi,
      penginapan,
      paket_wisata,
      suvenir,
    });
    if (error) {
      return res.status(400).json({
        status: "fail",
        message: error.details[0].message,
      });
    }

    const files = {
      atraksi: req.files?.atraksi || [],
      penginapan: req.files?.penginapan || [],
      paket_wisata: req.files?.paket_wisata || [],
      suvenir: req.files?.suvenir || [],
    };

    const atraksiWithImages = await processEntityWithImages(atraksi, files.atraksi);
    const penginapanWithImages = await processEntityWithImages(penginapan, files.penginapan);
    const paketWisataWithImages = await processEntityWithImages(paket_wisata, files.paket_wisata);
    const suvenirWithImages = await processEntityWithImages(suvenir, files.suvenir);

    const insertQuery = `
      INSERT INTO deskripsi_wisata (
        kd_desa, atraksi, penginapan, paket_wisata, suvenir, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING kd_desa
    `;

    const result = await client.query(insertQuery, [kd_desa, JSON.stringify(atraksiWithImages), JSON.stringify(penginapanWithImages), JSON.stringify(paketWisataWithImages), JSON.stringify(suvenirWithImages)]);

    return res.status(201).json({
      status: "success",
      message: "Deskripsi wisata berhasil ditambahkan",
      data: {
        kd_desa: result.rows[0].kd_desa,
      },
    });
  } catch (err) {
    if (err.code === "23505") {
      // PostgreSQL error code untuk duplicate key
      return res.status(400).json({
        status: "fail",
        message: "Deskripsi wisata untuk desa ini sudah ada. Gunakan endpoint /update",
      });
    }
    console.error("Error adding deskripsi wisata:", err.message);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  } finally {
    if (client) client.release();
  }
};

// Ambil semua deskripsi wisata
const getAllDeskripsiWisata = async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const withDesa = req.query.with_desa === "true";
    let query = "SELECT * FROM deskripsi_wisata";
    if (withDesa) {
      query = `
        SELECT dw.*, d.nama_desa, d.lokasi, d.deskripsi_singkat
        FROM deskripsi_wisata dw
        JOIN desa_wisata d ON dw.kd_desa = d.kd_desa
      `;
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
    const offset = (page - 1) * limit;

    const countResult = await client.query("SELECT COUNT(*) FROM deskripsi_wisata");
    const totalCount = parseInt(countResult.rows[0].count);

    const paginatedQuery = `${query} LIMIT $1 OFFSET $2`;
    const result = await client.query(paginatedQuery, [limit, offset]);

    return res.status(200).json({
      status: "success",
      data: result.rows,
      pagination: {
        page,
        limit,
        total: totalCount,
        pages: Math.ceil(totalCount / limit),
      },
    });
  } catch (err) {
    console.error("Error fetching all deskripsi wisata:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  } finally {
    if (client) client.release();
  }
};

// Ambil deskripsi wisata by kd_desa
const getDeskripsiWisataByKdDesa = async (req, res) => {
  const { kd_desa } = req.params;
  let client;

  try {
    client = await pool.connect();
    const withDesa = req.query.with_desa === "true";
    let query = "SELECT * FROM deskripsi_wisata WHERE kd_desa = $1";

    if (withDesa) {
      query = `
        SELECT *
        FROM deskripsi_wisata
        WHERE kd_desa = $1
      `;
    }

    const result = await client.query(query, [kd_desa]);
    if (result.rows.length === 0) {
      return res.status(404).json({ status: "fail", message: "Deskripsi wisata tidak ditemukan" });
    }

    return res.status(200).json({ status: "success", data: result.rows[0] });
  } catch (err) {
    console.error("Error fetching deskripsi wisata by kd_desa:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  } finally {
    if (client) client.release();
  }
};

const getRandomAtraksiWisata = async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const query = `
      SELECT dw.kd_desa, d.nama_popular, d.kabupaten, d.slug, dw.atraksi
      FROM deskripsi_wisata dw
      JOIN desa_wisata d ON dw.kd_desa = d.kd_desa
      WHERE 
        dw.atraksi IS NOT NULL AND 
        jsonb_typeof(dw.atraksi) = 'array' AND 
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(dw.atraksi) AS elem
          WHERE elem->>'gambar' IS NOT NULL AND TRIM(BOTH FROM (elem->>'gambar')) <> ''
        )
      ORDER BY RANDOM()
      LIMIT 10
    `;

    const result = await client.query(query);

    return res.status(200).json({
      status: "success",
      data: result.rows,
    });
  } catch (err) {
    console.error("Error fetching random atraksi wisata:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  } finally {
    if (client) client.release();
  }
};

// Update deskripsi wisata
const updateDeskripsiWisata = async (req, res) => {
  const { kd_desa } = req.params;
  let client;

  try {
    client = await pool.connect();

    if (!req.body || !req.body.data) {
      return res.status(400).json({
        status: "fail",
        message: "Data tidak ditemukan dalam request",
      });
    }

    let data;
    try {
      data = typeof req.body.data === "string" ? JSON.parse(req.body.data) : req.body.data;
    } catch (err) {
      return res.status(400).json({
        status: "fail",
        message: "Format data tidak valid",
      });
    }

    const { penjelasan_umum, fasilitas, dokumentasi_desa, atraksi = [], penginapan = [], paket_wisata = [], suvenir = [] } = data;

    const { error } = deskripsiWisataSchema.validate({
      atraksi,
      penginapan,
      paket_wisata,
      suvenir,
    });
    if (error) {
      return res.status(400).json({ status: "fail", message: error.details[0].message });
    }

    await client.query("BEGIN");

    const checkExisting = await client.query("SELECT * FROM deskripsi_wisata WHERE kd_desa = $1", [kd_desa]);

    if (checkExisting.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Deskripsi wisata tidak ditemukan",
      });
    }

    const existingData = checkExisting.rows[0];

    const files = {
      atraksi: req.files?.atraksi || [],
      penginapan: req.files?.penginapan || [],
      paket_wisata: req.files?.paket_wisata || [],
      suvenir: req.files?.suvenir || [],
    };

    const atraksiWithImages = await processEntityWithImages(atraksi, files.atraksi, existingData.atraksi);
    const penginapanWithImages = await processEntityWithImages(penginapan, files.penginapan, existingData.penginapan);
    const paketWisataWithImages = await processEntityWithImages(paket_wisata, files.paket_wisata, existingData.paket_wisata);
    const suvenirWithImages = await processEntityWithImages(suvenir, files.suvenir, existingData.suvenir);

    const updateQuery = `
      UPDATE deskripsi_wisata SET
        atraksi = $1,
        penginapan = $2,
        paket_wisata = $3,
        suvenir = $4,
        updated_at = NOW()
      WHERE kd_desa = $5
      RETURNING *
    `;

    const result = await client.query(updateQuery, [
      penjelasan_umum,
      fasilitas,
      dokumentasi_desa,
      JSON.stringify(atraksiWithImages),
      JSON.stringify(penginapanWithImages),
      JSON.stringify(paketWisataWithImages),
      JSON.stringify(suvenirWithImages),
      kd_desa,
    ]);

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: "Deskripsi wisata berhasil diperbarui",
      data: result.rows[0],
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(console.error);
    console.error("Error updating deskripsi wisata:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  } finally {
    if (client) client.release();
  }
};

// Hapus deskripsi wisata beserta gambarnya di GCS
const deleteDeskripsiWisata = async (req, res) => {
  const { kd_desa } = req.params;
  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Ambil data sebelum dihapus untuk hapus file dari GCS
    const result = await client.query("SELECT * FROM deskripsi_wisata WHERE kd_desa = $1", [kd_desa]);

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Deskripsi wisata tidak ditemukan",
      });
    }

    const existingData = result.rows[0];

    // Hapus semua gambar dari GCS
    const entitiesToDelete = [existingData.atraksi, existingData.penginapan, existingData.paket_wisata, existingData.suvenir];

    for (const entityGroup of entitiesToDelete) {
      if (entityGroup && Array.isArray(entityGroup)) {
        for (const entity of entityGroup) {
          if (Array.isArray(entity.gambar)) {
            for (const url of entity.gambar) {
              await deleteImageFromGCS(url);
            }
          } else if (typeof entity.gambar === "string") {
            await deleteImageFromGCS(entity.gambar);
          }
        }
      }
    }

    // Setelah hapus gambar, baru hapus dari DB
    await client.query("DELETE FROM deskripsi_wisata WHERE kd_desa = $1", [kd_desa]);
    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: "Deskripsi wisata dan semua gambarnya berhasil dihapus",
    });
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK").catch(console.error);
    }
    console.error("Error deleting deskripsi wisata:", err.message);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  } finally {
    if (client) {
      client.release();
    }
  }
};

const uploadGambar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: "fail",
        message: "Tidak ada file yang diupload",
      });
    }

    const publicUrl = await uploadImageToGCS(req.file);

    return res.status(200).json({
      status: "success",
      data: {
        url: publicUrl,
      },
    });
  } catch (error) {
    console.error("Error uploading image:", error);
    return res.status(500).json({
      status: "error",
      message: "Gagal mengupload gambar",
    });
  }
};

const patchDeskripsiWisata = async (req, res) => {
  const { kd_desa } = req.params;
  let client;

  try {
    client = await pool.connect();

    if (!req.body || !req.body.data) {
      return res.status(400).json({
        status: "fail",
        message: "Data tidak ditemukan dalam request",
      });
    }

    let data;
    try {
      data = typeof req.body.data === "string" ? JSON.parse(req.body.data) : req.body.data;
    } catch (err) {
      return res.status(400).json({
        status: "fail",
        message: "Format data tidak valid",
      });
    }

    const { atraksi = [], penginapan = [], paket_wisata = [], suvenir = [] } = data;

    await client.query("BEGIN");

    // Ambil data yang sudah ada
    const existingData = await client.query("SELECT * FROM deskripsi_wisata WHERE kd_desa = $1", [kd_desa]);

    if (existingData.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Deskripsi wisata tidak ditemukan",
      });
    }

    const currentData = existingData.rows[0];

    // Helper function untuk parse data
    const parseArrayData = (field) => {
      if (Array.isArray(field)) return field;
      return field ? JSON.parse(field) : [];
    };

    // Gabungkan data baru dengan yang sudah ada
    const updatedAtraksi = [...parseArrayData(currentData.atraksi), ...atraksi];

    const updatedPenginapan = [...parseArrayData(currentData.penginapan), ...penginapan];

    const updatedPaketWisata = [...parseArrayData(currentData.paket_wisata), ...paket_wisata];

    const updatedSuvenir = [...parseArrayData(currentData.suvenir), ...suvenir];

    // Update database
    const updateQuery = `
      UPDATE deskripsi_wisata SET
        atraksi = $1,
        penginapan = $2,
        paket_wisata = $3,
        suvenir = $4,
        updated_at = NOW()
      WHERE kd_desa = $5
      RETURNING *
    `;

    const result = await client.query(updateQuery, [JSON.stringify(updatedAtraksi), JSON.stringify(updatedPenginapan), JSON.stringify(updatedPaketWisata), JSON.stringify(updatedSuvenir), kd_desa]);

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: "Data berhasil ditambahkan",
      data: result.rows[0],
      added_counts: {
        atraksi: atraksi.length,
        penginapan: penginapan.length,
        paket_wisata: paket_wisata.length,
        suvenir: suvenir.length,
      },
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(console.error);
    console.error("Error patching deskripsi wisata:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    if (client) client.release();
  }
};

const patchRemoveItemDeskripsiWisata = async (req, res) => {
  const { kd_desa } = req.params;
  let client;

  try {
    client = await pool.connect();

    const { entity_type, item_id } = req.body;

    // Validasi input
    if (!entity_type || item_id === undefined) {
      return res.status(400).json({
        status: "fail",
        message: "entity_type dan item_id harus disediakan",
      });
    }

    // Pastikan item_id adalah number
    const itemId = Number(item_id);
    if (isNaN(itemId)) {
      return res.status(400).json({
        status: "fail",
        message: "item_id harus berupa angka",
      });
    }

    const validEntityTypes = ["atraksi", "penginapan", "paket_wisata", "suvenir"];
    if (!validEntityTypes.includes(entity_type)) {
      return res.status(400).json({
        status: "fail",
        message: "entity_type tidak valid",
      });
    }

    await client.query("BEGIN");

    // Ambil data yang sudah ada
    const existingData = await client.query("SELECT * FROM deskripsi_wisata WHERE kd_desa = $1", [kd_desa]);

    if (existingData.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Deskripsi wisata tidak ditemukan",
      });
    }

    const currentData = existingData.rows[0];

    // Parse data dengan error handling
    let currentArray;
    try {
      const rawData = currentData[entity_type];

      // Cek tipe data sebelum parsing
      if (typeof rawData === "string") {
        currentArray = JSON.parse(rawData);
      } else if (Array.isArray(rawData)) {
        currentArray = rawData;
      } else {
        currentArray = [];
      }
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "Format data tidak valid",
      });
    }

    // Cari item berdasarkan ID
    const itemIndex = currentArray.findIndex((item) => item.id === itemId);
    if (itemIndex === -1) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Item tidak ditemukan",
      });
    }

    // Hapus gambar dari GCS jika ada
    const itemToDelete = currentArray[itemIndex];
    if (itemToDelete.gambar) {
      try {
        if (Array.isArray(itemToDelete.gambar)) {
          for (const url of itemToDelete.gambar) {
            await deleteImageFromGCS(url);
          }
        } else {
          await deleteImageFromGCS(itemToDelete.gambar);
        }
      } catch (err) {
        console.error("Gagal menghapus gambar:", err);
        // Lanjutkan meskipun gagal hapus gambar
      }
    }

    // Hapus item dari array
    currentArray.splice(itemIndex, 1);

    // Update database
    const updateQuery = `
      UPDATE deskripsi_wisata SET
        ${entity_type} = $1,
        updated_at = NOW()
      WHERE kd_desa = $2
      RETURNING *
    `;

    const result = await client.query(updateQuery, [JSON.stringify(currentArray), kd_desa]);

    await client.query("COMMIT");

    return res.status(200).json({
      status: "success",
      message: "Item berhasil dihapus",
      data: result.rows[0],
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(console.error);
    console.error("Error removing item:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    if (client) client.release();
  }
};

// Export yang diperbarui
module.exports = {
  addDeskripsiWisata,
  getAllDeskripsiWisata,
  getDeskripsiWisataByKdDesa,
  updateDeskripsiWisata,
  deleteDeskripsiWisata,
  upload,
  handleUploadErrors,
  patchDeskripsiWisata,
  patchRemoveItemDeskripsiWisata,
  uploadGambar,
  uploadImageToGCS,
  deleteImageFromGCS,
  getRandomAtraksiWisata,
};
