const express = require("express");
const { addDeskripsiDesa, getDeskripsiDesaByKdDesa, updateDeskripsiDesa, deleteDeskripsiDesa, uploadFields, handleUploadErrors } = require("../handlers/deskripsiDesaHandler");
const { authenticateToken, checkRole } = require("../middleware/authMiddleware");
const { checkOwnership } = require("../middleware/checkOwnership");

const router = express.Router();

// POST - Buat deskripsi desa baru
router.post("/deskripsi-desa", authenticateToken, checkRole("pengelola"), uploadFields, handleUploadErrors, checkOwnership, addDeskripsiDesa);

// GET - Ambil deskripsi desa berdasarkan kd_desa
router.get("/deskripsi-desa/:kd_desa", getDeskripsiDesaByKdDesa);

// PUT - Update deskripsi desa
router.put("/deskripsi-desa/:kd_desa", authenticateToken, checkRole("pengelola"), checkOwnership, uploadFields, handleUploadErrors, updateDeskripsiDesa);

// DELETE - Hapus deskripsi desa
router.delete("/deskripsi-desa/:kd_desa", authenticateToken, checkRole("pengelola"), checkOwnership, deleteDeskripsiDesa);

module.exports = router;
