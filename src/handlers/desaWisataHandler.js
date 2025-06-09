const { nanoid } = require("nanoid");
const pool = require("../config/db");
const { desaWisataSchema } = require("../handlers/schema");
const slugify = require("../utils/slugify");

// Menambahkan desa wisata
const addDesaWisata = async (req, res) => {
  const { provinsi, kabupaten, nama_desa, nama_popular, alamat, pengelola, nomor_telepon, email } = req.body;

  const kd_desa = `DESA-${nanoid(10)}`;

  const { error } = desaWisataSchema.validate({
    provinsi,
    kabupaten,
    nama_desa,
    nama_popular,
    alamat,
    pengelola,
    nomor_telepon,
    email,
  });

  if (error) {
    return res.status(400).json({
      status: "fail",
      message: error.details[0].message,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Cek apakah email terdaftar
    const checkUser = await client.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (checkUser.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: "fail",
        message: "Email tidak terdaftar",
      });
    }

    // Cek kode desa unik
    const checkDesa = await client.query("SELECT 1 FROM desa_wisata WHERE kd_desa = $1", [kd_desa]);
    if (checkDesa.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        status: "fail",
        message: "Kode desa wisata sudah digunakan",
      });
    }

    const baseSlug = slugify(nama_popular);
    let slug = baseSlug;
    let i = 1;
    while (true) {
      const checkSlug = await client.query("SELECT 1 FROM desa_wisata WHERE slug = $1", [slug]);
      if (checkSlug.rows.length === 0) break;
      slug = `${baseSlug}-${i}`;
      i++;
    }

    // Simpan ke tabel desa_wisata (tambahkan kolom slug!)
    const insertDesaQuery = `
      INSERT INTO desa_wisata (
        kd_desa, provinsi, kabupaten, nama_desa, nama_popular,
        alamat, pengelola, nomor_telepon, email, slug
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;
    await client.query(insertDesaQuery, [kd_desa, provinsi, kabupaten, nama_desa, nama_popular, alamat, pengelola, nomor_telepon, email, slug]);

    // Tambahkan ke tabel permintaan
    const kd_permintaan = `REQ-${nanoid(10)}`;
    await client.query(
      `
      INSERT INTO permintaan (kd_permintaan, email, kd_desa, status_permintaan)
      VALUES ($1, $2, $3, $4)
    `,
      [kd_permintaan, email, kd_desa, "diterima"]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      status: "success",
      message: "Desa wisata berhasil ditambahkan",
      data: {
        kd_desa,
        slug,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error adding desa wisata:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    client.release();
  }
};

// Mendapatkan semua desa wisata beserta status permintaan
const getAllDesaWisata = async (req, res) => {
  try {
    const query = `
      SELECT dw.*, p.kd_permintaan, p.status_permintaan, u.is_verified
      FROM desa_wisata dw
      LEFT JOIN permintaan p ON dw.kd_desa = p.kd_desa
      LEFT JOIN users u ON dw.email = u.email
      ORDER BY dw.kd_desa ASC
    `;
    const result = await pool.query(query);
    return res.status(200).json({
      status: "success",
      data: result.rows,
    });
  } catch (err) {
    console.error("Error fetching desa wisata:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

// Mendapatkan desa wisata berdasarkan kd_desa
const getDesaWisataById = async (req, res) => {
  const { kd_desa } = req.params;
  try {
    const query = "SELECT * FROM desa_wisata WHERE kd_desa = $1";
    const result = await pool.query(query, [kd_desa]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "fail",
        message: "Desa wisata tidak ditemukan",
      });
    }
    return res.status(200).json({
      status: "success",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("Error fetching desa wisata by ID:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

// Update desa wisata
const updateDesaWisata = async (req, res) => {
  const { kd_desa } = req.params;
  const { provinsi, kabupaten, nama_desa, nama_popular, alamat, pengelola, nomor_telepon, email } = req.body;

  // Validasi input menggunakan Joi
  const { error } = desaWisataSchema.validate({
    provinsi,
    kabupaten,
    nama_desa,
    nama_popular,
    alamat,
    pengelola,
    nomor_telepon,
    email,
  });

  if (error) {
    return res.status(400).json({
      status: "fail",
      message: error.details[0].message,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Pastikan desa wisata ada
    const checkQuery = "SELECT slug FROM desa_wisata WHERE kd_desa = $1";
    const checkResult = await client.query(checkQuery, [kd_desa]);
    if (checkResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Desa wisata tidak ditemukan",
      });
    }

    const oldSlug = checkResult.rows[0].slug;

    // Buat slug baru dari nama_desa
    const baseSlug = slugify(nama_popular);
    let slug = baseSlug;
    let i = 1;

    // Pastikan slug tidak tabrakan dengan desa lain (selain desa ini)
    while (true) {
      const slugCheck = await client.query("SELECT 1 FROM desa_wisata WHERE slug = $1 AND kd_desa != $2", [slug, kd_desa]);
      if (slugCheck.rows.length === 0) break;
      slug = `${baseSlug}-${i}`;
      i++;
    }

    const updateQuery = `
      UPDATE desa_wisata
      SET provinsi = $1, kabupaten = $2, nama_desa = $3, nama_popular = $4,
          alamat = $5, pengelola = $6, nomor_telepon = $7, email = $8, slug = $9
      WHERE kd_desa = $10
    `;

    await client.query(updateQuery, [provinsi, kabupaten, nama_desa, nama_popular, alamat, pengelola, nomor_telepon, email, slug, kd_desa]);

    await client.query("COMMIT");
    return res.status(200).json({
      status: "success",
      message: "Desa wisata berhasil diperbarui",
      data: {
        kd_desa,
        slug,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating desa wisata:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    client.release();
  }
};

// Hapus desa wisata
const deleteDesaWisata = async (req, res) => {
  const { kd_desa } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Cek apakah desa wisata ada
    const checkQuery = "SELECT 1 FROM desa_wisata WHERE kd_desa = $1";
    const checkResult = await client.query(checkQuery, [kd_desa]);
    if (checkResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "fail",
        message: "Desa wisata tidak ditemukan",
      });
    }

    // Hapus data dari tabel permintaan
    const deletePermintaanQuery = "DELETE FROM permintaan WHERE kd_desa = $1";
    await client.query(deletePermintaanQuery, [kd_desa]);

    // Hapus data dari tabel desa_wisata
    const deleteDesaQuery = "DELETE FROM desa_wisata WHERE kd_desa = $1";
    await client.query(deleteDesaQuery, [kd_desa]);

    await client.query("COMMIT");
    return res.status(200).json({
      status: "success",
      message: "Desa wisata berhasil dihapus",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error deleting desa wisata:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  } finally {
    client.release();
  }
};

// Mendapatkan desa wisata berdasarkan email user
const getDesaByUserEmail = async (req, res) => {
  const { email } = req.params;
  if (!email) {
    return res.status(400).json({
      status: "fail",
      message: "Query parameter 'email' tidak ditemukan",
    });
  }
  try {
    const query = "SELECT kd_desa, nama_desa FROM desa_wisata WHERE email = $1";
    const result = await pool.query(query, [email]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "fail",
        message: "Pengguna belum memiliki desa wisata.",
      });
    }
    return res.status(200).json({
      status: "success",
      data: result.rows,
    });
  } catch (err) {
    console.error("Error fetching desa_wisata by email:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

const getAllDesaWisataWithDetails = async (req, res) => {
  try {
    const byJenis = req.query.byJenis === "true";

    let query = `
      SELECT 
        d.kd_desa,
        COALESCE(dd.gambar_cover, '') AS gambar_cover,
        COALESCE(d.provinsi, '') AS provinsi,
        COALESCE(d.kabupaten, '') AS kabupaten, 
        COALESCE(d.nama_popular, '') AS nama_popular,
        d.slug,
        dd.jenis_desa
      FROM desa_wisata d
      LEFT JOIN deskripsi_desa dd ON d.kd_desa = dd.kd_desa
      WHERE dd.gambar_cover IS NOT NULL
    `;

    if (byJenis) {
      query += `
          AND ARRAY_LENGTH(dd.jenis_desa, 1) > 0
      `;
    }

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

const getDesaWisataBySlug = async (req, res) => {
  const { slug } = req.params;
  if (!slug) {
    return res.status(400).json({
      status: "fail",
      message: "Query parameter 'slug' tidak ditemukan",
    });
  }
  try {
    const query = "SELECT kd_desa, nama_desa FROM desa_wisata WHERE slug = $1";
    const result = await pool.query(query, [slug]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "fail",
        message: "Pengguna belum memiliki desa wisata.",
      });
    }
    return res.status(200).json({
      status: "success",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("Error fetching desa_wisata by slug:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

module.exports = {
  addDesaWisata,
  getAllDesaWisata,
  getDesaWisataById,
  updateDesaWisata,
  deleteDesaWisata,
  getDesaByUserEmail,
  getAllDesaWisataWithDetails,
  getDesaWisataBySlug,
};
